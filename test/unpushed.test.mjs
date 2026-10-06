import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitRepo } from '../lib/git.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-unpushed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'work');
  await mkdir(directory);
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'test@example.invalid');
  const commit = async name => {
    await writeFile(path.join(directory, name), name);
    git('add', '.'); git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const base = await commit('base');
  git('init', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-u', 'origin', 'main');
  return { git, commit, base, repo: await GitRepo.open(directory) };
}

test('unpushed range, pagination, first-parent merges and pushed history', async t => {
  const { git, commit, base, repo } = await fixture(t);
  assert.deepEqual((await repo.commits()).commits, []);
  git('checkout', '-b', 'topic');
  const side = await commit('side');
  git('checkout', 'main');
  const local = await commit('local');
  git('merge', '--no-ff', 'topic', '-m', 'merge topic');
  const merge = git('rev-parse', 'HEAD');
  const list = await repo.commits();
  assert.equal(list.upstream, 'refs/remotes/origin/main');
  assert.deepEqual(list.commits.map(item => item.sha), [merge, local]);
  assert.equal((await repo.commits('main', 0, 1)).hasMore, true);
  assert.deepEqual((await repo.commits('refs/heads/main', 1, 1)).commits.map(item => item.sha), [local]);
  assert.equal((await repo.commits('main', 2, 1)).hasMore, false);
  assert.equal((await repo.diff(side)).sha, side);
  assert.equal((await repo.diff(base)).sha, base);
  git('push');
  assert.deepEqual((await repo.commits()).commits, []);
  assert.ok((await repo.branches()).every(branch => branch.name.startsWith('refs/heads/')));
  await assert.rejects(repo.commits('origin/main'), /本地分支/);
});

test('commit messages retain multiline bodies without breaking pagination', async t => {
  const {git, repo} = await fixture(t);
  git('commit', '--allow-empty', '-m', 'Title with body', '-m', '第一段\n\n<script>plain text</script>\nCo-Authored-By: Test <test@example.invalid>');
  git('commit', '--allow-empty', '-m', 'Title only');
  const result = await repo.commits();
  assert.equal(result.commits.length, 2);
  assert.equal(result.commits[0].body, '');
  assert.equal(result.commits[1].subject, 'Title with body');
  assert.equal(result.commits[1].body, '第一段\n\n<script>plain text</script>\nCo-Authored-By: Test <test@example.invalid>\n');
  assert.deepEqual((await repo.commits('main', 1, 1)).commits, [result.commits[1]]);
});

test('missing upstream and detached HEAD never fall back to full history', async t => {
  const { git, repo } = await fixture(t);
  git('checkout', '-b', 'untracked');
  assert.equal((await repo.commits()).comparisonMode, 'local-base');
  git('config', 'branch.untracked.remote', '.');
  git('config', 'branch.untracked.merge', 'refs/heads/main');
  assert.equal((await repo.commits()).comparisonMode, 'local-base');
  git('checkout', 'main');
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal((await repo.commits()).comparisonRef, 'refs/heads/main');
  assert.deepEqual((await repo.commits()).commits, []);
  git('checkout', '--detach');
  assert.equal((await repo.commits()).status, 'detached');
  await assert.rejects(repo.commits('typo'), /找不到/);
});

test('fallback prefers main, then master, and never shows all history without a base', async t => {
  const { git, commit, repo } = await fixture(t);
  git('branch', 'master');
  await commit('main-only');
  git('checkout', '-b', 'feature');
  const first = await commit('feature-one');
  const second = await commit('feature-two');
  let result = await repo.commits();
  assert.equal(result.comparisonRef, 'refs/heads/main');
  assert.equal(result.comparisonMode, 'local-base');
  assert.deepEqual(result.commits.map(item => item.sha), [second, first]);
  assert.equal((await repo.commits('feature', 0, 1)).hasMore, true);
  assert.equal((await repo.commits('feature', 1, 1)).commits[0].sha, first);
  git('branch', '-D', 'main');
  result = await repo.commits();
  assert.equal(result.comparisonRef, 'refs/heads/master');
  assert.equal(result.commits.length, 3);
  git('branch', '-D', 'master');
  result = await repo.commits();
  assert.equal(result.status, 'no-base');
  assert.deepEqual(result.commits, []);
});

test('behind and divergent branches only include local first-parent commits', async t => {
  const { git, commit, base, repo } = await fixture(t);
  git('checkout', '-b', 'remote-work');
  const remote = await commit('remote-only');
  git('push', 'origin', 'HEAD:main');
  git('checkout', 'main');
  assert.deepEqual((await repo.commits()).commits, []);
  const local = await commit('local-only');
  assert.deepEqual((await repo.commits()).commits.map(item => item.sha), [local]);
  assert.equal(git('rev-parse', 'origin/main'), remote);
  assert.equal(git('merge-base', 'HEAD', 'origin/main'), base);
});
