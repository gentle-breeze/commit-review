import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';
import {GitRepo} from '../lib/git.mjs';import {FileIndex} from '../lib/file-index.mjs';
import {buildFileHistory,visibleFileHistory} from '../public/file-history.js';
import {createApp} from '../server.mjs';
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'review-index-')),dir=path.join(root,'repo');await mkdir(dir);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Index Reviewer');git('config','user.email','test@example.invalid');git('commit','--allow-empty','-m','Base');git('checkout','-b','feature');
  const put=async(name,body)=>{await mkdir(path.dirname(path.join(dir,name)),{recursive:true});await writeFile(path.join(dir,name),body);};
  const commit=message=>{git('add','-A');git('commit','-m',message);return git('rev-parse','HEAD');};
  return {root,dir,git,put,commit,repo:await GitRepo.open(dir)};
}
async function allPages(index,ref='HEAD'){
  let page=await index.page({ref}),commits=[...page.commits];
  while(!page.complete){page=await index.page({ref,snapshotId:page.snapshotId,offset:page.nextOffset});commits.push(...page.commits);}
  return {...page,commits};
}
test('full frozen index spans pages, exact paths, rename, delete/recreate, binary and filters',async t=>{
  const {git,put,commit,repo}=await fixture(t);
  await put('old name\tfile.txt','alpha\nbeta\ngamma\n');await put('other/file.txt','independent\n');const added=commit('Add original');
  git('mv','old name\tfile.txt','renamed.txt');const renamed=commit('Rename');
  await put('renamed.txt','alpha\nbeta changed\ngamma\n');commit('Modify');
  git('rm','renamed.txt');commit('Delete');await put('renamed.txt','unrelated replacement\n');const replacement=commit('Recreate');
  await put('Image.bin',Buffer.from([0,1,2]));await put('FooTest.java','test\n');commit('Binary and Test');
  for(let i=0;i<51;i++)git('commit','--allow-empty','-m',`Empty ${i}`);
  const index=new FileIndex(repo), first=await index.page({});assert.equal(first.commits.length,25);assert.equal(first.complete,false);
  const frozenHead=first.scope.head;await put('later.txt','not in snapshot\n');const later=commit('Later');
  const commits=[...first.commits];let page=first;
  while(!page.complete){page=await index.page({snapshotId:first.snapshotId,offset:page.nextOffset});commits.push(...page.commits);}
  assert.equal(commits.length,57);assert.equal(page.scope.head,frozenHead);assert.equal(commits.some(c=>c.sha===later),false);
  assert.notEqual((await index.page({})).snapshotId,first.snapshotId,'new scope creates a new snapshot');
  const groups=buildFileHistory(commits), rows=visibleFileHistory(groups,{hidden:new Set()});
  const original=rows.find(row=>row.events.some(e=>e.commit.sha===added&&e.file.path==='old name\tfile.txt'));
  assert.equal(original.events.length,4);assert.equal(original.deleted,true);assert.ok(original.paths.includes('renamed.txt'));
  const rename=original.events.find(e=>e.commit.sha===renamed).file;assert.match(rename.status,/^R/);assert.equal(rename.additions,0);assert.equal(rename.oldPath,'old name\tfile.txt');
  assert.equal(rows.filter(row=>row.path==='renamed.txt').length,2,'recreated path is a separate history');
  assert.equal(rows.find(row=>row.events.some(e=>e.commit.sha===replacement)).events.length,1);
  assert.equal(rows.find(row=>row.path==='Image.bin').events[0].file.additions,null);
  assert.equal(rows.find(row=>row.path==='Image.bin').events[0].file.binary,true);
  assert.equal(visibleFileHistory(groups,{hidden:new Set([renamed]),skipTests:true}).some(row=>row.path==='FooTest.java'),false);
  assert.equal(visibleFileHistory(groups,{hidden:new Set([renamed])}).flatMap(row=>row.events).some(e=>e.commit.sha===renamed),false);
  assert.equal(visibleFileHistory(groups,{hidden:new Set([renamed]),showHidden:true}).flatMap(row=>row.events).length,1);
  assert.equal(visibleFileHistory(groups,{hidden:new Set(),query:'old name\tfile'}).length,1);
  assert.equal((await allPages(index,'main')).commits.length,0);
  await assert.rejects(index.page({snapshotId:first.snapshotId,ref:'main',offset:25}),/不匹配/);
});
test('large commit target beyond 300 files supports exact content and comments through isolated API',async t=>{
  const {root,dir,put,commit,repo}=await fixture(t);
  for(let i=0;i<305;i++)await put(`f${String(i).padStart(3,'0')}.txt`,`file ${i}\n`);
  const sha=commit('Large');const index=await allPages(new FileIndex(repo));assert.equal(index.commits[0].files.length,305);
  const plain=await repo.diff(sha);assert.equal(plain.files.length,300);
  const targeted=await repo.diff(sha,'304');assert.equal(targeted.files[0].path,'f304.txt');assert.equal(targeted.focusedFileId,'304');assert.equal(targeted.files[0].id,'304');
  const app=await createApp({repoPath:dir,dataDir:path.join(root,'data')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.release();});
  const base=`http://127.0.0.1:${app.server.address().port}`,info=await(await fetch(base+'/api/info')).json();
  const headers={'X-Review-Token':info.token,'X-Review-Project':info.projectId,'Content-Type':'application/json'};
  const request=(route,body)=>fetch(base+route,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});
  const response=await request('/api/comments',{sha,anchor:{fileId:'304',side:'new',startLine:1,endLine:1},body:'indexed comment'});assert.equal(response.status,201);assert.equal((await response.json()).path,'f304.txt');
  assert.equal((await(await request(`/api/file?sha=${sha}&fileId=304`)).json()).new.text,'file 304\n');
  const first=await(await request('/api/file-index')).json();
  const other=path.join(root,'other');await mkdir(other);execFileSync('git',['-C',other,'init','-b','main'],{stdio:'pipe'});
  const second=await(await request('/api/repository',{repository:other})).json();
  const wrong=await fetch(base+'/api/file-index?snapshot='+first.snapshotId,{headers:{...headers,'X-Review-Project':second.projectId,'X-Review-Token':second.token}});assert.equal(wrong.status,400);
  assert.equal((await fetch(base+'/api/file-index',{headers:{...headers,'X-Review-Project':second.projectId}})).status,403);
  assert.equal((await request('/api/file-index?offset=5000')).status,400);
});
test('merge file changes compare first parent and pending requests share a repository queue',async t=>{
  const {git,put,commit,repo}=await fixture(t);await put('main.txt','main\n');commit('Main change');git('checkout','-b','side');await put('side.txt','side\n');commit('Side change');git('checkout','feature');git('merge','--no-ff','side','-m','Merge side');
  const index=new FileIndex(repo),[a,b]=await Promise.all([index.page({}),index.page({})]);assert.equal(a.snapshotId,b.snapshotId);
  assert.equal(a.commits.length,2);assert.equal(a.commits[0].subject,'Merge side');assert.deepEqual(a.commits[0].files.map(f=>f.path),['side.txt']);
});
