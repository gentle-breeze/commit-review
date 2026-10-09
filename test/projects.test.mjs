import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { discoverProjects } from '../lib/projects.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
  const repository = async name => {
    const target = path.join(root, name);
    await mkdir(target, { recursive: true });
    git(target, 'init', '-b', 'main');
    return target;
  };
  return { root, git, repository };
}

test('project discovery filters directories, deduplicates aliases and includes worktrees', async t => {
  const { root, git, repository } = await fixture(t);
  const alpha = await repository('alpha');
  const chinese = await repository('中文 project');
  await repository('container/nested');
  await mkdir(path.join(root, 'not-git'));
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken', '.git'), 'invalid');
  await writeFile(path.join(root, 'file.txt'), 'not a project');
  await symlink(alpha, path.join(root, 'alias'), 'dir');
  await symlink(path.join(root, 'missing'), path.join(root, 'broken-link'), 'dir');
  git(alpha, 'config', 'user.name', 'Project Test');
  git(alpha, 'config', 'user.email', 'test@example.invalid');
  git(alpha, 'commit', '--allow-empty', '-m', 'initial');
  const linked = path.join(root, 'linked');
  git(alpha, 'worktree', 'add', '-b', 'linked', linked);
  git(root, 'init', '--bare', path.join(root, 'bare.git'));
  const listing = await discoverProjects(root);
  assert.equal(listing.directory, await realpath(root));
  assert.deepEqual(listing.projects.map(project => project.name), ['alpha', 'linked', '中文 project'].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(new Set(listing.projects.map(project => project.path)), new Set(await Promise.all([alpha, linked, chinese].map(target => realpath(target)))));
  await assert.rejects(access(path.join(root, '.reviews')), { code: 'ENOENT' });
  const own = await discoverProjects(alpha);
  assert.deepEqual(own.projects, [{ name: 'alpha', path: await realpath(alpha) }]);
});

test('empty project directory and unreadable directory have explicit outcomes', async t => {
  const { root } = await fixture(t);
  assert.deepEqual((await discoverProjects(root)).projects, []);
  await assert.rejects(discoverProjects(path.join(root, 'missing')), /无法读取项目目录/);
  const file = path.join(root, 'file');
  await writeFile(file, 'text');
  await assert.rejects(discoverProjects(file), /无法读取项目目录/);
});
