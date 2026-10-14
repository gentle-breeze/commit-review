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
  await writeFile(path.join(a,'old.txt'),'alpha\nbeta\n');git(a,'add','.');git(a,'commit','-m','Original');
  const original=git(a,'rev-parse','HEAD');git(a,'mv','old.txt','renamed.txt');git(a,'commit','-m','Rename');
  await writeFile(path.join(a,'FooTest.js'),'test\n');git(a,'add','.');git(a,'commit','-m','Test file');
  for(let i=0;i<51;i++)git(a,'commit','--allow-empty','-m',`Empty ${i}`);
  for(let i=0;i<305;i++)await writeFile(path.join(a,`f${String(i).padStart(3,'0')}.txt`),`file ${i}\n`);
  git(a,'add','.');git(a,'commit','-m','Large');const large=git(a,'rev-parse','HEAD');
  await mkdir(b);git(b,'init','-b','main');git(b,'config','user.name','Browser Test');git(b,'config','user.email','test@example.invalid');git(b,'commit','--allow-empty','-m','Base');git(b,'checkout','-b','feature');await writeFile(path.join(b,'B-only.txt'),'B\n');git(b,'add','.');git(b,'commit','-m','B only');
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
  const t=await tab(),{cdp,evaluate,wait}=t;
  await cdp('Page.navigate',{url:base});await wait('document.querySelectorAll("#commits .commit").length===50 && document.querySelector(".monaco-editor")');
  assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),true);
  await evaluate('document.querySelector("#skip-test-files").click()');
  const info=await(await fetch(base+'/api/info')).json();
  const response=await fetch(base+'/api/comments',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':info.token,'X-Review-Project':info.projectId},body:JSON.stringify({sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Original discussion'})});assert.equal(response.status,201);
  const open=async()=>{await evaluate('document.querySelector("#open-file-index").click()');await wait('document.querySelector("#index-progress").textContent.includes("索引完成")');};
  const search=async value=>evaluate(`document.querySelector('#index-search').value=${JSON.stringify(value)};document.querySelector('#index-search').dispatchEvent(new Event('input'))`);
  const close=()=>evaluate('document.querySelector("#close-file-index").click()');
  await open();assert.match(await evaluate('document.querySelector("#index-scope").textContent'),/55 条主线提交/);
  assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),100);
  await search('old.txt');assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),1);assert.equal(await evaluate('document.querySelectorAll(".index-change").length'),2);
  assert.match(await evaluate('document.querySelector("#index-history").textContent'),/重命名 R100/);
  assert.match(await evaluate('document.querySelector("#index-history").textContent'),/Original discussion/);
  await evaluate('document.querySelectorAll(".index-change")[1].querySelector("details").open=true;document.querySelectorAll(".index-change")[1].querySelector("details button").click()');
  await wait('!document.querySelector("#file-index-dialog").open && document.querySelector("#comment-commit").textContent.includes("文件索引关联提交") && document.querySelector(".monaco-editor")');
  assert.equal(await evaluate('document.querySelector(".file-link.active").textContent.includes("old.txt")'),true);
  await open();await search('f304.txt');await evaluate('document.querySelector(".index-change > button").click()');
  await wait('document.querySelector(".file-link.active")?.textContent.includes("f304.txt") && document.querySelector(".monaco-editor")');
  assert.match(await evaluate('document.querySelector("#commit-detail").textContent'),/仅显示索引选中的文件/);
  assert.equal(await evaluate('document.querySelector(".font-reset").textContent'),'17px');
  await open();await search('FooTest');assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),1);await close();
  await evaluate('document.querySelector("#skip-test-files").click()');await open();assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),0);await close();
  await evaluate('document.querySelector("#skip-test-files").click();document.querySelector("#commits input[type=checkbox]").click();document.querySelector("#hide-commits").click()');
  await open();await search('f304');assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),0);await close();
  await evaluate('document.querySelector("#show-hidden").click()');await open();assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),1);
  await search('');await cdp('Page.bringToFront');await writeFile('/tmp/commit-review-index-desktop.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await writeFile('/tmp/commit-review-index-mobile.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no page horizontal overflow');await close();
  await evaluate(`window.originalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/api/file-index')){window.held=true;await new Promise(r=>window.releaseIndex=r);}return window.originalFetch(...args)};document.querySelector('#open-file-index').click()`);await wait('window.held');
  await evaluate(`document.querySelector('#branch').value='refs/heads/main';document.querySelector('#branch').dispatchEvent(new Event('change'));window.fetch=window.originalFetch;window.releaseIndex()`);
  await wait('!document.querySelector("#file-index-dialog").open');await delay(250);await open();assert.match(await evaluate('document.querySelector("#index-scope").textContent'),/0 条主线提交/);assert.equal(await evaluate('document.querySelectorAll(".index-file").length'),0);
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(repos[1])});await wait('document.querySelector("#repository").textContent.includes("/B") && document.querySelector(".monaco-editor")');await open();assert.match(await evaluate('document.querySelector("#index-files").textContent'),/B-only/);assert.doesNotMatch(await evaluate('document.querySelector("#index-files").textContent'),/renamed|f304/);
  assert.deepEqual(t.errors,[]);console.log('File index browser passed: full range, rename, comments, >300 target, 17px, filters, stale branch response, project isolation, desktop/mobile screenshots.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
