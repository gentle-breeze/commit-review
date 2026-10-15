import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'review-navigation-'));
let app, chrome; const sockets = [];
try {
  const projects = path.join(root, 'projects'); await mkdir(projects);
  const a = path.join(projects, 'A');await mkdir(a);
  const git=(...args)=>execFileSync('git',['-C',a,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git('init','-b','main');git('config','user.name','Navigation Test');git('config','user.email','test@example.invalid');
  await writeFile(path.join(a,'a.txt'),'base\n');git('add','.');git('commit','-m','Base');git('checkout','-b','feature');
  let order=0;
  const commit=(name,date)=>{git('add','.');execFileSync('git',['-C',a,'commit','--allow-empty','-m',name],{stdio:'pipe',env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:new Date(Date.UTC(2021,0,1,0,0,order++)).toISOString()}});};
  await writeFile(path.join(a,'a.txt'),'middle\n');commit('Middle target','2020-01-02T00:00:00Z');
  for(let i=0;i<51;i++)commit(`Filler ${i}`,'2020-01-01T00:00:00Z');
  await writeFile(path.join(a,'a.txt'),'late\n');commit('Late target','2020-01-03T00:00:00Z');
  await writeFile(path.join(a,'a.txt'),'early\n');commit('Early target','2020-01-01T08:00:00+08:00');
  app=await createApp({repoPath:a,dataDir:path.join(root,'data')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
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
  const t=await tab(),{cdp,evaluate,wait}=t;await cdp('Page.navigate',{url:base});await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 1" && document.querySelectorAll("#commits .commit").length===50');
  const move=direction=>evaluate(`Array.from(document.querySelectorAll('#diff button')).find(b=>b.textContent.includes(${JSON.stringify(direction==='next'?'下一处':'上一处')})).click()`);
  await move('next');await wait('document.querySelector("#commit-detail h2")?.textContent==="Middle target" && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');assert.equal(await evaluate('document.querySelectorAll("#commits .commit").length'),54);assert.equal(await evaluate('document.querySelector("#commits .commit-subject").textContent'),'Early target');
  await move('next');await wait('document.querySelector("#commit-detail h2")?.textContent==="Late target" && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');await move('next');await wait('document.querySelector("#notice").textContent.includes("时间最新")');
  await move('previous');await wait('document.querySelector("#commit-detail h2")?.textContent==="Middle target" && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');await move('previous');await wait('document.querySelector("#commit-detail h2")?.textContent==="Early target" && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await cdp('Page.reload');await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 1" && document.querySelectorAll("#commits .commit").length===50');
  await evaluate(`window.savedFetch=window.fetch;window.held=false;window.fetch=async(url,opts)=>{if(String(url).includes('/api/commits?')){window.held=true;await new Promise(r=>window.release=r);}return window.savedFetch(url,opts)};const b=Array.from(document.querySelectorAll('#diff button')).find(b=>b.textContent.includes('下一处'));b.click();b.click()`);await wait('window.held');await evaluate('document.querySelector("#skip-test-files").click();window.fetch=window.savedFetch;window.release()');await delay(200);assert.equal(await evaluate('document.querySelector("#commit-detail h2").textContent'),'Early target');assert.equal(await evaluate('document.querySelectorAll("#commits .commit").length'),50,'changed filter invalidates pending page');
  await evaluate(`window.held=false;window.fetch=async(url,opts)=>{if(String(url).includes('/api/commits?')){window.heldScope=new URL(url,location.origin).searchParams.get('scope');window.held=true;await new Promise(r=>window.release=r);}return window.savedFetch(url,opts)}`);
  await move('next');await wait('window.held');
  const frozenScope=await evaluate('window.heldScope');assert.match(frozenScope,/^[a-f0-9]{64}$/);
  commit('Range changed','2020-01-04T00:00:00Z');const advanced=git('rev-parse','HEAD');
  await evaluate('window.fetch=window.savedFetch;window.release()');
  await wait('document.querySelector("#commit-detail h2")?.textContent==="Middle target" && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  assert.equal(await evaluate('document.querySelectorAll("#commits .commit").length'),54,'navigation completes the original fixed range');
  assert.equal(await evaluate(`!!document.querySelector('#commits .commit[data-commit-sha="${advanced}"]')`),false,'background commit cannot enter old pagination');
  assert.equal(await evaluate('document.querySelector("#more").hidden'),true);
  await evaluate(`window.refreshedScope=null;window.fetch=async(url,opts)=>{const response=await window.savedFetch(url,opts);if(String(url).startsWith('/api/review-scope?')&&response.ok)window.refreshedScope=await response.clone().json();return response;};document.querySelector('#refresh').click()`);
  await wait('!document.querySelector("#refresh").disabled && window.refreshedScope');
  const refreshed=await evaluate('window.refreshedScope');assert.notEqual(refreshed.id,frozenScope);assert.equal(refreshed.head,advanced);
  assert.equal(await evaluate('document.querySelector("#commits .commit").dataset.commitSha'),advanced,'explicit refresh includes new commit');
  assert.match(await evaluate('document.querySelector("#scope-endpoints").textContent'),new RegExp(advanced.slice(0,8)));
  await evaluate('document.querySelector("#more").click()');await wait('document.querySelectorAll("#commits .commit").length===55 && document.querySelector("#more").hidden');
  await evaluate('window.fetch=window.savedFetch');
  assert.deepEqual(t.errors,[]);console.log('Chronological navigation passed: out-of-order author dates across pagination, timezone ties, stable display, both directions, repeat clicks, stale filters, frozen range and explicit refresh.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
