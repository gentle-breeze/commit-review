import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';
import {chronologicalCommits,visibleCommits} from '../public/commit-filter.js';
import {GitRepo} from '../lib/git.mjs';
test('chronology uses absolute author instants and stable ancestry ties without changing display order',()=>{
  const commits=[{sha:'new-chain',date:'2020-01-01T08:00:00+08:00',subject:'keep'}, {sha:'latest',date:'2020-01-03T00:00:00Z',subject:'keep'}, {sha:'middle',date:'2020-01-02T00:00:00Z',subject:'skip'}, {sha:'old-chain',date:'2020-01-01T00:00:00Z',subject:'keep'}];
  const before=structuredClone(commits);
  assert.deepEqual(chronologicalCommits(commits).map(c=>c.sha),['old-chain','new-chain','middle','latest']);assert.deepEqual(commits,before);
  assert.deepEqual(chronologicalCommits(visibleCommits(commits,new Set(['latest']),false,'keep')).map(c=>c.sha),['old-chain','new-chain']);
  assert.deepEqual(chronologicalCommits(visibleCommits(commits,new Set(['latest']),true)).map(c=>c.sha),['latest']);
});
test('commit API date is author time even when committer time disagrees',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-author-time-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('commit','--allow-empty','-m','Base');git('checkout','-b','feature');
  for(const [name,author,committer] of [['A','2020-01-02T00:00:00Z','2025-01-01T00:00:00Z'],['B','2020-01-01T00:00:00Z','2025-01-02T00:00:00Z']])execFileSync('git',['-C',dir,'commit','--allow-empty','-m',name],{stdio:'pipe',env:{...process.env,GIT_AUTHOR_DATE:author,GIT_COMMITTER_DATE:committer}});
  const page=await(await GitRepo.open(dir)).commits();assert.deepEqual(page.commits.map(c=>c.subject),['B','A']);assert.match(page.commits[0].date,/^2020-01-01/);assert.deepEqual(chronologicalCommits(page.commits).map(c=>c.subject),['B','A']);
});
