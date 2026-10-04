import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

test('Markdown fences preserve user comments and code containing backticks', () => {
  const markdown = toMarkdown({ repository: '/repo\nname', comments: [{ ...input, ...input.anchor, id: 'id', body: '```\n# fake section', code: '````', updatedAt: 'now', resolved: false }] });
  assert.match(markdown, /`````\n````\n`````/);
  assert.match(markdown, /"\/repo\\nname"/);
});
