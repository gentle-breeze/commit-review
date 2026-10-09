import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access, mkdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-api-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'hello.js'), 'first\nsecond\nthird\n');
  git('add', '.'); git('commit', '-m', 'Initial commit');
  const sha = git('rev-parse', 'HEAD');
  const dataDir = path.join(root, 'review-data');
  const app = await createApp({ repoPath: root, dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const info = await (await fetch(`${base}/api/info`)).json();
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.release();
    await rm(root, { recursive: true, force: true });
  });
  const request = (route, method = 'GET', body, headers = {}) => fetch(base + route, { method, headers: {
    'X-Review-Token': info.token,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { root, sha, app, base, info, request, dataDir, git };
}

test('HTTP review workflow and exported AI context', async t => {
  const { sha, info, request, git } = await fixture(t);
  const before = git('rev-parse', 'HEAD');
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Commit Review/);
  assert.equal((await request('/app.js')).status, 200);
  const history = await (await request('/api/commits?limit=1')).json();
  assert.deepEqual(history.commits, []);
  assert.equal(history.comparisonMode, 'local-base');
  const diff = await (await request(`/api/diff?sha=${sha}`)).json();
  const versions = await (await request(`/api/file?sha=${sha}&fileId=${diff.files[0].id}`)).json();
  assert.equal(versions.new.text, 'first\nsecond\nthird\n');
  assert.equal(versions.old.exists, false);
  assert.equal((await request(`/api/file?sha=${sha}&fileId=../secret`)).status, 400);
  assert.equal((await request('/assets/../../package.json')).status, 404);
  const anchor = { fileId: diff.files[0].id, side: 'new', startLine: 1, endLine: 2 };
  const response = await request('/api/comments', 'POST', { sha, anchor, body: '检查这两行' });
  assert.equal(response.status, 201);
  const comment = await response.json();
  assert.equal(comment.code, 'first\nsecond');
  assert.equal(comment.path, 'hello.js');
  assert.equal(comment.sha, sha);
  const updated = await (await request(`/api/comments/${comment.id}`, 'PATCH', { body: '已确认', resolved: true })).json();
  assert.equal(updated.resolved, true);
  assert.equal((await (await request('/api/comments')).json()).length, 1);
  assert.match(await readFile(info.markdownPath, 'utf8'), /已解决/);
  assert.equal((await request(`/api/comments/${comment.id}`, 'DELETE')).status, 200);
  assert.equal((await (await request('/api/comments')).json()).length, 0);
  const preciseResponse = await request('/api/comments', 'POST', {sha, anchor:{...anchor,startColumn:3,endColumn:4,code:'forged'},body:'精确选区'});
  assert.equal(preciseResponse.status, 201);
  const precise = await preciseResponse.json();
  assert.equal(precise.code, 'rst\nsec');
  assert.equal(precise.startColumn, 3);
  assert.equal(precise.endColumn, 4);
  for (const columns of [{startColumn:1}, {startColumn:0,endColumn:2}, {startColumn:1,endColumn:99}]) {
    assert.equal((await request('/api/comments', 'POST', {sha,anchor:{...anchor,...columns},body:'bad'})).status,400);
  }
  assert.equal(git('rev-parse', 'HEAD'), before);
});

test('HTTP rejects cross-site requests, forged anchors and traversal', async t => {
  const { sha, base, request } = await fixture(t);
  assert.equal((await fetch(`${base}/api/comments`)).status, 403);
  assert.equal((await fetch(`${base}/api/info`, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/info`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await request('/api/info', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const route of ['/api/diff?sha=--help', '/api/commits?ref=--all', '/api/commits?offset=-1', '/api/commits?limit=1000']) assert.equal((await request(route)).status, 400, route);
  assert.equal((await request('/%2e%2e/package.json')).status, 404);
  const diff = await (await request(`/api/diff?sha=${sha}`)).json();
  for (const anchor of [
    { fileId: diff.files[0].id, side: 'new', startLine: 1, endLine: 9999 },
    { fileId: diff.files[0].id, side: 'old', startLine: 1, endLine: 1 },
    { fileId: '../secret', side: 'new', startLine: 1, endLine: 1 },
  ]) assert.equal((await request('/api/comments', 'POST', { sha, anchor, body: 'bad' })).status, 400);
  assert.equal((await request('/api/comments', 'POST', { body: 'x'.repeat(70000) })).status, 400);
  assert.equal((await request('/api/comments', 'POST', null)).status, 400);
});

test('one writer per repository/data directory', async t => {
  const { root, dataDir } = await fixture(t);
  await assert.rejects(createApp({ repoPath: root, dataDir }), /已被占用/);
});

async function pickerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-picker-'));
  const dataDir = path.join(root, 'data');
  const app = await createApp({ dataDir, projectsDir: root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const info = await (await fetch(`${base}/api/info`)).json();
  const request = (route, method = 'GET', body, headers = {}) => fetch(base + route, { method, headers: {
    'X-Review-Token': info.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const repository = async name => {
    const target = path.join(root, name);
    await mkdir(target);
    execFileSync('git', ['-C', target, 'init', '-b', 'main'], { stdio: 'pipe' });
    return target;
  };
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.release();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, app, base, info, request, repository };
}

test('optional repository starts idle, validates selection and preserves the selected project', async t => {
  const { root, dataDir, app, base, info, request, repository } = await pickerFixture(t);
  assert.equal(info.repository, null);
  assert.equal(info.jsonPath, null);
  assert.equal(info.markdownPath, null);
  assert.equal(typeof info.token, 'string');
  assert.equal(app.repo, undefined);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  assert.equal((await request('/')).status, 200);
  for (const route of ['/api/branches', '/api/commits', '/api/diff', '/api/file', '/api/comments']) {
    const response = await request(route);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /请先选择/);
  }
  assert.equal((await fetch(`${base}/api/repository`, { method: 'POST' })).status, 403);
  assert.equal((await request('/api/repository', 'POST', { repository: root }, { Origin: 'https://evil.invalid' })).status, 403);
  for (const body of [null, {}, { repository: 123 }, { repository: ' ' }, { repository: path.join(root, 'missing') }, { repository: root }]) {
    assert.equal((await request('/api/repository', 'POST', body)).status, 400);
    assert.equal((await (await request('/api/info')).json()).repository, null);
  }
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  assert.equal((await fetch(`${base}/api/repositories`)).status, 403);
  assert.equal((await request('/api/repositories', 'GET', undefined, { Origin: 'https://evil.invalid' })).status, 403);
  assert.deepEqual((await (await request('/api/repositories')).json()).projects, []);
  const target = await repository('项目 with spaces');
  const listing = await (await request('/api/repositories')).json();
  assert.equal(listing.directory, await realpath(root));
  assert.deepEqual(listing.projects, [{ name: '项目 with spaces', path: await realpath(target) }]);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  const response = await request('/api/repository', 'POST', { repository: target });
  assert.equal(response.status, 200);
  const selected = await response.json();
  assert.equal(selected.repository, await realpath(target));
  assert.equal(selected.token, info.token);
  assert.equal(app.repo.path, selected.repository);
  assert.equal(app.store.jsonPath, selected.jsonPath);
  assert.deepEqual(await (await request('/api/info')).json(), selected);
  assert.deepEqual(await (await request('/api/comments')).json(), []);
  assert.equal((await request('/api/branches')).status, 200);
  assert.equal((await request('/api/commits')).status, 200);
  assert.equal((await request('/api/repository', 'POST', { repository: path.join(target, '.') })).status, 200);
  const other = await repository('other');
  const rejected = await request('/api/repository', 'POST', { repository: other });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /重启服务/);
  assert.deepEqual(await (await request('/api/info')).json(), selected);
  await assert.rejects(createApp({ repoPath: target, dataDir }), /已被占用/);
  await app.release();
  const reopened = await createApp({ repoPath: target, dataDir });
  try {
    await app.release();
    await assert.rejects(createApp({ repoPath: target, dataDir }), /已被占用/);
  } finally { await reopened.release(); }
});

test('repository selection serializes concurrent requests and retries after a lock failure', async t => {
  const { dataDir, request, repository } = await pickerFixture(t);
  const target = await repository('target');
  const owner = await createApp({ repoPath: target, dataDir });
  try {
    const blocked = await request('/api/repository', 'POST', { repository: target });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /已被占用/);
  } finally { await owner.release(); }
  const responses = await Promise.all(Array.from({ length: 3 }, () => request('/api/repository', 'POST', { repository: target })));
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  const other = await repository('other');
  assert.equal((await request('/api/repository', 'POST', { repository: other })).status, 400);
});

test('concurrent different project selections bind exactly one repository', async t => {
  const { dataDir, app, request, repository } = await pickerFixture(t);
  const targets = await Promise.all(['first', 'second'].map(repository));
  const responses = await Promise.all(targets.map(target => request('/api/repository', 'POST', { repository: target })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  const unselected = targets.find(target => path.basename(app.repo.path) !== path.basename(target));
  const other = await createApp({ repoPath: unselected, dataDir });
  await other.release();
});
