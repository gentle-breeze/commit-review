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
  await writeFile(path.join(a,'example.js'),'export const value = 1;\n'); git(a,'add','.'); git(a,'commit','-m','Shared commit');
  git(root,'clone','--no-hardlinks',a,b); git(b,'branch','main','HEAD~1'); git(b,'branch','--unset-upstream');
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
  const tabs=await Promise.all([tab(),tab()]);
  await Promise.all(tabs.map(async (t,i)=>{
    await t.cdp('Page.navigate',{url:base+'/?picker=1'}); await t.wait('document.querySelector("#project-path")?.options.length===3');
    await t.evaluate(`document.querySelector('#project-path').value=${JSON.stringify(repos[i])}; document.querySelector('#project-path').dispatchEvent(new Event('change'));document.querySelector('#project-form').requestSubmit()`);
    await t.wait('document.querySelector("#commits .commit") && document.querySelector(".monaco-editor")');
    assert.equal(await t.evaluate('new URL(location.href).searchParams.get("repo")'),repos[i]);
  }));
  // Execute concurrent requests from independent browser contexts and verify each saved store.
  await Promise.all(tabs.map(async(t,i)=>{
    const result=await t.evaluate(`(async()=>{const boot=await (await fetch('/api/info')).json(); const session=await (await fetch('/api/repository',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':boot.token},body:JSON.stringify({repository:new URL(location.href).searchParams.get('repo')})})).json();window.testSession=session;const headers={'Content-Type':'application/json','X-Review-Token':session.token,'X-Review-Project':session.projectId};const sha=document.querySelector('#commits .commit').dataset.commitSha;const diff=await (await fetch('/api/diff?sha='+sha,{headers})).json();const r=await fetch('/api/comments',{method:'POST',headers,body:JSON.stringify({sha,anchor:{fileId:diff.files[0].id,side:'new',startLine:1,endLine:1},body:'tab ${i}'})});return {status:r.status,comment:await r.json()};})()`);
    assert.equal(result.status,201); assert.equal(result.comment.body,`tab ${i}`);
    await t.evaluate('document.querySelector("#refresh").click()');await t.wait('!document.querySelector("#refresh").disabled');
    assert.equal(await t.evaluate('document.querySelector("#comments").textContent.includes("tab '+i+'")'),true);
    assert.equal(await t.evaluate('document.querySelector("#comments").textContent.includes("tab '+(1-i)+'")'),false);
  }));
  const [ta,tb]=tabs;
  // Hold B's session lookup during refresh; user writes must keep B's credentials,
  // even though /api/info returns the fixed default A.
  await tb.evaluate(`window.originalFetch=window.fetch;window.refreshHeld=false;window.fetch=async (url,options)=>{if(url==='/api/repository'){window.refreshHeld=true;await new Promise(resolve=>window.releaseRefresh=resolve);}return window.originalFetch(url,options);};document.querySelector('#refresh').click()`);
  await tb.wait('window.refreshHeld');
  await tb.evaluate(`Array.from(document.querySelectorAll('#comments button')).find(n=>n.textContent==='回复').click();document.querySelector('#reply-body').value='reply during refresh';document.querySelector('#reply-form').requestSubmit()`);
  await tb.wait('!document.querySelector("#reply-dialog").open');
  await tb.evaluate('window.fetch=window.originalFetch;window.releaseRefresh()');
  await tb.wait('!document.querySelector("#refresh").disabled');
  assert.equal(await tb.evaluate('document.querySelector("#comments").textContent.includes("reply during refresh")'),true);
  await ta.evaluate('document.querySelector("#refresh").click()');await ta.wait('!document.querySelector("#refresh").disabled');
  assert.equal(await ta.evaluate('document.querySelector("#comments").textContent.includes("reply during refresh")'),false);

  await ta.evaluate('document.querySelector("#commits input[type=checkbox]").click();document.querySelector("#hide-commits").click()');
  await ta.wait('document.querySelectorAll("#commits .commit").length===0');
  assert.equal(await tb.evaluate('document.querySelectorAll("#commits .commit").length'),1,'same SHA in other repository remains visible');
  await Promise.all(tabs.map(t=>t.cdp('Page.reload')));
  await ta.wait('document.querySelector("#project-picker")?.hidden && document.querySelector("#repository").textContent.includes("/A")');
  await tb.wait('document.querySelector("#commits .commit") && document.querySelector("#repository").textContent.includes("/B")');
  assert.equal(await ta.evaluate('document.querySelectorAll("#commits .commit").length'),0,'hidden state survives reload only in A');
  await ta.evaluate('document.querySelector("a.project-link").click()');await ta.wait('document.querySelector("#project-picker")?.hidden===false && document.querySelector("#project-path").options.length===3');
  await ta.evaluate(`document.querySelector('#project-path').value=${JSON.stringify(repos[1])};document.querySelector('#project-path').dispatchEvent(new Event('change'));document.querySelector('#project-form').requestSubmit()`);
  await ta.wait('document.querySelector("#repository")?.textContent.includes("/B") && document.querySelector("#commits .commit")');
  assert.equal(await tb.evaluate('new URL(location.href).searchParams.get("repo")'),repos[1]);
  await ta.wait('document.querySelector("#comments").textContent.includes("tab 1")');
  await ta.cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(path.join(root,'missing'))});
  await ta.wait('document.querySelector("#project-picker")?.hidden===false && document.body.textContent.includes("无法打开此标签页")');
  assert.equal(await ta.evaluate('document.querySelector(".workspace").hidden'),true);
  assert.equal(await tb.evaluate('document.querySelector("#repository").textContent'),repos[1]);
  await tb.cdp('Page.bringToFront');
  const screenshot=await tb.cdp('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/commit-review-multitab.png',Buffer.from(screenshot.data,'base64'));
  for(const t of tabs)assert.deepEqual(t.errors,[]);
  console.log('Multi-tab browser passed: concurrent selection/writes, isolated comments and same-SHA hiding, reload, switch, invalid path. Screenshot: /tmp/commit-review-multitab.png');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
