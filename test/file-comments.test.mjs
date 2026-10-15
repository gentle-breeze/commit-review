import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRepo, validateAnchor } from '../lib/git.mjs';
import { ReviewStore, toMarkdown } from '../lib/reviews.mjs';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-file-comments-'));
  const directory = path.join(root, 'repo');
  await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding:'utf8', stdio:'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'File Reviewer');
  git('config', 'user.email', 'test@example.invalid');
  const put = (name, content) => writeFile(path.join(directory, name), content);
  const commit = subject => { git('add', '-A'); git('commit', '-m', subject); return git('rev-parse', 'HEAD'); };
  return { root, directory, git, put, commit, repo:await GitRepo.open(directory) };
}

test('file anchors derive historical paths for empty, binary, large, renamed and deleted files', async t => {
  const f = await fixture(t);
  await f.put('empty.txt', '');
  await f.put('binary.bin', Buffer.from([0, 1, 2]));
  await f.put('large.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
  await f.put('old.txt', 'historical text\n');
  await f.put('deleted.txt', 'deleted evidence\n');
  const original = await f.repo.diff(f.commit('Original files'));
  for (const file of original.files) {
    const anchor = validateAnchor(original, {kind:'file', fileId:file.id}, {unavailable:'No text available'});
    assert.deepEqual(anchor, {kind:'file',fileId:file.id,path:file.path,oldPath:file.oldPath,status:'A',side:'new',code:''});
    assert.equal('startLine' in anchor, false);
    assert.equal('startColumn' in anchor, false);
  }
  for (const name of ['binary.bin', 'large.txt']) {
    const file = original.files.find(item => item.path === name);
    assert.ok((await f.repo.file(original, file.id)).unavailable);
    assert.equal(validateAnchor(original, {kind:'file', fileId:file.id}).path, name);
  }
  await rename(path.join(f.directory, 'old.txt'), path.join(f.directory, 'new.txt'));
  await rm(path.join(f.directory, 'deleted.txt'));
  const changed = await f.repo.diff(f.commit('Rename and deletion'));
  const renamed = changed.files.find(file => file.path === 'new.txt');
  const removed = changed.files.find(file => file.path === 'deleted.txt');
  assert.match(renamed.status, /^R/);
  assert.deepEqual(validateAnchor(changed, {kind:'file',fileId:renamed.id}), {
    kind:'file',fileId:renamed.id,path:'new.txt',oldPath:'old.txt',status:renamed.status,side:'new',code:'',
  });
  assert.deepEqual(validateAnchor(changed, {kind:'file',fileId:removed.id}), {
    kind:'file',fileId:removed.id,path:'deleted.txt',oldPath:'deleted.txt',status:'D',side:'old',code:'',
  });
});

test('file anchors reject spoofed paths and line fields while legacy and explicit line anchors remain valid', async t => {
  const f = await fixture(t);
  await f.put('actual.txt', 'first\nsecond\n');
  const diff = await f.repo.diff(f.commit('Text'));
  const file = {kind:'file',fileId:'0'};
  for (const patch of [
    {path:'forged.txt'}, {oldPath:'forged.txt'}, {status:'D'}, {side:'old'}, {code:'forged'},
    {startLine:1}, {endLine:1}, {startColumn:1}, {endColumn:2}, {fileId:'missing'}, {fileId:0},
  ]) assert.throws(() => validateAnchor(diff, {...file,...patch}));
  for (const anchor of [null, [], 'file', {kind:'unknown',fileId:'0'}, {kind:null,fileId:'0'}]) {
    assert.throws(() => validateAnchor(diff, anchor));
  }
  const input = {fileId:'0',side:'new',startLine:1,endLine:2};
  const legacy = validateAnchor(diff, input);
  assert.equal('kind' in legacy, false);
  assert.equal(legacy.code, 'first\nsecond');
  assert.deepEqual(validateAnchor(diff, {...input,kind:'line'}), {...legacy,kind:'line'});
  const versions = await f.repo.file(diff, '0');
  const precise = validateAnchor(diff, {...input,kind:'line',startColumn:2,endColumn:3}, versions);
  assert.equal(precise.code, 'irst\nse');
  assert.equal(precise.kind, 'line');
});

test('file comments share replies, resolution and association history without changing legacy comments or path evidence', async t => {
  const f = await fixture(t);
  await f.put('old.txt', 'historical\n');
  f.commit('Original');
  await rename(path.join(f.directory, 'old.txt'), path.join(f.directory, 'new.txt'));
  const diff = await f.repo.diff(f.commit('Rename'));
  const store = await ReviewStore.open(path.join(f.root, 'data'), f.directory);
  const lineAnchor = {fileId:'0',path:'old.txt',oldPath:'old.txt',side:'new',startLine:1,endLine:1,code:'historical'};
  const legacy = await store.add({sha:diff.parent,parent:null,anchor:lineAnchor,body:'Old line comment'});
  const anchor = validateAnchor(diff, {kind:'file',fileId:'0'});
  let comment = await store.add({sha:diff.sha,parent:diff.parent,anchor,body:'整个文件的问题'});
  await store.reply(comment.id, '人工回复');
  comment = await store.aiAction(comment.id, {action:'reply',body:'AI 核查'});
  const reply = comment.replies[0];
  await store.mutateReply(comment.id, reply.id, {action:'edit',body:'人工修订',revision:0,requestId:randomUUID()});
  await store.mutateReply(comment.id, reply.id, {action:'delete',revision:1,requestId:randomUUID()});
  await store.mutateReply(comment.id, reply.id, {action:'restore',revision:2,requestId:randomUUID()});
  await store.update(comment.id, {resolved:true});
  const targets = [
    {kind:'commit',sha:'a'.repeat(40),subject:'First fix'},
    {kind:'commit',sha:'b'.repeat(40),subject:'Second fix'},
  ];
  await store.replaceAssociations(comment.id, {requestId:randomUUID(),revision:0,targets,source:'ai',scope:'fixed-scope',evidence:'Both changes relate to this file'});
  comment = await store.replaceAssociations(comment.id, {requestId:randomUUID(),revision:1,targets:targets.slice(1),source:'user',scope:'fixed-scope'});
  assert.equal(comment.resolved, true, 'association changes do not reset resolution');
  assert.equal(comment.followups.length, 2);
  assert.ok(comment.followups[0].removedAt);
  assert.equal(comment.followups[0].evidence, 'Both changes relate to this file');
  assert.equal(comment.followups[1].removedAt, undefined);
  assert.equal(comment.replies[0].body, '人工修订');
  assert.equal(comment.replies[0].history.length, 3);
  for (const [key, value] of Object.entries(anchor)) assert.equal(comment[key], value);
  const reloaded = (await ReviewStore.open(path.join(f.root, 'data'), f.directory)).list();
  assert.deepEqual(reloaded, [legacy,comment]);
  const markdown = toMarkdown({repository:f.directory,comments:[comment]});
  assert.match(markdown, /整个文件（新版本 \/ new；无行号）/);
  assert.match(markdown, /文件（JSON 编码）: "new.txt"/);
  assert.match(markdown, /旧路径（JSON 编码）: "old.txt"/);
  assert.match(markdown, /已移除，仅保留记录/);
  assert.doesNotMatch(markdown, /undefined|NaN|### 代码片段/);
  assert.match(await readFile(store.markdownPath, 'utf8'), /new 1–1/);
});

test('legacy target preview gives file-level path guidance without loading text or inventing line candidates', async t => {
  const f = await fixture(t);
  await f.put('old.bin', Buffer.from([0, 1, 2]));
  const diff = await f.repo.diff(f.commit('Original binary'));
  const comment = {...validateAnchor(diff,{kind:'file',fileId:'0'}),sha:diff.sha,parent:diff.parent};
  await rename(path.join(f.directory, 'old.bin'), path.join(f.directory, 'new.bin'));
  f.commit('Rename binary');
  f.repo.file = () => { throw new Error('File comments must not load text'); };
  const target = await f.repo.commentTarget(comment, 'HEAD');
  assert.equal(target.path, 'new.bin');
  assert.equal(target.kind, 'file');
  assert.match(target.unavailable, /文件级评论不支持行定位/);
  assert.deepEqual(target.candidates, []);
  assert.equal('text' in target, false);
  assert.equal('lineCount' in target, false);
  assert.equal((await f.repo.commentTarget(comment, 'HEAD', 'missing.bin')).path, 'missing.bin');
  await assert.rejects(f.repo.commentTarget(comment, 'HEAD', '../outside'), /路径无效/);
});

test('HTTP file comments use fixed review scopes and persist beside legacy line comments through reload', async t => {
  const f = await fixture(t);
  await f.put('binary.bin', Buffer.from([0, 1, 2]));
  await f.put('empty.txt', '');
  await f.put('large.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
  await f.put('old.txt', 'rename evidence\n');
  await f.put('deleted.txt', 'deletion evidence\n');
  await f.put('line.txt', 'first\nsecond\n');
  const original = f.commit('Original files');
  f.git('checkout', '-b', 'feature');
  await rename(path.join(f.directory, 'old.txt'), path.join(f.directory, 'new.txt'));
  await rm(path.join(f.directory, 'deleted.txt'));
  const changed = f.commit('Rename and deletion');
  const dataDir = path.join(f.root, 'http-data');
  const start = async () => {
    const app = await createApp({repoPath:f.directory, dataDir});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const info = await (await fetch(base + '/api/info')).json();
    let closed = false;
    const stop = async () => {
      if (closed) return;
      closed = true;
      await new Promise(resolve => app.server.close(resolve));
      await app.release();
    };
    t.after(stop);
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(base + route, {method, headers:{
        'X-Review-Token':info.token, 'X-Review-Project':info.projectId,
        ...(body !== undefined ? {'Content-Type':'application/json'} : {}),
      }, ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
      return {status:response.status, data:await response.json()};
    };
    return {request, stop, info};
  };
  const server = await start();
  const {request} = server;
  const originalDiff = (await request(`/api/diff?sha=${original}`)).data;
  const changedDiff = (await request(`/api/diff?sha=${changed}`)).data;
  const created = [];
  for (const [diff, name] of [
    [originalDiff,'binary.bin'], [originalDiff,'empty.txt'], [originalDiff,'large.txt'],
    [changedDiff,'new.txt'], [changedDiff,'deleted.txt'],
  ]) {
    const file = diff.files.find(item => item.path === name);
    const result = await request('/api/comments', 'POST', {sha:diff.sha,anchor:{kind:'file',fileId:file.id},body:`File review: ${name}`});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const comment = result.data;
    assert.equal(comment.sha, diff.sha);
    assert.equal(comment.parent, diff.parent);
    assert.deepEqual(Object.fromEntries(['kind','fileId','path','oldPath','status','side','code'].map(key => [key,comment[key]])), {
      kind:'file',fileId:file.id,path:file.path,oldPath:file.oldPath,status:file.status,
      side:file.status.startsWith('D') ? 'old' : 'new',code:'',
    });
    for (const key of ['startLine','endLine','startColumn','endColumn']) assert.equal(key in comment, false);
    created.push(comment);
  }
  const binary = originalDiff.files.find(file => file.path === 'binary.bin');
  for (const patch of [{path:'forged.txt'},{oldPath:'forged.txt'},{startLine:1,endLine:1},{startColumn:1},{kind:'unknown'},{kind:null}]) {
    const result = await request('/api/comments', 'POST', {sha:original,anchor:{kind:'file',fileId:binary.id,...patch},body:'Invalid anchor'});
    assert.equal(result.status, 400, JSON.stringify(patch));
  }
  const line = originalDiff.files.find(file => file.path === 'line.txt');
  const legacyResult = await request('/api/comments', 'POST', {sha:original,anchor:{fileId:line.id,side:'new',startLine:1,endLine:2},body:'Legacy line review'});
  assert.equal(legacyResult.status, 201);
  const legacy = legacyResult.data;
  assert.equal('kind' in legacy, false);
  assert.equal(legacy.code, 'first\nsecond');
  const fileComment = created.find(comment => comment.path === 'new.txt');
  const route = `/api/comments/${fileComment.id}`;
  assert.equal((await request(route + '/replies', 'POST', {body:'用户回复整个文件'})).status, 201);
  assert.equal((await request(route + '/ai', 'POST', {action:'reply',body:'AI 核查整个文件'})).status, 200);
  assert.equal((await request(route, 'PATCH', {resolved:true})).status, 200);
  const scopeResponse = await request('/api/review-scope?mode=history&ref=refs/heads/feature');
  assert.equal(scopeResponse.status, 200);
  const scope = scopeResponse.data;
  assert.equal(scope.head, changed);
  const initialCandidates = await request(`/api/association-scope?id=${scope.id}`);
  assert.equal(initialCandidates.status, 200);
  assert.deepEqual(initialCandidates.data.commits.map(commit => commit.sha), [changed,original]);
  await f.put('later.txt', 'outside the original range\n');
  const later = f.commit('New commit after scope creation');
  const fixedCandidates = await request(`/api/association-scope?id=${scope.id}`);
  assert.deepEqual(fixedCandidates.data.commits.map(commit => commit.sha), [changed,original]);
  const selected = await request(route + '/associations/ai', 'POST', {
    scope:scope.id,shas:[original,changed],revision:0,requestId:randomUUID(),evidence:'两条提交共同涉及该文件问题',
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  assert.equal(selected.data.followups.length, 2);
  assert.equal(selected.data.resolved, true);
  const outside = await request(route + '/associations', 'POST', {scope:scope.id,shas:[later],revision:1,requestId:randomUUID()});
  assert.equal(outside.status, 400);
  const replaced = await request(route + '/associations', 'POST', {scope:scope.id,shas:[changed],revision:1,requestId:randomUUID()});
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.followups.length, 2);
  assert.ok(replaced.data.followups.find(link => link.sha === original).removedAt);
  assert.equal(replaced.data.followups.find(link => link.sha === changed).removedAt, undefined);
  assert.equal(replaced.data.resolved, true);
  assert.deepEqual(replaced.data.replies.map(reply => reply.author), ['user','ai']);
  assert.equal(replaced.data.path, 'new.txt');
  assert.equal(replaced.data.oldPath, 'old.txt');
  assert.equal('startLine' in replaced.data, false);
  const refreshed = (await request('/api/review-scope?mode=history&ref=refs/heads/feature')).data;
  assert.equal(refreshed.head, later);
  const beforeReload = (await request('/api/comments')).data;
  assert.equal(beforeReload.length, 6);
  assert.deepEqual(beforeReload.find(comment => comment.id === legacy.id), legacy);
  await server.stop();
  const reopened = await start();
  assert.deepEqual((await reopened.request('/api/comments')).data, beforeReload);
  const markdown = await readFile(reopened.info.markdownPath, 'utf8');
  assert.match(markdown, /整个文件（旧版本 \/ old；无行号）/);
  assert.match(markdown, /旧路径（JSON 编码）: "old.txt"/);
  assert.match(markdown, /new 1–2/);
  assert.doesNotMatch(markdown, /undefined|NaN/);
  await reopened.stop();
});
