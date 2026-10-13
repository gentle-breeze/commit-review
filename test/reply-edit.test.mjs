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
  const request=async(route,body,custom=headers)=>{const r=await fetch(base+route,{method:body?.httpMethod|| (body?'POST':'GET'),headers:custom,...(body?{body:JSON.stringify(body?.httpMethod?Object.fromEntries(Object.entries(body).filter(([key])=>key!=='httpMethod')):body)}:{})});return {status:r.status,data:await r.json()};};
  return {app,request,headers};
}
test('reply edits, recoverable deletion and restoration retain identity, audit and resolution',async t=>{
  const f=await fixture(t);await f.put('a.txt','code\n');const sha=f.commit('Original');const {app,request}=await service(t,f);
  let c=(await request('/api/comments',{sha,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review'})).data;
  c=(await request(`/api/comments/${c.id}/ai`,{action:'reply',body:'AI original'})).data;const original=structuredClone(c.replies[0]);await app.store.update(c.id,{resolved:true});
  const route=`/api/comments/${c.id}/replies/${original.id}`;
  const body={httpMethod:'PATCH',body:'Human correction',revision:0,requestId:randomUUID()};
  const results=await Promise.all([request(route,body),request(route,body)]);assert.deepEqual(results.map(r=>r.status),[200,200]);c=results[1].data;
  let reply=c.replies[0];assert.equal(reply.author,'ai');assert.equal(reply.createdAt,original.createdAt);assert.equal(reply.body,'Human correction');assert.equal(reply.history.length,1);assert.equal(reply.history[0].body,'AI original');assert.equal(reply.updatedBy,'user');assert.equal(c.resolved,true);
  assert.equal((await request(route,{...body,body:'different'})).status,400);assert.equal((await request(route,{...body,requestId:randomUUID()})).status,400,'stale revision');
  for(const patch of [{body:'   '},{body:'x'.repeat(10001)},{author:'ai'},{resolved:false},{revision:'1'}])assert.equal((await request(route,{...body,revision:1,requestId:randomUUID(),...patch})).status,400);
  const edit=await request(route,{...body,revision:1,requestId:randomUUID(),body:'<script>literal</script>'});assert.equal(edit.status,200);c=edit.data;
  const del={httpMethod:'DELETE',revision:2,requestId:randomUUID()};c=(await request(route,del)).data;reply=c.replies[0];assert.ok(reply.deletedAt);assert.equal(reply.body,'<script>literal</script>');assert.equal(c.resolved,true);assert.equal(reply.history.length,3);
  assert.equal((await request(route,del)).data.replies[0].history.length,3,'duplicate delete is idempotent');
  assert.equal((await request(route,{...body,revision:3,requestId:randomUUID()})).status,400,'editing deleted reply rejected');
  const exported=toMarkdown(app.store.data);assert.match(exported,/已由用户删除，可恢复/);assert.doesNotMatch(exported,/<script>/);
  c=(await request(route+'/restore',{revision:3,requestId:randomUUID()})).data;assert.equal(c.replies[0].deletedAt,undefined);assert.equal(c.replies[0].body,'<script>literal</script>');assert.equal(c.resolved,true);assert.equal(c.replies[0].history.length,4);
  const reopened=await ReviewStore.open(path.join(f.root,'data'),app.repo.path);assert.deepEqual(reopened.list()[0],c);
});
test('concurrent reply mutations and project identities cannot overwrite unrelated replies',async t=>{
  const f=await fixture(t);await f.put('a.txt','code\n');const sha=f.commit('Original');const {app,request,headers}=await service(t,f);
  let c=(await request('/api/comments',{sha,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review'})).data;c=(await request(`/api/comments/${c.id}/replies`,{body:'Original'})).data;
  const reply=c.replies[0],route=`/api/comments/${c.id}/replies/${reply.id}`;
  const op=body=>({httpMethod:'PATCH',revision:0,requestId:randomUUID(),body});
  const results=await Promise.all([request(route,op('one')),request(route,op('two'))]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===400).length,1);assert.equal(app.store.list()[0].replies[0].history.length,1);
  const other=path.join(f.root,'other');await mkdir(other);execFileSync('git',['-C',other,'init','-b','main'],{stdio:'pipe'});const info=(await request('/api/repository',{repository:other})).data;
  assert.equal((await request(route,op('cross'),{...headers,'X-Review-Project':info.projectId,'X-Review-Token':info.token})).status,400);
  assert.equal((await request(route,op('cross'),{...headers,'X-Review-Project':info.projectId})).status,403);
  assert.equal((await request(`/api/comments/${randomUUID()}/replies/${reply.id}`,op('cross'))).status,400);
});
