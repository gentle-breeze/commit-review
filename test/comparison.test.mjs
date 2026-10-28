import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {GitRepo} from '../lib/git.mjs';
import {createApp} from '../server.mjs';

async function fixture(t, initial='base\n') {
  const root=await mkdtemp(path.join(os.tmpdir(),'review-compose-test-')),dir=path.join(root,'repo');
  await mkdir(dir); t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
  git('init','-b','main');git('config','user.name','Alice');git('config','user.email','alice@example.invalid');git('config','commit.gpgsign','false');
  const put=(name,text)=>writeFile(path.join(dir,name),text);
  const commit=message=>{git('add','-A');git('commit','--allow-empty','-m',message);return git('rev-parse','HEAD');};
  await put('file.txt',initial);commit('Base');git('switch','-c','feature');
  const repo=await GitRepo.open(dir);
  const scope=async author=>repo.authorScope(await repo.reviewScope('feature',{mode:'compare',base:'main'}),author||'');
  const compare=async (hidden=[],showHidden=false,author='')=>repo.comparison(await scope(author),{hidden,showHidden});
  const content=async (diff,name='file.txt')=>{
    const file=diff.files.find(file=>file.path===name);assert.ok(file,`missing ${name}`);
    return repo.file(diff,file.id);
  };
  return {root,dir,git,put,commit,repo,scope,compare,content};
}

test('exclude actual aaa change, including adjacent insertion and hidden first/middle/last/all',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','base\naaa\n');const a=f.commit('aaa');
  await f.put('file.txt','base\naaa\nbbb\n');const b=f.commit('bbb');
  await f.put('file.txt','base\naaa\nbbb\nccc\n');const c=f.commit('ccc');
  for(const [hidden,expected] of [[[a],'base\nbbb\nccc\n'],[[b],'base\naaa\nccc\n'],[[c],'base\naaa\nbbb\n'],[[a,c],'base\nbbb\n']]){
    const diff=await f.compare(hidden),file=await f.content(diff);
    assert.equal(file.old.text,'base\n');assert.equal(file.new.text,expected);
    assert.equal(diff.files[0].additions,expected.split('\n').length-2);assert.equal(diff.files[0].deletions,0);
  }
  assert.deepEqual((await f.compare([a,b,c])).files,[]);
  assert.equal((await f.content(await f.compare([b],true))).new.text,'base\nbbb\n');
  assert.deepEqual((await f.compare([],true)).files,[]);
});

test('hidden creation can retain a later independent inserted line without aaa or touching repository state',async t=>{
  const f=await fixture(t);
  await f.put('new.txt','aaa\n');const a=f.commit('Create aaa');
  await f.put('new.txt','aaa\nbbb\n');f.commit('Append bbb');
  await f.put('staged.txt','user staging\n');f.git('add','staged.txt');await f.put('file.txt','user dirty buffer\n');
  const before={index:await readFile(path.join(f.dir,'.git/index')),refs:f.git('show-ref'),status:f.git('status','--porcelain'),objects:f.git('count-objects','-v')};
  const diff=await f.compare([a]),file=await f.content(diff,'new.txt');
  assert.equal(file.old.exists,false);assert.equal(file.new.text,'bbb\n');assert.equal(diff.files[0].status,'A');
  assert.deepEqual(await readFile(path.join(f.dir,'.git/index')),before.index);
  assert.equal(f.git('show-ref'),before.refs);assert.equal(f.git('status','--porcelain'),before.status);assert.equal(f.git('count-objects','-v'),before.objects);
  assert.equal(await readFile(path.join(f.dir,'file.txt'),'utf8'),'user dirty buffer\n');
});

test('same-line dependency and dependent deletion fail explicitly, never restore excluded lines',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','aaa\n');const a=f.commit('Replace base');
  await f.put('file.txt','bbb\n');f.commit('Replace aaa');
  await assert.rejects(f.compare([a]),/无法组合.*file.txt.*依赖已排除的行/);
  f.git('rm','file.txt');const deletion=f.commit('Delete');
  await assert.rejects(f.compare([a,deletion]),/依赖已排除的行/);
});

test('author and hidden mode intersect selected commits, not merely touched paths',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','base\naaa\n');const a=f.commit('Alice aaa');
  f.git('config','user.name','Bob');f.git('config','user.email','bob@example.invalid');
  await f.put('file.txt','base\naaa\nbbb\n');const b=f.commit('Bob bbb');
  const bob=JSON.stringify(['Bob','bob@example.invalid']);
  assert.equal((await f.content(await f.compare([],false,bob))).new.text,'base\nbbb\n');
  assert.deepEqual((await f.compare([b],false,bob)).files,[]);
  assert.equal((await f.content(await f.compare([b],true,bob))).new.text,'base\nbbb\n');
  assert.deepEqual((await f.compare([a],true,bob)).files,[]);
});

test('selected revert cancels selected change; hidden delete, rename and visible rename preserve identities',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','change\n');f.commit('Change');
  await f.put('ignored.txt','hidden\n');const ignored=f.commit('Ignored');
  await f.put('file.txt','base\n');f.commit('Revert');
  assert.deepEqual((await f.compare([ignored])).files,[]);
  f.git('mv','file.txt','renamed.txt');const rename=f.commit('Rename');
  await f.put('renamed.txt','base\nbbb\n');f.commit('Append');
  const hiddenRename=await f.compare([ignored,rename]);
  assert.equal((await f.content(hiddenRename)).new.text,'base\nbbb\n');
  assert.ok(!hiddenRename.files.some(file=>file.path==='renamed.txt'));
  const visibleRename=await f.compare([ignored]);
  assert.equal(visibleRename.files[0].oldPath,'file.txt');assert.equal(visibleRename.files[0].path,'renamed.txt');assert.equal(visibleRename.files[0].status,'R');
  f.git('rm','renamed.txt');const deletion=f.commit('Delete');
  assert.equal((await f.compare([ignored])).files[0].status,'D');
  assert.equal((await f.content(await f.compare([ignored,deletion]),'renamed.txt')).new.text,'base\nbbb\n');
});

test('retained file after excluded deletion cannot be silently overwritten by a later creation',async t=>{
  const f=await fixture(t);
  f.git('rm','file.txt');const deletion=f.commit('Delete');
  await f.put('file.txt','replacement\n');f.commit('Recreate');
  await assert.rejects(f.compare([deletion]),/目标路径与保留的文件冲突/);
});

test('composition IDs isolate hidden selections and project sessions; commit anchors remain real parent content',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','base\naaa\n');const a=f.commit('aaa');
  await f.put('file.txt','base\naaa\nbbb\n');const b=f.commit('bbb');
  const app=await createApp({repoPath:f.dir,dataDir:path.join(f.root,'data')});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));await app.release();});
  const url=`http://127.0.0.1:${app.server.address().port}`,info=await(await fetch(url+'/api/info')).json();
  const headers={'X-Review-Token':info.token,'X-Review-Project':info.projectId,'Content-Type':'application/json'};
  const request=async(route,body,custom=headers)=>{
    const response=await fetch(url+route,{method:body?'POST':'GET',headers:custom,...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  };
  const scope=(await request('/api/review-scope?mode=compare&ref=feature&base=main')).data;
  const [first,second]=await Promise.all([request('/api/comparison',{scope:scope.id,hidden:[a]}),request('/api/comparison',{scope:scope.id,hidden:[b]})]);
  assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.data.comparisonId,second.data.comparisonId);
  const fileRoute=diff=>`/api/comparison-file?comparison=${diff.comparisonId}&fileId=0`;
  assert.equal((await request(fileRoute(first.data))).data.new.text,'base\nbbb\n');
  assert.equal((await request(fileRoute(second.data))).data.new.text,'base\naaa\n');
  assert.equal((await request('/api/comparison',{scope:scope.id,hidden:[a]})).data.comparisonId,first.data.comparisonId);
  assert.equal((await request('/api/comparison',{scope:scope.id,hidden:['bad']})).status,400);
  assert.equal((await request(fileRoute(first.data),undefined,{...headers,'X-Review-Project':'f'.repeat(20)})).status,403);
  const comment=await request('/api/comments',{sha:b,anchor:{fileId:'0',side:'old',startLine:2,endLine:2},body:'Real parent aaa'});
  assert.equal(comment.status,201);assert.equal(comment.data.code,'aaa');
  const allHidden=await request('/api/comparison',{scope:scope.id,hidden:[a,b]});assert.deepEqual(allHidden.data.files,[]);
  assert.equal((await request(fileRoute(first.data))).data.new.text,'base\nbbb\n','immutable old selection remains readable');
});

test('duplicate lines retain provenance; CRLF and missing final newline do not reintroduce excluded additions',async t=>{
  for (const newline of ['\n','\r\n']) {
    const f=await fixture(t,`start${newline}duplicate${newline}end${newline}`);
    await f.put('file.txt',`start${newline}duplicate${newline}duplicate${newline}end${newline}`);const hidden=f.commit('Add duplicate');
    await f.put('file.txt',`start${newline}duplicate${newline}duplicate${newline}end${newline}bbb`);f.commit('Append without final newline');
    const diff=await f.compare([hidden]),file=await f.content(diff);
    assert.equal(file.new.text,'start\nduplicate\nend\nbbb');assert.equal(diff.files[0].additions,1);assert.equal(diff.files[0].deletions,0);
  }
});

test('adding a newline to an excluded unterminated line is a real dependency, not a context-only insertion',async t=>{
  const f=await fixture(t);
  await f.put('file.txt','base\naaa');const hidden=f.commit('Unterminated aaa');
  await f.put('file.txt','base\naaa\nbbb\n');f.commit('Terminate aaa and add bbb');
  await assert.rejects(f.compare([hidden]),/依赖已排除的行/);
});

test('copy is an explicit new-file addition; excluded binary replacements and ambiguous anchors reject dependencies',async t=>{
  const f=await fixture(t,'first\nmiddle\nlast\n');
  await f.put('ignored.txt','aaa\n');const hidden=f.commit('Unrelated hidden');
  await f.put('copy.txt','first\nmiddle\nlast\n');f.commit('Copy base file');
  assert.equal((await f.content(await f.compare([hidden]),'copy.txt')).new.text,'first\nmiddle\nlast\n');
  await f.put('file.txt','first\nlast\n');const deletion=f.commit('Remove middle');
  await f.put('file.txt','first\nbbb\nlast\n');f.commit('Insert at removed position');
  await assert.rejects(f.compare([hidden,deletion]),/无法唯一定位/);
  const binary=await fixture(t);
  await binary.put('asset.bin',Buffer.from([0,1]));binary.commit('Binary base');binary.git('branch','-f','main','HEAD');
  await binary.put('asset.bin',Buffer.from([0,2]));const replace=binary.commit('Hidden binary replacement');
  await binary.put('asset.bin',Buffer.from([0,3]));binary.commit('Visible binary replacement');
  await assert.rejects(binary.compare([replace]),/二进制.*依赖已排除的版本/);
});

test('merge changes use first-parent delta; author filters exclude merge and dependent followups fail',async t=>{
  const f=await fixture(t);
  f.git('switch','-c','side','main');await f.put('side.txt','side\n');f.commit('Side change');
  f.git('switch','feature');await f.put('file.txt','base\naaa\n');const a=f.commit('Mainline aaa');
  f.git('merge','--no-ff','side','-m','Merge side');const merge=f.git('rev-parse','HEAD');
  const diff=await f.compare([a]);assert.deepEqual(diff.files.map(file=>file.path),['side.txt']);
  assert.equal((await f.content(diff,'side.txt')).new.text,'side\n');
  const alice=JSON.stringify(['Alice','alice@example.invalid']);
  assert.equal((await f.content(await f.compare([],false,alice))).new.text,'base\naaa\n');
  await f.put('side.txt','edited side\n');f.commit('Edit merge-introduced line');
  await assert.rejects(f.compare([merge]),/依赖已排除的行/);
});

test('non-first-parent merge base fails rather than composing against a different baseline',async t=>{
  const f=await fixture(t);
  f.git('switch','main');await f.put('main-only.txt','main\n');f.commit('Advance base');
  f.git('switch','feature');await f.put('feature-only.txt','feature\n');const own=f.commit('Feature');
  f.git('merge','--no-ff','main','-m','Merge newer base');
  await assert.rejects(f.compare([own]),/不是连续的第一父提交链/);
});

test('selected delete/recreate is one net path; unchanged recreated content cancels; UTF-8 BOM is preserved',async t=>{
  const f=await fixture(t);
  await f.put('ignored.txt','hidden\n');const hidden=f.commit('Hidden unrelated file');
  f.git('rm','file.txt');f.commit('Delete');
  await f.put('file.txt','replacement\n');f.commit('Recreate');
  const diff=await f.compare([hidden]);assert.equal(diff.files.length,1);assert.equal(diff.files[0].status,'M');
  assert.equal((await f.content(diff)).old.text,'base\n');assert.equal((await f.content(diff)).new.text,'replacement\n');
  await f.put('file.txt','base\n');f.commit('Restore original');
  assert.deepEqual((await f.compare([hidden])).files,[]);
  const bom=await fixture(t,'\uFEFFbase\n');
  await bom.put('file.txt','\uFEFFbase\naaa\n');const a=bom.commit('Hidden aaa');
  await bom.put('file.txt','\uFEFFbase\naaa\nbbb\n');bom.commit('Visible bbb');
  assert.equal((await bom.content(await bom.compare([a]))).new.text,'\uFEFFbase\nbbb\n');
});
