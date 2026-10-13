import {runAIReview} from '../ai-review.mjs';
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
test('AI CLI creates evidence-backed provisional links; users can confirm and correct without closing',async t=>{
  const f=await fixture(t);await f.put('a.txt','old\n');const original=f.commit('Original');const {app,request}=await service(t,f);const url=`http://127.0.0.1:${app.server.address().port}`;
  let c=(await request('/api/comments',{sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review'})).data;
  await f.put('a.txt','fixed\n');const target=f.commit('Fix');
  const common=['--repo',f.dir,'--url',url,'--comment',c.id];
  const preview=await runAIReview(['target',...common,'--ref','HEAD']);assert.equal(preview.sha,target);assert.equal(app.store.list()[0].followups,undefined,'preview does not write');
  const evidenceFile=path.join(f.root,'evidence.txt');await writeFile(evidenceFile,'Target replaces the old branch handling; tests still need review.');
  const args=['link',...common,'--sha',target,'--path','a.txt','--start-line','1','--end-line','1','--revision','0','--request-id',randomUUID(),'--evidence-file',evidenceFile];
  c=await runAIReview(args);assert.equal(c.followups[0].createdBy,'ai');assert.match(c.followups[0].evidence,/branch handling/);assert.equal(c.followups[0].code,'fixed');assert.equal(c.sha,original);assert.equal(c.code,'old');assert.equal(c.resolved,false);assert.equal(c.followups[0].confirmedAt,undefined);
  assert.equal((await runAIReview(args)).followups.length,1);
  const route=`/api/comments/${c.id}/links`;
  assert.equal((await request(route+'/ai',{revision:1,requestId:randomUUID(),confirmId:c.followups[0].id,evidence:'claim'})).status,400);
  assert.equal((await request(route+'/ai',{revision:1,requestId:randomUUID(),sha:target,path:'a.txt',startLine:1,endLine:1,evidence:' '})).status,400);
  c=(await request(route,{revision:1,requestId:randomUUID(),confirmId:c.followups[0].id})).data;assert.equal(c.followups[0].createdBy,'ai');assert.equal(c.followups[0].confirmedBy,'user');assert.equal(c.resolved,false);
  c=(await request(route,{revision:2,requestId:randomUUID(),removeId:c.followups[0].id})).data;assert.equal(c.followups[0].removedBy,'user');
  c=(await request(route,{revision:3,requestId:randomUUID(),sha:target,path:'a.txt',startLine:1,endLine:1})).data;assert.equal(c.followups.length,2);assert.equal(c.followups[1].createdBy,'user');assert.equal(c.resolved,false);
  assert.match(toMarkdown(app.store.data),/AI 初步关联/);assert.match(toMarkdown(app.store.data),/用户确认时间/);
  const other=path.join(f.root,'other');await mkdir(other);execFileSync('git',['-C',other,'init','-b','main'],{stdio:'pipe'});
  await assert.rejects(runAIReview(['link',...args.slice(1).map(value=>value===f.dir?other:value)]),/评论不存在/);
});
test('latest association uses author time, ancestry ties, selected IDs, renamed and unchanged paths',async t=>{
  const f=await fixture(t);await f.put('old.txt','code\n');const original=f.commit('Original');const {app,request}=await service(t,f);
  let c=(await request('/api/comments',{sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review'})).data;
  const commitAt=(name,date)=>{f.git('add','.');execFileSync('git',['-C',f.dir,'commit','-m',name],{stdio:'pipe',env:{...process.env,GIT_AUTHOR_DATE:date}});return f.git('rev-parse','HEAD');};
  f.git('mv','old.txt','renamed.txt');const newer=commitAt('Rename','2020-01-03T00:00:00Z');await f.put('unrelated.txt','unrelated\n');const earlier=commitAt('Other','2020-01-01T00:00:00Z');await f.put('unrelated.txt','again\n');const tie=commitAt('Tie','2020-01-03T08:00:00+08:00');
  const route=`/api/comments/${c.id}/links`;
  for(const sha of [tie,newer,earlier])c=(await request(route,{revision:c.linkRevision||0,requestId:randomUUID(),sha,path:'renamed.txt',startLine:1,endLine:1})).data;
  let picked=(await request(`/api/comments/${c.id}/latest`,{ids:c.followups.map(l=>l.id)})).data;assert.equal(picked.link.sha,tie);assert.equal(picked.fileId,undefined,'unchanged linked path must not select unrelated diff file');
  picked=(await request(`/api/comments/${c.id}/latest`,{ids:c.followups.slice(1).map(l=>l.id)})).data;assert.equal(picked.link.sha,newer);assert.equal(picked.fileId,'0');
  assert.equal((await request(`/api/comments/${c.id}/latest`,{ids:[]})).data.link,null);
  const bad=await app.store.link(c.id,{revision:c.linkRevision,requestId:randomUUID(),target:{sha:'f'.repeat(40),path:'missing.txt',startLine:1,endLine:1,code:'saved'}});
  picked=(await request(`/api/comments/${c.id}/latest`,{ids:bad.followups.map(l=>l.id)})).data;assert.equal(picked.link.sha,tie);assert.equal(picked.skipped.length,1);
});
