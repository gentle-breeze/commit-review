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
  const t=await tab(),{cdp,evaluate,wait}=t;await cdp('Page.navigate',{url:base});await wait('document.querySelector(".monaco-editor")');
  await evaluate('document.querySelector("#toggle-comments").click();document.querySelector("#comment-scope").value="all";document.querySelector("#comment-scope").dispatchEvent(new Event("change"))');await wait('document.querySelector(".followup-comment")');
  const open=()=>evaluate('document.querySelector(".followup-comment").click()');const close=()=>evaluate('document.querySelector("#followup-close").click()');
  await open();assert.match(await evaluate('document.querySelector("#followup-original").textContent'),new RegExp(original));
  await evaluate('document.querySelector("#followup-preview").click()');await wait('!document.querySelector("#followup-save").disabled');assert.equal(await evaluate('document.querySelectorAll("#followup-candidates button").length'),2);
  await evaluate('document.querySelectorAll("#followup-candidates button")[1].click()');assert.equal(await evaluate('document.querySelector("#followup-start").value'),'4');
  await evaluate(`window.savedFetch=window.fetch;window.linkRequests=0;window.fetch=async(url,opts)=>{if(String(url).endsWith('/links')){window.linkRequests++;await new Promise(r=>window.releaseSave=r);}return window.savedFetch(url,opts)};document.querySelector('#followup-save').click();document.querySelector('#followup-save').click();document.querySelector('#followup-close').click()`);
  await wait('window.linkRequests===1');assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),true);assert.equal(await evaluate('document.querySelector("#followup-close").disabled'),true);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),true);
  await evaluate('window.fetch=window.savedFetch;window.releaseSave()');await wait('document.querySelector("#followup-error").textContent.includes("关联已保存")');assert.equal(app.store.list()[0].followups.length,1);assert.equal(app.store.list()[0].followups[0].startLine,4);assert.equal(app.store.list()[0].resolved,false);await close();
  await evaluate('document.querySelector("#comment-scope").value="commit";document.querySelector("#comment-scope").dispatchEvent(new Event("change"))');assert.equal(await evaluate('document.querySelectorAll(".comment-card").length'),1,'linked original remains visible in rewritten commit');
  await evaluate('document.querySelector(".comment-body-link").click()');await wait('document.querySelector("#followup-dialog").open && !document.querySelector("#followup-save").disabled');assert.match(await evaluate('document.querySelector("#followup-target-sha").textContent'),new RegExp(amended));await close();
  await evaluate(`window.fetch=async(url,opts)=>String(url).includes('/target?')?new Response(JSON.stringify({error:'目标对象已不可读'}),{status:400,headers:{'Content-Type':'application/json'}}):window.savedFetch(url,opts);document.querySelector('.comment-body-link').click()`);await wait('document.querySelector("#followup-error").textContent.includes("仅显示关联时保存的片段")');assert.equal(await evaluate('document.querySelector("#followup-target").textContent'),'bug');assert.equal(await evaluate('document.querySelector("#followup-save").disabled'),true);await evaluate('window.fetch=window.savedFetch');await close();
  await open();await evaluate(`window.fetch=async(url,opts)=>{if(String(url).includes('/target?')){window.held=true;await new Promise(r=>window.releasePreview=r);}return window.savedFetch(url,opts)};document.querySelector('#followup-preview').click()`);await wait('window.held');await close();await open();await evaluate('window.fetch=window.savedFetch;window.releasePreview()');await delay(100);assert.equal(await evaluate('document.querySelector("#followup-save").disabled'),true,'closed preview cannot enable saving in reopened dialog');
  await evaluate('document.querySelector("#followup-path").value="missing.txt";document.querySelector("#followup-path").dispatchEvent(new Event("input"));document.querySelector("#followup-preview").click()');await wait('document.querySelector("#followup-error").textContent!=="读取中…"');assert.equal(await evaluate('document.querySelector("#followup-save").disabled'),true);
  await evaluate('document.querySelector("#followup-path").value="example.js";document.querySelector("#followup-path").dispatchEvent(new Event("input"));document.querySelector("#followup-preview").click()');await wait('!document.querySelector("#followup-save").disabled');
  await cdp('Page.bringToFront');await writeFile('/tmp/commit-review-followups.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));await writeFile('/tmp/commit-review-followups-mobile.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('Array.from(document.querySelectorAll("#followup-links button")).find(b=>b.textContent==="移除此关联").click()');await wait('document.querySelector("#followup-links").textContent.includes("已移除")');assert.ok(app.store.list()[0].followups[0].removedAt);assert.equal(app.store.list()[0].sha,original);assert.equal(app.store.list()[0].resolved,false);await close();assert.equal(await evaluate('document.querySelectorAll(".comment-card").length'),0);
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(repos[1])});await wait('document.querySelector("#repository").textContent.includes("/B") && document.querySelector(".monaco-editor")');await evaluate('document.querySelector("#comment-scope").value="all";document.querySelector("#comment-scope").dispatchEvent(new Event("change"))');assert.equal(await evaluate('document.querySelectorAll(".comment-card").length'),0);
  assert.deepEqual(t.errors,[]);console.log('Followup browser passed: ambiguous candidates, manual selection, duplicate save, cancellation, stale preview, removal audit, rewritten-commit visibility and project isolation.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
