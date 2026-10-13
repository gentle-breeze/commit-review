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
  const info=await(await fetch(base+'/api/info')).json();const headers={'Content-Type':'application/json','X-Review-Token':info.token,'X-Review-Project':info.projectId};
  const res=await fetch(base+'/api/comments',{method:'POST',headers,body:JSON.stringify({sha:git(a,'rev-parse','HEAD'),anchor:{fileId:'0',side:'new',startLine:1,endLine:1},body:'Review'})});const comment=await res.json();
  for(let i=0;i<18;i++)await app.store.reply(comment.id,`Reply ${i}\n`+'line\n'.repeat(6),i===0?'ai':'user');
  const t=await tab(),{cdp,evaluate,wait}=t;await cdp('Page.navigate',{url:base});await wait('document.querySelector(".monaco-editor")');await evaluate('document.querySelector("#toggle-comments").click();document.querySelector(".reply-comment").click();document.querySelector("#reply-body").value="unsaved new reply"');
  const edit=()=>evaluate('document.querySelectorAll("#reply-history .reply-edit")[17].click()');const set=body=>evaluate(`document.querySelector('#reply-edit-body').value=${JSON.stringify(body)}`);const save=()=>evaluate('document.querySelector("#reply-edit-form").requestSubmit()');const cancel=()=>evaluate('document.querySelector("#reply-edit-cancel").click()');
  await evaluate('document.querySelector("#reply-history").scrollTop=500');const scroll=await evaluate('document.querySelector("#reply-history").scrollTop');assert.ok(scroll>0);
  await edit();await set('cancelled');await cancel();assert.match(app.store.list()[0].replies[17].body,/Reply 17/);
  await edit();await set('   ');await save();await wait('document.querySelector("#reply-edit-error").textContent.includes("不能为空")');assert.equal(app.store.list()[0].replies[17].revision,undefined);
  await set('edited once');await evaluate(`window.savedFetch=window.fetch;window.patchCount=0;window.fetch=async(url,opts)=>{if(opts?.method==='PATCH'){window.patchCount++;await new Promise(r=>window.releaseSave=r);}return window.savedFetch(url,opts)};document.querySelector('#reply-edit-form').requestSubmit();document.querySelector('#reply-edit-form').requestSubmit()`);await wait('window.patchCount===1');await cancel();assert.equal(await evaluate('document.querySelector("#reply-edit-dialog").open'),true);await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate('document.querySelector("#reply-edit-dialog").open'),true);
  await evaluate('window.fetch=window.savedFetch;window.releaseSave()');await wait('!document.querySelector("#reply-edit-dialog").open');assert.equal(app.store.list()[0].replies[17].history.length,1);assert.equal(await evaluate('document.querySelector("#reply-body").value'),'unsaved new reply');assert.equal(await evaluate('document.querySelector("#reply-history .reply-thread").open'),true);assert.ok(await evaluate('document.querySelector("#reply-history").scrollTop')>0);
  await edit();await set('retry draft');await evaluate(`window.fetch=async(url,opts)=>{if(opts?.method==='PATCH')throw new Error('simulated network failure');return window.savedFetch(url,opts)}`);await save();await wait('document.querySelector("#reply-edit-error").textContent.includes("simulated network failure")');assert.equal(await evaluate('document.querySelector("#reply-edit-body").value'),'retry draft');await evaluate('window.fetch=window.savedFetch');await save();await wait('!document.querySelector("#reply-edit-dialog").open');assert.equal(app.store.list()[0].replies[17].body,'retry draft');
  await edit();const current=app.store.list()[0].replies[17];await app.store.mutateReply(comment.id,current.id,{action:'edit',body:'concurrent edit',revision:current.revision,requestId:crypto.randomUUID()});await set('stale draft');await save();await wait('document.querySelector("#reply-edit-error").textContent.includes("已被其他操作更新")');assert.equal(await evaluate('document.querySelector("#reply-edit-body").value'),'stale draft');
  await evaluate('document.querySelector("#reply-edit-refresh").click()');await wait('document.querySelector("#reply-edit-body").value==="concurrent edit"');await set('after conflict');await save();await wait('!document.querySelector("#reply-edit-dialog").open');
  await edit();await evaluate(`window.fetch=async(url,opts)=>{if(url==='/api/comments'&&opts?.method==='GET'){window.held=true;await new Promise(r=>window.releaseRead=r);}return window.savedFetch(url,opts)};document.querySelector('#reply-edit-refresh').click()`);await wait('window.held');await cancel();await edit();await set('new draft');await evaluate('window.fetch=window.savedFetch;window.releaseRead()');await delay(100);assert.equal(await evaluate('document.querySelector("#reply-edit-body").value'),'new draft');await cancel();
  await evaluate('window.confirm=()=>false;document.querySelectorAll("#reply-history .reply-delete")[17].click()');assert.equal(app.store.list()[0].replies[17].deletedAt,undefined);await cancel();
  await evaluate('window.confirm=()=>true;document.querySelectorAll("#reply-history .reply-delete")[17].click()');await wait('!document.querySelector("#reply-edit-dialog").open && document.querySelector("#reply-history .reply-restore")');assert.ok(app.store.list()[0].replies[17].deletedAt);assert.equal(app.store.list()[0].resolved,false);assert.match(await evaluate('document.querySelector("#reply-history summary").textContent'),/17 条回复.*1 条已删除/);
  await evaluate('document.querySelector("#reply-history .reply-restore").click()');await wait('!document.querySelector("#reply-edit-dialog").open && !document.querySelector("#reply-history .reply-restore")');assert.equal(app.store.list()[0].replies[17].body,'after conflict');
  await edit();await cdp('Page.bringToFront');await writeFile('/tmp/commit-review-reply-edit.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));await cancel();
  await evaluate('document.querySelector("#reply-history .reply-thread").open=false');await delay(50);await evaluate('document.querySelector("#reply-body").value="";document.querySelector("#cancel-reply").click();document.querySelector(".reply-comment").click()');assert.equal(await evaluate('document.querySelector("#reply-history .reply-thread").open'),false,'fold state persists after editing and reopening');await evaluate('document.querySelector("#cancel-reply").click()');
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(repos[1])});await wait('document.querySelector("#repository").textContent.includes("/B") && document.querySelector(".monaco-editor")');assert.equal(await evaluate('document.querySelectorAll(".reply-item").length'),0);
  assert.deepEqual(t.errors,[]);console.log('Reply editing browser passed: cancel, empty body, duplicate/save lock, failure retry, conflict refresh, stale reads, deletion confirmation/restore, draft preservation, scroll/fold state and project isolation.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
