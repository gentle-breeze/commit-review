import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {GitRepo} from '../lib/git.mjs';
import {createApp} from '../server.mjs';
import {runAIReview} from '../ai-review.mjs';
import {commitScopeKey} from '../public/commit-filter.js';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'review-ranges-')),dir=path.join(root,'repo');
  await mkdir(dir);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Range Test');git('config','user.email','test@example.invalid');
  const put=(name,body)=>writeFile(path.join(dir,name),body);
  const commit=message=>{git('add','-A');git('commit','--allow-empty','-m',message);return git('rev-parse','HEAD');};
  await put('old.txt','original\n');const base=commit('Base');
  git('init','--bare',path.join(root,'remote.git'));git('remote','add','origin',path.join(root,'remote.git'));git('push','-u','origin','main');
  git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main');git('switch','-c','feature');
  return {root,dir,git,put,commit,base,repo:await GitRepo.open(dir)};
}

async function service(t,f) {
  const app=await createApp({repoPath:f.dir,dataDir:path.join(f.root,'data')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.release();});
  const base=`http://127.0.0.1:${app.server.address().port}`,info=await(await fetch(base+'/api/info')).json();
  const headers={'X-Review-Token':info.token,'X-Review-Project':info.projectId,'Content-Type':'application/json'};
  const request=async(route,body,custom=headers)=>{
    const response=await fetch(base+route,{method:body?'POST':'GET',headers:custom,...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  };
  const get=async route=>{const result=await request(route);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
  return {app,base,headers,request,get};
}

test('compare uses directional branch reachability, remote branches and first-parent history',async t=>{
  const f=await fixture(t);
  await f.put('old.txt','changed\n');const feature=f.commit('Feature');
  f.git('push','-u','origin','feature');
  assert.deepEqual((await f.repo.commits('feature')).commits,[],'pushed commits leave the legacy shortcut');
  const scope=await f.repo.reviewScope('origin/feature',{mode:'compare',base:'origin/main'});
  assert.equal(scope.ref,'refs/remotes/origin/feature');assert.equal(scope.comparisonRef,'refs/remotes/origin/main');
  assert.equal(scope.mergeBase,f.base);assert.deepEqual((await f.repo.commitPage(scope)).commits.map(c=>c.sha),[feature]);
  assert.deepEqual((await f.repo.commitPage(await f.repo.reviewScope('main',{mode:'compare',base:'feature'}))).commits,[],'A..B excludes commits reachable only from A');
  assert.deepEqual((await f.repo.commitPage(await f.repo.reviewScope('feature',{mode:'compare',base:'feature'}))).commits,[],'equal refs are a valid empty range');
  assert.ok((await f.repo.branches()).every(b=>b.name.startsWith('refs/heads/')));
  const all=await f.repo.branches({includeRemote:true});
  assert.ok(all.some(b=>b.name==='refs/remotes/origin/feature'));assert.ok(!all.some(b=>b.name==='refs/remotes/origin/HEAD'));
  f.git('switch','main');f.git('merge','--no-ff','feature','-m','Merged feature');const merged=f.git('rev-parse','HEAD');f.git('push');
  assert.deepEqual((await f.repo.commitPage(await f.repo.reviewScope('feature',{mode:'compare',base:'main'}))).commits,[]);
  const history=await f.repo.commitPage(await f.repo.reviewScope('origin/main',{mode:'history'}));
  assert.deepEqual(history.commits.map(c=>c.sha),[merged,f.base],'merged change remains reviewable with the established first-parent view');
  assert.deepEqual((await f.repo.diff(merged)).files.map(file=>file.path),['old.txt']);
  assert.equal((await f.repo.diff(feature)).sha,feature,'original feature SHA remains directly readable');
});

test('range creation rejects invalid references, tags, revision expressions and unrelated histories',async t=>{
  const f=await fixture(t),s=await service(t,f);
  f.git('tag','v1');
  for(const route of [
    '/api/review-scope?mode=unknown',
    '/api/review-scope?mode=history&ref=missing',
    '/api/review-scope?mode=history&ref=--all',
    '/api/review-scope?mode=history&ref=HEAD~1',
    '/api/review-scope?mode=history&ref=v1',
    '/api/review-scope?mode=history&ref='+f.base,
    '/api/review-scope?mode=compare&ref=feature',
    '/api/review-scope?mode=compare&ref=feature&base=missing',
  ]) assert.equal((await s.request(route)).status,400,route);
  f.git('switch','--orphan','unrelated');f.commit('Unrelated root');
  const unrelated=await s.request('/api/review-scope?mode=compare&ref=unrelated&base=main');
  assert.equal(unrelated.status,400);assert.match(unrelated.data.error,/没有共同祖先/);
  assert.equal((await s.get('/api/review-scope?mode=history&ref=unrelated')).status,'ready');
  f.git('switch','--detach','main');
  assert.equal((await s.request('/api/review-scope?mode=history&ref=HEAD')).status,400);
  assert.equal((await s.get('/api/review-scope?mode=unpushed')).status,'detached');
  assert.ok((await s.get('/api/branches')).every(b=>b.name.startsWith('refs/heads/')));
  assert.ok((await s.get('/api/branches?all=1')).some(b=>b.name==='refs/remotes/origin/main'));
});

test('frozen pages, file index, AI and associations share endpoints across branch changes and refresh',async t=>{
  const f=await fixture(t);
  await f.put('old.txt','review this\n');const original=f.commit('Original');
  f.git('mv','old.txt','renamed.txt');const renamed=f.commit('Rename');
  for(let i=0;i<54;i++)f.commit(`Page ${i}`);
  f.git('push','-u','origin','feature');
  const s=await service(t,f);
  const comment=(await s.request('/api/comments',{sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Retain this issue'})).data;
  const snapshot=await s.get('/api/review-scope?mode=compare&base=refs/remotes/origin/main&ref=refs/remotes/origin/feature');
  assert.match(snapshot.id,/^[a-f0-9]{64}$/);assert.equal(snapshot.scopeKey,commitScopeKey(snapshot));
  const first=await s.get(`/api/commits?scope=${snapshot.id}`);
  assert.equal(first.commits.length,50);assert.equal(first.hasMore,true);
  const indexFirst=await s.get(`/api/file-index?scope=${snapshot.id}`);
  assert.equal(indexFirst.commits.length,25);
  const legacy=await s.get('/api/association-scope?ref=feature');
  // Live refs move after both paginated consumers have started.
  const later=f.commit('Later');f.git('push');f.git('branch','-f','main','feature');f.git('push','origin','main');
  const second=await s.get(`/api/commits?scope=${snapshot.id}&offset=50`);
  assert.equal(second.commits.length,6);assert.equal(second.hasMore,false);assert.equal(second.head,snapshot.head);
  const selected=[...first.commits,...second.commits].map(c=>c.sha);
  assert.ok(!selected.includes(later));assert.equal(selected.at(-1),original);
  let index=indexFirst;const indexed=[...indexFirst.commits];
  while(!index.complete){index=await s.get(`/api/file-index?scope=${snapshot.id}&snapshot=${indexFirst.snapshotId}&offset=${index.nextOffset}`);indexed.push(...index.commits);}
  assert.equal(index.scope.head,snapshot.head);assert.deepEqual(indexed.map(c=>c.sha),selected);
  const rename=indexed.find(c=>c.sha===renamed).files[0];assert.equal(rename.oldPath,'old.txt');assert.equal(rename.path,'renamed.txt');
  const association=await s.get(`/api/association-scope?id=${snapshot.id}`);
  assert.deepEqual(association.commits.map(c=>c.sha),selected);assert.equal(association.scopeKey,snapshot.scopeKey);
  const ai=await runAIReview(['scope','--repo',f.dir,'--url',s.base,'--scope',snapshot.id]);
  assert.deepEqual(ai.commits.map(c=>c.sha),selected);
  let result=await s.request(`/api/comments/${comment.id}/associations`,{scope:snapshot.id,shas:[original,renamed],revision:0,requestId:randomUUID()});
  assert.equal(result.status,200);assert.equal(result.data.followups.filter(link=>!link.removedAt).length,2);
  assert.equal((await s.request(`/api/association-scope?id=${legacy.id}`)).status,400,'legacy scopes retain live-ref invalidation');
  const refreshed=await s.get('/api/review-scope?mode=compare&base=refs/remotes/origin/main&ref=refs/remotes/origin/feature');
  assert.notEqual(refreshed.id,snapshot.id);assert.equal(refreshed.head,later);
  assert.deepEqual((await s.get(`/api/commits?scope=${refreshed.id}`)).commits,[],'explicit refresh captures the moved baseline');
  assert.equal((await s.request(`/api/file-index?scope=${refreshed.id}&snapshot=${indexFirst.snapshotId}`)).status,400,'file snapshots cannot be mixed between ranges');
  assert.deepEqual((await s.get('/api/comments'))[0].followups,result.data.followups,'switching ranges does not rewrite associations');
  result=await s.request(`/api/comments/${comment.id}/associations`,{scope:snapshot.id,shas:[renamed],revision:1,requestId:randomUUID()});
  assert.equal(result.status,200);assert.ok(result.data.followups.find(link=>link.sha===original).removedAt);
  assert.equal(result.data.path,'old.txt');assert.equal(result.data.code,'review this');assert.equal(result.data.resolved,false);
  assert.equal((await s.request(`/api/comments/${comment.id}/associations`,{scope:snapshot.id,shas:[later],revision:2,requestId:randomUUID()})).status,400,'later commit cannot leak into the fixed candidate set');
});

test('history paginates after push, old scopes persist until eviction and scopes are project-bound',async t=>{
  const f=await fixture(t);
  for(let i=0;i<61;i++)f.commit(`History ${i}`);
  f.git('push','-u','origin','feature');const s=await service(t,f);
  const snapshot=await s.get('/api/review-scope?mode=history&ref=feature');
  const first=await s.get(`/api/commits?scope=${snapshot.id}`);assert.equal(first.commits.length,50);assert.equal(first.hasMore,true);
  const later=f.commit('After snapshot');
  const second=await s.get(`/api/commits?scope=${snapshot.id}&offset=50`);assert.equal(second.commits.length,12);assert.equal(second.commits.at(-1).sha,f.base);
  assert.equal(second.hasMore,false);assert.ok(![...first.commits,...second.commits].some(c=>c.sha===later));
  const refreshed=await s.get('/api/review-scope?mode=history&ref=feature');assert.notEqual(refreshed.id,snapshot.id);assert.equal(refreshed.head,later);
  assert.equal((await s.get(`/api/commits?scope=${refreshed.id}`)).commits[0].sha,later);
  for(const route of ['/api/commits?scope=','/api/commits?scope='+ 'a'.repeat(64),`/api/commits?scope=${snapshot.id}&offset=-1`,`/api/commits?scope=${snapshot.id}&limit=101`,'/api/file-index?scope='+ 'b'.repeat(64)]) assert.equal((await s.request(route)).status,400);
  const other=path.join(f.root,'other');await mkdir(other);execFileSync('git',['-C',other,'init','-b','main'],{stdio:'pipe'});
  const otherInfo=(await s.request('/api/repository',{repository:other})).data;
  const otherHeaders={...s.headers,'X-Review-Token':otherInfo.token,'X-Review-Project':otherInfo.projectId};
  for(const route of [`/api/commits?scope=${snapshot.id}`,`/api/file-index?scope=${snapshot.id}`,`/api/association-scope?id=${snapshot.id}`])assert.equal((await s.request(route,undefined,otherHeaders)).status,400);
  for(let i=0;i<31;i++)await s.get('/api/review-scope?mode=history&ref=feature');
  const expired=await s.request(`/api/commits?scope=${snapshot.id}`);assert.equal(expired.status,400);assert.match(expired.data.error,/已失效/);
  assert.equal((await s.request(`/api/association-scope?id=${snapshot.id}`)).status,400);
  assert.equal((await s.get(`/api/commits?scope=${refreshed.id}`)).head,later,'newer scope remains available');
});

test('author identity filters full frozen ranges before pagination and excludes structural merges', async t => {
  const f = await fixture(t);
  const name = 'Same [Name].*', email = 'one+test@example.invalid';
  const author = JSON.stringify([name, email]);
  const expected = [];
  for (let i = 0; i < 55; i++) {
    f.git('config', 'user.name', name); f.git('config', 'user.email', email);
    expected.unshift(f.commit(i === 0 ? 'Merge is only a subject' : `Match ${i}`));
    f.git('config', 'user.email', 'other@example.invalid'); f.commit(`Other ${i}`);
  }
  f.git('checkout', '-b', 'side'); f.commit('Side'); f.git('checkout', 'feature');
  f.git('config', 'user.email', email); f.commit('Mainline'); expected.unshift(f.git('rev-parse', 'HEAD'));
  f.git('merge', '--no-ff', 'side', '-m', 'Ordinary title with two parents');
  const merge = f.git('rev-parse', 'HEAD');
  await f.put('.mailmap', `Mapped <mapped@example.invalid> ${name} <${email}>\n`);
  f.git('config', 'log.mailmap', 'true');
  const {get, request} = await service(t, f);
  for (const mode of ['unpushed', 'compare', 'history']) {
    const scope = await get('/api/review-scope?' + new URLSearchParams({mode, ref:'feature', base:'main', author}));
    assert.equal(scope.total, 56);
    assert.equal(scope.authors.find(a => a.id === author).count, 56);
    assert.ok(scope.authors.some(a => a.name === name && a.email === 'other@example.invalid'));
    assert.equal(scope.scopeKey, commitScopeKey(scope));
    const first = await get(`/api/commits?scope=${scope.id}`), second = await get(`/api/commits?scope=${scope.id}&offset=50`);
    assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
    assert.deepEqual([...first.commits,...second.commits].map(c => c.sha), expected);
    assert.ok(first.commits.every(c => c.authorEmail === email && c.parents.length <= 1));
    const candidates = await get(`/api/association-scope?id=${scope.id}`);
    assert.deepEqual(candidates.commits.map(c => c.sha), expected);
    const index = await get(`/api/file-index?scope=${scope.id}`);
    assert.ok(index.commits.every(c => c.authorEmail === email && c.sha !== merge));
  }
  const unfiltered = await get('/api/review-scope?mode=history&ref=feature');
  assert.equal(unfiltered.total, 113);
  assert.equal((await get(`/api/commits?scope=${unfiltered.id}`)).commits[0].sha, merge);
  const absent = await get('/api/review-scope?' + new URLSearchParams({mode:'history',author:JSON.stringify(['Missing','missing@example.invalid'])}));
  assert.equal(absent.total, 0); assert.deepEqual((await get(`/api/commits?scope=${absent.id}`)).commits, []);
  assert.equal((await request('/api/review-scope?author=invalid')).status, 400);
  assert.equal((await request('/api/review-scope?author=%5B1,2%5D')).status, 400);
});
