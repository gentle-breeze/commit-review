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
  await writeFile(path.join(a,'a.txt'),'oldest\n');git('add','.');git('commit','-m','Oldest');
  for(let i=0;i<50;i++)git('commit','--allow-empty','-m',`Page filler ${i}`);
  git('update-index','--chmod=+x','a.txt');git('commit','-m','Mode only');
  await writeFile(path.join(a,'binary.bin'),Buffer.from([0,1,2,3]));git('add','binary.bin');git('commit','-m','Binary');
  git('commit','--allow-empty','-m','Empty newest');git('commit','--allow-empty','-m','Hidden commit');
  await writeFile(path.join(a,'a.txt'),'newest\n');await writeFile(path.join(a,'z.txt'),'last file\n');git('add','a.txt','z.txt');git('commit','-m','Newest','-m','<script>literal</script>\n'+ 'Long body line\n'.repeat(80));
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
  const t = await tab(); const {cdp,evaluate,wait}=t;
  await cdp('Page.bringToFront');
  await cdp('Page.navigate',{url:base});
  await wait('document.querySelector(".change-count")?.textContent==="1 处变更"');
  const next = () => evaluate(`Array.from(document.querySelectorAll('#diff button')).find(n=>n.textContent.includes('下一处')||n.textContent.includes('下一个文件')).click()`);
  const current = () => evaluate('document.querySelector("#commit-detail h2")?.textContent');
  const choose = async subject => {await evaluate(`Array.from(document.querySelectorAll('#commits .commit')).find(n=>n.querySelector('.commit-subject').textContent===${JSON.stringify(subject)}).click()`); await wait(`document.querySelector('#commit-detail h2')?.textContent===${JSON.stringify(subject)} && (document.querySelector('.next-empty-commit') || document.querySelector('.change-count')?.textContent.includes('处变更') || document.querySelector('.warning'))`);};
  await evaluate('document.querySelector("#toggle-comments").click();document.querySelector("#focus-diff").click()');
  assert.equal(await evaluate('document.querySelector("#focus-commit").textContent.includes("Newest")'),true);
  await delay(250);
  await evaluate('document.querySelector("#focus-commit").focus()');
  await wait('!document.querySelector("#commit-message-preview").hidden');
  assert.equal(await evaluate('document.querySelector("#commit-message-preview").textContent.includes("Long body line")'),true);
  assert.equal(await evaluate('document.querySelector("#commit-message-preview script")'),null);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'});
  assert.ok(await evaluate('document.querySelector("#commit-message-preview").scrollTop')>0);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  assert.equal(await evaluate('document.querySelector("#commit-message-preview").hidden'),true);
  await evaluate('document.querySelector("#focus-commit").click()');assert.equal(await evaluate('document.querySelector("#commit-message-preview").hidden'),false,'touch/click can reopen');
  assert.equal(await evaluate('document.querySelector("#commit-message-preview").scrollTop'),0,'reopening begins with the commit heading');
  await writeFile('/tmp/commit-review-focus.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(250);
  const touchPoint=await evaluate('(()=>{const r=document.querySelector("#focus-commit").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touchPoint]});
  await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await delay(300);
  await wait('!document.querySelector("#commit-message-preview").hidden');
  assert.equal(await evaluate('(()=>{const r=document.querySelector("#commit-message-preview").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()'),true,'touch details fit viewport');
  await writeFile('/tmp/commit-review-focus-mobile.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await delay(250);
  await next();await wait('document.querySelector(".file-title")?.textContent.includes("z.txt") && document.querySelector(".change-count")?.textContent==="1 处变更"');
  const originalOrder=await evaluate('Array.from(document.querySelectorAll("#commits .commit")).map(n=>n.dataset.commitSha)');
  await next();await wait('document.querySelector("#notice").textContent.includes("时间最新")');
  assert.equal(await current(),'Newest');assert.equal(await evaluate('document.querySelector("#more").hidden'),true,'range completed before selecting chronological neighbor');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#commits .commit")).slice(0,50).map(n=>n.dataset.commitSha)'),originalOrder,'display order remains unchanged');
  await choose('Oldest');await next();await wait('document.querySelector("#commit-detail h2")?.textContent==="Page filler 0"');
  await choose('Page filler 49');await next();await wait('document.querySelector("#commit-detail h2")?.textContent==="Mode only" && document.querySelector(".change-count")?.textContent==="0 处变更"');
  await next();await wait('document.querySelector("#commit-detail h2")?.textContent==="Binary" && document.querySelector(".warning")');
  await next();await wait('document.querySelector("#commit-detail h2")?.textContent==="Empty newest"');
  await evaluate(`const row=Array.from(document.querySelectorAll('#commits .commit-row')).find(n=>n.textContent.includes('Hidden commit'));row.querySelector('input').click();document.querySelector('#hide-commits').click()`);
  await evaluate(`const b=Array.from(document.querySelectorAll('#diff button')).find(n=>n.textContent.includes('下一处'));for(let i=0;i<8;i++)b.click()`);
  await wait('document.querySelector("#commit-detail h2")?.textContent==="Newest" && document.querySelector(".file-title")?.textContent.includes("a.txt")');
  assert.equal(await evaluate('document.querySelector("#focus-commit").textContent.includes("Newest")'),true);
  assert.equal(await evaluate('document.querySelector("#commit-message-preview").hidden'),true);
  await evaluate(`document.querySelector('#commit-search').value='newest';document.querySelector('#commit-search').dispatchEvent(new Event('input'))`);
  await choose('Empty newest');await next();await wait('document.querySelector("#commit-detail h2")?.textContent==="Newest" && document.querySelector(".change-count")?.textContent==="1 处变更"');
  await next();await wait('document.querySelector(".file-title")?.textContent.includes("z.txt")');await next();await wait('document.querySelector("#notice").textContent.includes("时间最新")');
  await evaluate(`document.querySelector('#commit-search').value='';document.querySelector('#commit-search').dispatchEvent(new Event('input'))`);
  await choose('Empty newest');
  await evaluate(`window.originalFetch=window.fetch;window.held=false;window.fetch=async(url,options)=>{if(url.startsWith('/api/diff?')){window.held=true;await new Promise(resolve=>window.releaseHeld=resolve);}return window.originalFetch(url,options);}`);
  await next();await wait('window.held');await evaluate('window.fetch=window.originalFetch');
  await choose('Oldest');await evaluate('window.releaseHeld()');await delay(250);
  assert.equal(await current(),'Oldest');assert.equal(await evaluate('document.querySelector("#focus-commit").textContent.includes("Oldest")'),true);
  await evaluate('document.querySelector("#exit-focus").click()');
  assert.equal(await evaluate('document.querySelector("#comments-pane").hidden'),false,'exit restores previous panel');
  assert.equal(await evaluate('document.querySelector(".topbar").hidden || document.querySelector(".history").hidden'),false);
  assert.equal(await evaluate('document.querySelector("#focus-actions").hidden'),true);
  await evaluate(`document.querySelector('#commit-search').value='nothing-matches';document.querySelector('#commit-search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate('document.querySelector("#focus-commit").disabled'),true);
  assert.deepEqual(t.errors,[]);
  console.log('Cross-commit browser passed: file boundaries, hidden/search filters, empty/binary/mode-only commits, pagination, list end, rapid clicks, stale response, focus details and exit restoration.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
