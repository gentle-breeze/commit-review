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
  const original=git(a,'rev-parse','HEAD');git(a,'mv','example.js','renamed.js');git(a,'commit','-m','Rename');const renamed=git(a,'rev-parse','HEAD');await writeFile(path.join(a,'unrelated.txt'),'other\n');git(a,'add','.');git(a,'commit','-m','Latest unrelated diff');const latest=git(a,'rev-parse','HEAD');
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
  const info=await(await fetch(base+'/api/info')).json(),headers={'Content-Type':'application/json','X-Review-Token':info.token,'X-Review-Project':info.projectId};
  const post=async(route,body)=>{const res=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,route==='/api/comments'?201:200);return res.json();};
  let comment=await post('/api/comments',{sha:original,anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review original behavior'});
  const scope=await(await fetch(base+'/api/association-scope?ref=HEAD',{headers})).json();
  comment=await post(`/api/comments/${comment.id}/associations/ai`,{scope:scope.id,shas:[latest,renamed],evidence:'Rename preserves the relevant code; latest commit completes the change.',revision:0,requestId:crypto.randomUUID()});
  const t=await tab(),{cdp,evaluate,wait}=t;await cdp('Page.navigate',{url:base});await wait('document.querySelector(".monaco-editor")');await evaluate('document.querySelector("#toggle-comments").click();document.querySelector("#comment-scope").value="all";document.querySelector("#comment-scope").dispatchEvent(new Event("change"))');
  const body=()=>evaluate('document.querySelector(".comment-body-link").click()');
  await body();await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(latest)} && document.querySelectorAll('.associated-current').length===2`);assert.equal(await evaluate('document.querySelector("#followup-dialog").open'),false);
  await evaluate('document.querySelector(".followup-comment").click()');await wait('!document.querySelector("#followup-save").disabled');assert.match(await evaluate('document.querySelector("#followup-links").textContent'),/AI.*依据/s);assert.equal(await evaluate('Array.from(document.querySelectorAll("#followup-dialog button")).some(b=>b.textContent.includes("确认"))'),false);
  await evaluate(`document.querySelector('#followup-options input[value="${latest}"]').click();document.querySelector('#followup-save').click()`);await wait('!document.querySelector("#followup-dialog").open');assert.ok(app.store.list()[0].followups.find(l=>l.sha===latest).removedAt);assert.equal(app.store.list()[0].resolved,false);
  await body();await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(renamed)} && document.querySelector('.file-title')?.textContent.includes('renamed.js')`);
  await evaluate('document.querySelector(".comment-anchor").click()');await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(original)} && document.querySelector('.file-title')?.textContent.includes('example.js')`);
  await evaluate(`Array.from(document.querySelectorAll('#commits .commit-row')).find(n=>n.querySelector('.commit')?.dataset.commitSha===${JSON.stringify(renamed)}).querySelector('input').click();document.querySelector('#hide-commits').click()`);await body();await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(original)}`);
  await evaluate('document.querySelector("#restore-commits").click()');
  await evaluate(`window.savedFetch=window.fetch;window.fetch=async(url,opts)=>{if(String(url).endsWith('/latest')){window.held=true;await new Promise(r=>window.release=r);}return window.savedFetch(url,opts)};document.querySelector('.comment-body-link').click()`);await wait('window.held');await evaluate('window.fetch=window.savedFetch;document.querySelector(".comment-anchor").click()');await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha===${JSON.stringify(original)} && document.querySelector('.monaco-editor')`);await evaluate('window.release()');await delay(150);assert.equal(await evaluate('document.querySelector("#commits .commit.active").dataset.commitSha'),original);
  await evaluate('document.querySelector("#branch").value="refs/heads/main";document.querySelector("#branch").dispatchEvent(new Event("change"))');await wait('document.querySelectorAll("#commits .commit").length===0');await body();await wait(`document.querySelector('#comment-commit .commit')?.dataset.commitSha===${JSON.stringify(original)}`);assert.equal(await evaluate('document.querySelectorAll(".associated-current").length'),0,'outside-range relations are not current navigation targets');
  assert.deepEqual(t.errors,[]);console.log('Scoped AI association browser passed: source/evidence, single user correction, left-list linkage, rename, hidden/range filtering, original entry and stale navigation.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
