import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rename, mkdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GitRepo, validateAnchor } from '../lib/git.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', '测试作者'); git('config', 'user.email', 'test@example.invalid');
  const put = (name, data) => writeFile(path.join(directory, name), data);
  const commit = message => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  return { directory, git, put, commit, repo: await GitRepo.open(directory) };
}

test('empty history, root diff, pagination and strict ref validation', async t => {
  const { repo, put, commit } = await fixture(t);
  assert.deepEqual(await repo.commits(), { commits: [], hasMore: false });
  await assert.rejects(repo.commits('--all'), /无效/);
  await put('first.js', 'first\nsecond\n');
  const first = commit('初始提交');
  const root = await repo.diff(first);
  assert.equal(root.parent, null);
  assert.equal(root.subject, '初始提交');
  assert.equal(root.files[0].additions, 2);
  assert.equal(validateAnchor(root, { fileId: '0', side: 'new', startLine: 1, endLine: 2 }).code, 'first\nsecond');
  assert.throws(() => validateAnchor(root, { fileId: '0', side: 'old', startLine: 1, endLine: 1 }));
  await put('first.js', 'changed\nsecond\n');
  const second = commit('修改');
  const page = await repo.commits('main', 0, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.commits[0].sha, second);
  assert.deepEqual(page.commits[0].parents, [first]);
  assert.equal((await repo.commits('main', 1, 1)).commits[0].sha, first);
  assert.equal((await repo.branches()).find(branch => branch.name === 'refs/heads/main').current, true);
  const diff = await repo.diff(second);
  assert.equal(validateAnchor(diff, { fileId: '0', side: 'old', startLine: 1, endLine: 1 }).code, 'first');
  assert.equal(validateAnchor(diff, { fileId: '0', side: 'new', startLine: 1, endLine: 1 }).code, 'changed');
  await assert.rejects(repo.diff('HEAD'), /完整/);
  await assert.rejects(repo.commits('missing'), /找不到/);
});

test('rename, deletion, binary, mode-only and unusual paths', async t => {
  const { directory, repo, put, commit } = await fixture(t);
  const strange = '空 格\t换\n行 "quote".txt';
  await put(strange, 'keep this content\n');
  await put('delete.txt', 'delete me\n');
  await put('mode.sh', '#!/bin/sh\nexit 0\n');
  await put('binary.bin', Buffer.from([0, 1, 2]));
  commit('root');
  await rename(path.join(directory, strange), path.join(directory, 'renamed 空.txt'));
  await rm(path.join(directory, 'delete.txt'));
  await put('binary.bin', Buffer.from([0, 3, 4]));
  await chmod(path.join(directory, 'mode.sh'), 0o755);
  const diff = await repo.diff(commit('rename delete binary mode'));
  const renamed = diff.files.find(file => file.path === 'renamed 空.txt');
  assert.match(renamed.status, /^R/);
  assert.equal(renamed.oldPath, strange);
  const versions = await repo.file(diff, renamed.id);
  assert.equal(versions.old.text, 'keep this content\n');
  assert.equal(versions.new.text, versions.old.text);
  const deleted = diff.files.find(file => file.path === 'delete.txt');
  assert.equal(validateAnchor(diff, { fileId: deleted.id, side: 'old', startLine: 1, endLine: 1 }).code, 'delete me');
  const deletedVersions = await repo.file(diff, deleted.id);
  assert.equal(deletedVersions.old.text, 'delete me\n');
  assert.equal(deletedVersions.new.exists, false);
  const binary = diff.files.find(file => file.path === 'binary.bin');
  assert.equal(binary.binary, true);
  assert.match((await repo.file(diff, binary.id)).unavailable, /二进制/);
  assert.equal(diff.files.find(file => file.path === 'mode.sh').hunks.length, 0);
});

test('merge compares first parent and linked worktrees open correctly', async t => {
  const { directory, git, put, commit, repo } = await fixture(t);
  await put('base', 'base\n'); commit('base');
  git('checkout', '-b', 'feature');
  await put('feature', 'feature\n'); commit('feature');
  git('checkout', 'main');
  await put('main', 'main\n'); const parent = commit('main');
  git('merge', '--no-ff', 'feature', '-m', 'merge feature');
  const diff = await repo.diff(git('rev-parse', 'HEAD'));
  assert.equal(diff.parent, parent);
  assert.equal(diff.parents.length, 2);
  assert.deepEqual(diff.files.map(file => file.path), ['feature']);
  const linked = path.join(directory, 'linked');
  git('worktree', 'add', '--detach', linked);
  const linkedRepo = await GitRepo.open(linked);
  assert.equal((await linkedRepo.commits()).commits[0].sha, diff.sha);
});

test('separate hunks, no newline and literal pathspec-like filenames', async t => {
  const { repo, put, commit, directory } = await fixture(t);
  await mkdir(path.join(directory, 'sub'));
  const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  await put('sub/:special[1].txt', original.join('\n')); commit('root');
  const changed = [...original]; changed[0] = 'first changed'; changed[39] = 'last changed';
  await put('sub/:special[1].txt', changed.join('\n'));
  const diff = await repo.diff(commit('two hunks'));
  assert.equal(diff.files[0].hunks.length, 2);
  assert.equal(diff.files[0].hunks[1].lines.at(-1).type, 'meta');
  assert.throws(() => validateAnchor(diff, { fileId: '0', side: 'new', startLine: 1, endLine: 40 }));
  assert.equal(validateAnchor(diff, { fileId: '0', side: 'new', startLine: 40, endLine: 40 }).code, 'last changed');
  const versions = await repo.file(diff, '0');
  assert.equal(versions.old.text, original.join('\n'));
  assert.equal(versions.new.text, changed.join('\n'));
  assert.equal(validateAnchor(diff, { fileId: '0', side: 'new', startLine: 20, endLine: 21 }, versions).code, 'line 20\nline 21');
  assert.throws(() => validateAnchor(diff, { fileId: '0', side: 'new', startLine: 41, endLine: 41 }, versions));
});

test('full versions are historical, bounded, and reject unsupported objects', async t => {
  const { repo, put, commit, git } = await fixture(t);
  await put('empty.txt', '');
  await put('invalid.txt', Buffer.from([0xff, 0xfe, 0x61]));
  await put('big.txt', 'a'.repeat(2 * 1024 * 1024 + 1));
  await put('lines.txt', 'a\n'.repeat(20001));
  await put('source.js', 'historical\n');
  const sha = commit('limits');
  await put('source.js', 'uncommitted data\n');
  const diff = await repo.diff(sha);
  const load = name => repo.file(diff, diff.files.find(file => file.path === name).id);
  assert.equal((await load('source.js')).new.text, 'historical\n');
  assert.equal((await load('source.js')).old.exists, false);
  assert.equal((await load('empty.txt')).new.lineCount, 0);
  assert.match((await load('invalid.txt')).unavailable, /UTF-8/);
  assert.match((await load('big.txt')).unavailable, /2 MiB/);
  assert.match((await load('lines.txt')).unavailable, /20000/);
  await assert.rejects(repo.file(diff, '../secret'), /无法定位/);
  git('update-index', '--add', '--cacheinfo', `160000,${sha},submodule`);
  git('commit', '-m', 'submodule');
  const subDiff = await repo.diff(git('rev-parse', 'HEAD'));
  assert.match((await repo.file(subDiff, subDiff.files.find(file => file.path === 'submodule').id)).unavailable, /子模块/);
});

test('large files explicitly truncate and reject hidden-line anchors', async t => {
  const { repo, put, commit } = await fixture(t);
  await put('large.txt', Array.from({ length: 6200 }, (_, i) => `line ${i}`).join('\n'));
  const diff = await repo.diff(commit('large'));
  assert.equal(diff.truncated, true);
  assert.equal(diff.files[0].truncated, true);
  assert.equal(diff.files[0].additions, 6200);
  assert.throws(() => validateAnchor(diff, { fileId: '0', side: 'new', startLine: 6100, endLine: 6100 }));
});
