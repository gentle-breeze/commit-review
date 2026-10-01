import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-api-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'test@example.invalid');
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
  assert.equal(history.commits[0].sha, sha);
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
