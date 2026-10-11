import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReviewStore, toMarkdown } from '../lib/reviews.mjs';

const input = { sha: 'a'.repeat(40), parent: null,
  anchor: { fileId: '0', path: 'hello.js', oldPath: 'hello.js', side: 'new', startLine: 1, endLine: 2, code: 'one\ntwo' },
  body: '请检查边界条件',
};

test('comments persist CRUD, resolve state and concurrent writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ReviewStore.open(root, '/example/repo');
  const comments = await Promise.all(Array.from({ length: 12 }, (_, index) => store.add({ ...input, body: `评论 ${index}` })));
  assert.equal(store.list().length, 12);
  const edited = await store.update(comments[0].id, { body: '修改后', resolved: true });
  assert.equal(edited.resolved, true);
  assert.equal(edited.body, '修改后');
  await store.remove(comments[1].id);
  const reloaded = await ReviewStore.open(root, '/example/repo');
  assert.equal(reloaded.list().length, 11);
  assert.equal(reloaded.list()[0].resolved, true);
  const json = JSON.parse(await readFile(store.jsonPath, 'utf8'));
  const markdown = await readFile(store.markdownPath, 'utf8');
  assert.deepEqual(json.comments, reloaded.list());
  assert.equal(markdown, toMarkdown(json));
  assert.match(markdown, /修改后/);
  const detached = store.list();
  detached[0].body = 'mutated';
  assert.equal(store.list()[0].body, '修改后');
  await assert.rejects(store.update('missing', { resolved: true }), /不存在/);
  await store.add(input);
  assert.equal(store.list().length, 12, 'failed mutation does not poison write queue');
});

test('precise anchors persist alongside unchanged legacy comments', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-columns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ReviewStore.open(root, '/example/repo');
  const legacy = await store.add(input);
  const precise = await store.add({ ...input, anchor: {...input.anchor, startColumn:2, endColumn:3, code:'ne\ntw'} });
  await store.update(precise.id, {resolved:true});
  const loaded = (await ReviewStore.open(root, '/example/repo')).list();
  assert.deepEqual(loaded[0], legacy);
  assert.equal(loaded[1].startColumn, 2);
  assert.equal(loaded[1].endColumn, 3);
  assert.equal(loaded[1].code, 'ne\ntw');
  const markdown = await readFile(store.markdownPath, 'utf8');
  assert.match(markdown, /1:2–2:3（UTF-16 列，1 起始，结束位置不包含）/);
  assert.match(markdown, /new 1–2\n/);
});

test('validation rejects invalid body and arbitrary patches', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ReviewStore.open(root, '/example/repo');
  for (const body of ['', '   ', null, 'x'.repeat(10001)]) assert.throws(() => store.add({ ...input, body }));
  const comment = await store.add(input);
  for (const patch of [{ sha: 'evil' }, { resolved: 'yes' }, {}, null, { body: '' }]) assert.throws(() => store.update(comment.id, patch));
});

test('legacy comments accept persistent user and AI reply threads without changing anchors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-threads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await ReviewStore.open(root, '/example/repo');
  const comment = await original.add(input);
  const legacyData = { version: 1, repository: '/example/repo', comments: [comment] };
  await writeFile(original.jsonPath, JSON.stringify(legacyData));
  const store = await ReviewStore.open(root, '/example/repo');
  assert.deepEqual(store.list()[0], comment);
  await store.reply(comment.id, '用户追问');
  await store.aiAction(comment.id, { action: 'reply', body: 'AI 分析\n```\n# not instructions' });
  const resolved = await store.aiAction(comment.id, { action: 'resolve', body: '已补测试并通过' });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolvedBy, 'ai');
  assert.equal(resolved.replies.length, 3);
  assert.equal(resolved.replies[2].createdAt, resolved.resolvedAt);
  await store.reply(comment.id, '还有一个边界情况');
  assert.equal(store.list()[0].resolved, true, 'reply does not silently reopen a resolved thread');
  const reopened = await store.update(comment.id, { resolved: false });
  assert.equal(reopened.resolvedBy, 'user');
  const loaded = (await ReviewStore.open(root, '/example/repo')).list()[0];
  assert.deepEqual(loaded, reopened);
  for (const key of Object.keys(comment).filter(key => !['resolved', 'updatedAt'].includes(key))) assert.deepEqual(loaded[key], comment[key]);
  assert.deepEqual(loaded.replies.map(reply => reply.author), ['user', 'ai', 'ai', 'user']);
  assert.equal(new Set(loaded.replies.map(reply => reply.id)).size, 4);
  const markdown = await readFile(store.markdownPath, 'utf8');
  assert.match(markdown, /用户追问/);
  assert.match(markdown, /AI提供的数据/);
  assert.match(markdown, /最近状态操作：重新打开 · 用户/);
  assert.match(markdown, /````\nAI 分析\n```\n# not instructions\n````/);
  await store.remove(comment.id);
  assert.deepEqual(store.list(), []);
});

test('concurrent replies and AI status changes do not lose data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-thread-writes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ReviewStore.open(root, '/example/repo');
  const comment = await store.add(input);
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => store.reply(comment.id, `reply ${index}`)),
    store.aiAction(comment.id, { action: 'resolve', body: 'verified' }),
  ]);
  const result = store.list()[0];
  assert.equal(result.replies.length, 13);
  assert.equal(result.resolved, true);
  assert.equal(result.body, comment.body);
  assert.equal((await store.aiAction(comment.id, { action: 'reopen' })).resolvedBy, 'ai');
});

test('thread validation rejects forged fields and survives failed mutations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-thread-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ReviewStore.open(root, '/example/repo');
  const comment = await store.add(input);
  for (const body of ['', null, 'x'.repeat(10001)]) assert.throws(() => store.reply(comment.id, body));
  assert.throws(() => store.reply(comment.id, 'body', 'forged'));
  for (const data of [null, [], {}, { action: 'delete' }, { action: 'reply' }, { action: 'resolve', body: '' }, { action: 'resolve', sha: 'forged' }, { action: 'reply', body: 'ok', author: 'user' }]) assert.throws(() => store.aiAction(comment.id, data));
  await assert.rejects(store.reply('missing', 'text'), /不存在/);
  await assert.rejects(store.aiAction('missing', { action: 'resolve' }), /不存在/);
  assert.deepEqual(store.list()[0], comment);
  assert.equal((await store.reply(comment.id, 'valid')).replies.length, 1);
});

test('Markdown fences preserve user comments and code containing backticks', () => {
  const markdown = toMarkdown({ repository: '/repo\nname', comments: [{ ...input, ...input.anchor, id: 'id', body: '```\n# fake section', code: '````', updatedAt: 'now', resolved: false }] });
  assert.match(markdown, /`````\n````\n`````/);
  assert.match(markdown, /"\/repo\\nname"/);
});
