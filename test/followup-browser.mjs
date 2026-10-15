import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'review-multitab-'));
let app, chrome; const sockets = [];
try {
  const projects = path.join(root, 'projects'); await mkdir(projects);
  const a = path.join(projects, 'A'), b = path.join(projects, 'B'); await mkdir(a);
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8',stdio:'pipe'}).trim();
  git(a,'init','-b','main'); git(a,'config','user.name','Browser Test'); git(a,'config','user.email','test@example.invalid');
  git(a,'commit','--allow-empty','-m','Base'); git(a,'checkout','-b','feature');
  await writeFile(path.join(a,'example.js'),'bug\ncontext\nbug\n');git(a,'add','.');git(a,'commit','-m','Original');const original=git(a,'rev-parse','HEAD');
  await writeFile(path.join(a,'example.js'),'prefix\nbug\ncontext\nbug\n');git(a,'add','.');git(a,'commit','--amend','-m','Amended');const amended=git(a,'rev-parse','HEAD');
  git(root,'clone','--no-hardlinks',a,b);git(b,'branch','main','HEAD~1');git(b,'branch','--unset-upstream');
  const repos = [await realpath(a), await realpath(b)];
  for(let i=0;i<55;i++)git(a,'commit','--allow-empty','-m',`Extra ${i}`);
  const latest=git(a,'rev-parse','HEAD');
  app = await createApp({repoPath:a,projectsDir:projects,dataDir:path.join(root,'data')});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  const profile = path.join(root,'chrome');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  let port; for(let i=0;i<100;i++){try {port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{} await delay(100);}
  assert.ok(port);
  async function tab(){
    const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    const socket=new WebSocket(target.webSocketDebuggerUrl); sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let id=0; const pending=new Map(), errors=[];
    socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.exceptionThrown')errors.push(data.params);if(pending.has(data.id)){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(new Error(data.error.message)):p.resolve(data.result);}});
    const rawCdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(n,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id:n,method,params}));});
    const cdp=async(method,params={})=>{
      if(!['Page.reload','Page.navigate'].includes(method))return rawCdp(method,params);
      const previous=await rawCdp('Runtime.evaluate',{expression:'performance.timeOrigin',returnByValue:true});
      const result=await rawCdp(method,params);
      for(let i=0;i<100;i++){
        try{
          const current=await rawCdp('Runtime.evaluate',{expression:'({origin:performance.timeOrigin,ready:document.readyState})',returnByValue:true});
          if(current.result.value?.origin!==previous.result.value&&current.result.value?.ready==='complete')return result;
        }catch{}
        await delay(100);
      }
      throw new Error(`Navigation did not complete: ${method}`);
    };
    const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw new Error(`Timed out: ${expression}`);};
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    return {cdp,evaluate,wait,errors};
  }
  const info=await(await fetch(base+'/api/info')).json();const headers={'Content-Type':'application/json','X-Review-Token':info.token,'X-Review-Project':info.projectId};
  const added=await fetch(base+'/api/comments',{method:'POST',headers,body:JSON.stringify({sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Check bug behavior'})});assert.equal(added.status,201);const comment=await added.json();
  await app.store.link(comment.id,{revision:0,requestId:crypto.randomUUID(),target:{sha:original,path:'example.js',startLine:1,endLine:1,code:'bug'}});
  const t=await tab(),{cdp,evaluate,wait}=t;await cdp('Page.navigate',{url:base});await wait('document.querySelectorAll("#commits .commit").length===50');
  await evaluate('document.querySelector("#toggle-comments").click();document.querySelector("#comment-scope").value="all";document.querySelector("#comment-scope").dispatchEvent(new Event("change"))');await wait('document.querySelector(".followup-comment")');
  const open=async()=>{await evaluate('document.querySelector(".followup-comment").click()');await wait('!document.querySelector("#followup-save").disabled')},close=()=>evaluate('document.querySelector("#followup-close").click()');
  const select=sha=>evaluate(`document.querySelector('#followup-options input[value="${sha}"]').click()`);
  await open();assert.equal(await evaluate('document.querySelectorAll("#followup-options input").length'),56);assert.equal(await evaluate('document.querySelectorAll("#commits .commit").length'),56);assert.match(await evaluate('document.querySelector("#followup-error").textContent'),/范围外/);assert.equal(await evaluate('document.querySelector("#followup-ref")'),null);
  await select(amended);await close();assert.equal(app.store.list()[0].linkRevision,1,'cancel does not save');
  await open();await select(amended);await select(latest);
  await evaluate(`window.savedFetch=window.fetch;window.linkRequests=0;window.fetch=async(url,opts)=>{if(String(url).endsWith('/associations')){window.linkRequests++;await new Promise(r=>window.releaseSave=r);}return window.savedFetch(url,opts)};document.querySelector('#followup-save').click();document.querySelector('#followup-save').click();document.querySelector('#followup-close').click()`);
  await wait('window.linkRequests===1');assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),true);assert.equal(await evaluate('document.querySelector("#followup-close").disabled'),true);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),true);
  await evaluate('window.fetch=window.savedFetch;window.releaseSave()');await wait('!document.querySelector("#followup-dialog").open');
  const saved=app.store.list()[0];assert.equal(saved.followups.length,3);assert.ok(saved.followups[0].removedAt);assert.equal(saved.followups[0].code,'bug');assert.equal(saved.resolved,false);
  assert.equal(await evaluate('document.querySelectorAll("#commits .associated-current").length'),2);
  await evaluate('document.querySelector(".comment-body-link").click()');await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(latest)}`);assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),false);
  await open();assert.equal(await evaluate('document.querySelector("#followup-links").parentElement.open'),false);assert.match(await evaluate('document.querySelector("#followup-links").textContent'),/历史关联/);await close();
  await evaluate(`window.fetch=async(url,opts)=>{if(String(url).includes('/association-scope?')){window.held=true;await new Promise(r=>window.releaseScope=r);}return window.savedFetch(url,opts)};document.querySelector('.followup-comment').click()`);await wait('window.held');await close();await evaluate('window.fetch=window.savedFetch');await open();await select(latest);await evaluate('window.releaseScope()');await delay(150);assert.equal(await evaluate(`document.querySelector('#followup-options input[value="${latest}"]').checked`),false,'old scope response cannot replace a new draft');await close();
  await open();await cdp('Page.bringToFront');await writeFile('/tmp/commit-review-simple-associations.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));await close();
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  // Background commits do not change the fixed candidate set or reject an existing draft.
  await evaluate(`window.scopeIds=[];window.fetch=async(url,opts)=>{if(String(url).includes('/association-scope?'))window.scopeIds.push(new URL(url,location.origin).searchParams.get('id'));return window.savedFetch(url,opts)}`);
  await open();
  const frozenScope=await evaluate('window.scopeIds.at(-1)'),frozenCandidates=await evaluate('[...document.querySelectorAll("#followup-options input")].map(n=>n.value)');
  assert.match(frozenScope,/^[a-f0-9]{64}$/);assert.equal(frozenCandidates.length,56);
  git(a,'commit','--allow-empty','-m','Range changed');const advanced=git(a,'rev-parse','HEAD');
  assert.equal(await evaluate(`!!document.querySelector('#followup-options input[value="${advanced}"]')`),false);
  await select(latest);await evaluate('document.querySelector("#followup-save").click()');await wait('!document.querySelector("#followup-dialog").open');
  assert.equal(app.store.list()[0].linkRevision,3);assert.deepEqual(app.store.list()[0].followups.filter(link=>!link.removedAt).map(link=>link.sha),[amended]);
  assert.ok(app.store.list()[0].followups.find(link=>link.sha===latest).removedAt,'saving frozen candidates preserves removed association history');
  await open();assert.equal(await evaluate('window.scopeIds.at(-1)'),frozenScope);assert.deepEqual(await evaluate('[...document.querySelectorAll("#followup-options input")].map(n=>n.value)'),frozenCandidates);await close();
  await evaluate('document.querySelector("#refresh").click()');await wait('!document.querySelector("#refresh").disabled');
  assert.equal(await evaluate('document.querySelector("#commits .commit").dataset.commitSha'),advanced);
  await open();assert.notEqual(await evaluate('window.scopeIds.at(-1)'),frozenScope,'explicit refresh creates a new range ID');
  assert.equal(await evaluate('document.querySelectorAll("#followup-options input").length'),57);
  assert.equal(await evaluate(`!!document.querySelector('#followup-options input[value="${advanced}"]')`),true,'new commit enters candidates only after refresh');
  const oldScope=await(await fetch(base+'/api/association-scope?id='+frozenScope,{headers})).json();
  assert.deepEqual(oldScope.commits.map(commit=>commit.sha),frozenCandidates,'refresh does not mutate the previous snapshot');
  await close();await evaluate('window.fetch=window.savedFetch');
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(repos[1])});await wait('document.querySelector("#repository").textContent.includes("B")');
  assert.equal(app.store.list()[0].linkRevision,3,'other project did not mutate A');
  assert.deepEqual(t.errors,[]);console.log('Simple association browser passed: full pagination, one save/cancel, preserved legacy history, left-list markers, stale reads, frozen candidates and explicit refresh, mobile layout and project isolation.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
