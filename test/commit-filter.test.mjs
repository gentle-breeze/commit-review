import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenCommitsKey, readHiddenCommits, writeHiddenCommits, visibleCommits } from '../public/commit-filter.js';
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(64);
test('hidden SHA preferences persist per repository and validate stored values', () => {
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key,value) => data.set(key,value) };
  writeHiddenCommits(storage, '/repo/a', new Set([a,c]));
  assert.deepEqual([...readHiddenCommits(storage, '/repo/a')], [a,c]);
  assert.deepEqual([...readHiddenCommits(storage, '/repo/b')], []);
  writeHiddenCommits(storage, '/repo/b', new Set([b]));
  writeHiddenCommits(storage, '/repo/a', new Set());
  assert.deepEqual([...readHiddenCommits(storage, '/repo/b')], [b]);
  storage.setItem(hiddenCommitsKey('/repo/a'), JSON.stringify([a, 'short', null, 123]));
  assert.deepEqual([...readHiddenCommits(storage, '/repo/a')], [a]);
});
test('filter combines hidden mode, search and loaded scope without mutating commits', () => {
  const commits = [{sha:a,subject:'First change',author:'Alice'}, {sha:b,subject:'Second',author:'Bob'}];
  const hidden = new Set([a,c]);
  assert.deepEqual(visibleCommits(commits,hidden), [commits[1]]);
  assert.deepEqual(visibleCommits(commits,hidden,true,' ALICE '), [commits[0]]);
  assert.deepEqual(visibleCommits(commits,hidden,false,'bbbb'), [commits[1]]);
  assert.deepEqual(visibleCommits(commits,hidden,false,'First'), []);
  assert.equal(commits.length,2);
  assert.equal(hidden.size,2);
});
