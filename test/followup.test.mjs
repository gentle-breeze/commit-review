import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {ReviewStore,toMarkdown} from '../lib/reviews.mjs';
import {reviewComments} from '../public/comment-view.js';
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

async function service(t,fixture){
  const app=await createApp({repoPath:fixture.dir,dataDir:path.join(fixture.root,'data')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));await app.release();});
  const base=`http://127.0.0.1:${app.server.address().port}`,info=await(await fetch(base+'/api/info')).json();
  const headers={'X-Review-Token':info.token,'X-Review-Project':info.projectId,'Content-Type':'application/json'};
  const request=async(route,body,custom=headers)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:custom,...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  return {app,request,headers};
}
test('amend/rebase/squash/split/rename retain original evidence and support explicit many-target review',async t=>{
  const f=await fixture(t),{git,put,commit,repo}=f;
  const content='bug\nbug\n'+Array.from({length:12},(_,i)=>`context ${i}`).join('\n')+'\n';
  await put('a.txt',content);const original=commit('Original');
  const {app,request}=await service(t,f);
  let response=await request('/api/comments',{sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Does bug handling remain?'});assert.equal(response.status,201);let c=response.data;const evidence={sha:c.sha,path:c.path,code:c.code,side:c.side};
  const preview=async(ref='HEAD',name='')=>{const r=await request(`/api/comments/${c.id}/target?${new URLSearchParams({ref,path:name})}`);assert.equal(r.status,200);return r.data;};
  // Seed legacy code-level records directly to verify existing data survives the new UI/API.
  const add=async(p,startLine=p.candidates[0].startLine)=>{c=await app.store.link(c.id,{requestId:randomUUID(),revision:c.linkRevision||0,target:{sha:p.sha,path:p.path,startLine,endLine:startLine,code:p.text.split('\n')[startLine-1]}});assert.equal(c.resolved,false);};
  await put('a.txt','prefix\n'+content);git('add','.');git('commit','--amend','-m','Amended');
  let p=await preview();assert.notEqual(p.sha,original);assert.equal(p.candidates.length,2);assert.ok(p.candidates.every(x=>x.basis==='exact-text'));await add(p);const amended=p.sha;
  git('checkout','main');await put('base.txt','new base\n');commit('Base advances');git('checkout','feature');git('rebase','main');p=await preview();assert.notEqual(p.sha,amended);await add(p);
  await put('a.txt','prefix\n'+content.replaceAll('bug','safe'));await put('b.txt','split second concern\n');commit('Fix');git('reset','--soft','HEAD~2');git('commit','-m','Squashed');p=await preview();assert.equal(p.candidates[0].basis,'path-only');await add(p);
  git('reset','--mixed','HEAD~1');git('add','a.txt');git('commit','-m','Split A');p=await preview();await add(p);git('add','b.txt');git('commit','-m','Split B');p=await preview();await add(p);
  git('mv','a.txt','renamed.txt');git('commit','-m','Rename');p=await preview();assert.equal(p.path,'renamed.txt');await add(p);
  assert.equal(c.followups.length,6);assert.deepEqual({sha:c.sha,path:c.path,code:c.code,side:c.side},evidence);
  assert.equal(reviewComments([c],{hidden:new Set([original]),showingHidden:false,scope:'commit',sha:p.sha,filter:'unresolved'}).length,1);
  assert.equal(reviewComments([c],{hidden:new Set([p.sha]),showingHidden:false,scope:'commit',sha:p.sha,filter:'unresolved'}).length,0);
  assert.equal(reviewComments([c],{hidden:new Set([p.sha]),showingHidden:true,scope:'commit',sha:p.sha,filter:'unresolved'}).length,1);
  git('reflog','expire','--expire=now','--all');git('gc','--prune=now');
  await assert.rejects(repo.resolve(original));
  p=await preview('HEAD','renamed.txt');assert.equal(p.path,'renamed.txt');assert.equal(c.code,evidence.code,'original quote survives garbage collection');
  const body=toMarkdown(app.store.data);assert.match(body,/待对照复核/);assert.ok(body.includes(original)&&body.includes(p.sha));assert.match(body,/不能仅凭 SHA 或文本变化/);
});
test('association replacement is atomic, idempotent, project scoped and preserves legacy history',async t=>{
  const f=await fixture(t);await f.put('a.txt','old\n');const sha=f.commit('Original');const {app,request,headers}=await service(t,f);
  let c=(await request('/api/comments',{sha,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Original'})).data;
  c=await app.store.link(c.id,{revision:0,requestId:randomUUID(),target:{sha,path:'a.txt',startLine:1,endLine:1,code:'old'}});
  await app.store.update(c.id,{resolved:true});
  await f.put('a.txt','new\n');const target=f.commit('Next'),route=`/api/comments/${c.id}/associations`;
  const scope=(await request('/api/association-scope?ref=HEAD')).data.id;
  const body={scope,requestId:randomUUID(),revision:1,shas:[target]};
  const duplicate=await Promise.all([request(route,body),request(route,body)]);assert.deepEqual(duplicate.map(r=>r.status),[200,200]);c=duplicate[1].data;
  assert.equal(c.followups.length,2);assert.equal(c.followups[0].code,'old');assert.ok(c.followups[0].removedAt);assert.equal(c.followups[1].kind,'commit');assert.equal(c.linkRevision,2);assert.equal(c.resolved,true);
  for(const patch of [{shas:[sha]},{revision:0},{resolved:false},{shas:[f.git('rev-parse','main')]}])assert.equal((await request(route,{...body,requestId:randomUUID(),...patch})).status,400);
  assert.equal((await request(`/api/comments/${c.id}/links`,{revision:2,requestId:randomUUID(),sha:target,path:'a.txt',startLine:1,endLine:1})).status,400,'legacy endpoint cannot bypass scope');
  const operations=await Promise.all([request(route,{...body,revision:2,requestId:randomUUID(),shas:[]}),request(route,{...body,revision:2,requestId:randomUUID(),shas:[sha,target]})]);assert.equal(operations.filter(r=>r.status===200).length,1);
  c=app.store.list()[0];assert.equal(c.resolved,true);assert.equal(c.sha,sha);assert.equal(c.code,'old');assert.equal(c.followups[0].code,'old');
  const other=path.join(f.root,'other');await mkdir(other);execFileSync('git',['-C',other,'init','-b','main'],{stdio:'pipe'});
  const info=(await request('/api/repository',{repository:other})).data,cross={...headers,'X-Review-Token':info.token,'X-Review-Project':info.projectId};
  assert.equal((await request(route,body,cross)).status,400);assert.equal((await request('/api/comments',undefined,cross)).data.length,0);
  assert.equal((await request(route,body,{...headers,'X-Review-Project':info.projectId})).status,403);
  const reopened=await ReviewStore.open(path.join(f.root,'data'),app.repo.path);assert.deepEqual(reopened.list()[0],c);
});

test('old-side rename uses original path and unsupported targets stay explicit',async t=>{
  const f=await fixture(t);await f.put('old.txt','old bug\ncontext\n');const parent=f.commit('Original');f.git('mv','old.txt','new.txt');const sha=f.commit('Rename');
  const comment={sha,parent,path:'new.txt',oldPath:'old.txt',side:'old',startLine:1,endLine:1,code:'old bug'};
  const p=await f.repo.commentTarget(comment,'HEAD');assert.equal(p.path,'new.txt');assert.equal(p.candidates[0].basis,'exact-text');
  await f.put('binary.bin',Buffer.from([0,1]));f.commit('Binary');const binary=await f.repo.commentTarget(comment,'HEAD','binary.bin');assert.match(binary.unavailable,/二进制/);assert.deepEqual(binary.candidates,[]);
  const missing=await f.repo.commentTarget(comment,'HEAD','missing.txt');assert.ok(missing.unavailable);
  await assert.rejects(f.repo.commentTarget(comment,'HEAD','../outside'),/路径无效/);
});
