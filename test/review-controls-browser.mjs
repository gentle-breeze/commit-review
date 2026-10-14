import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'review-controls-'));
let app, chrome; const sockets = [];
try {
  const projects = path.join(root, 'projects'); await mkdir(projects);
  const a=path.join(projects,'A'), b=path.join(projects,'B');await mkdir(a);
  const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  git(a,'init','-b','main');git(a,'config','user.name','Reviewer');git(a,'config','user.email','test@example.invalid');
  const lines=Array.from({length:45},(_,i)=>`line ${i}`).join('\n')+'\n';
  await writeFile(path.join(a,'a.js'),lines);await writeFile(path.join(a,'z.js'),lines);await writeFile(path.join(a,'Rename.java'),'rename me\n');git(a,'add','.');git(a,'commit','-m','Base');git(a,'checkout','-b','feature');
  await mkdir(path.join(a,'Test'));
  for(const f of ['OnlyTest.java','FooTest','TestHelper.java','FooTestHelper.js','Test/Foo.java','Footest.java','FooTest.spec.ts','DeleteTest.java'])await writeFile(path.join(a,f),'oldest\n');
  await writeFile(path.join(a,'a.js'),lines.replace('line 2\n','oldest 2\n'));git(a,'add','.');git(a,'commit','-m','Oldest');
  await writeFile(path.join(a,'OnlyTest.java'),'middle\n');await writeFile(path.join(a,'FooTest'),'middle\n');git(a,'rm','DeleteTest.java');git(a,'mv','Rename.java','RenameTest.java');git(a,'add','.');git(a,'commit','-m','Only cases');
  await writeFile(path.join(a,'LastTest.java'),'newest test\n');await writeFile(path.join(a,'mTest.java'),'middle test file\n');await writeFile(path.join(a,'a.js'),lines.replace('line 2\n','newest 2\n'));await writeFile(path.join(a,'z.js'),lines.replace('line 2\n','newest 2\n').replace('line 35\n','newest 35\n'));git(a,'add','.');git(a,'commit','-m','Newest');
  git(root,'clone','--no-hardlinks',a,b);git(b,'branch','main','origin/main');git(b,'branch','--unset-upstream');
  app=await createApp({repoPath:a,projectsDir:projects,dataDir:path.join(root,'data')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
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
  const t=await tab(), other=await tab();const {cdp,evaluate,wait}=t;
  await cdp('Page.bringToFront');await cdp('Page.navigate',{url:base});
  await wait('document.querySelector(".change-count")?.textContent==="1 处变更"');
  assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),true,'first use defaults on');
  assert.equal(await evaluate('document.querySelectorAll("#files .file-link").length'),2);
  await evaluate('document.querySelector("#skip-test-files").click()');await wait('document.querySelectorAll("#files .file-link").length===4');
  await cdp('Page.reload');await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),false,'explicit off survives reload');
  assert.equal(await evaluate('document.querySelectorAll("#files .file-link").length'),4);
  const focused=()=>evaluate('document.querySelector(".workspace").classList.contains("focus-diff")');
  const eventF=options=>evaluate(`(()=>{const e=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,code:'KeyF',key:'f',...${JSON.stringify(options)}});document.activeElement.dispatchEvent(e);return e.defaultPrevented;})()`);
  await evaluate('document.body.tabIndex=-1;document.body.focus()');
  assert.equal(await eventF({key:'Process',keyCode:229}),true);assert.equal(await focused(),true,'idle Chinese IME physical F');
  assert.equal(await eventF({repeat:true}),true);assert.equal(await focused(),true,'repeat does not toggle');
  assert.equal(await eventF({key:'ｆ'}),true);assert.equal(await focused(),false);
  assert.equal(await eventF({key:'f',code:'KeyG'}),false);assert.equal(await focused(),false);
  await evaluate('document.querySelector(".monaco-editor .inputarea, .monaco-editor .native-edit-context").focus()');
  assert.equal(await eventF({key:'Process',keyCode:229}),true);assert.equal(await focused(),true,'readonly editor physical F');
  await eventF({});assert.equal(await focused(),false);
  await evaluate('document.querySelector(".monaco-editor .inputarea, .monaco-editor .native-edit-context").focus();document.activeElement.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"f"}))');
  assert.equal(await eventF({key:'Process',keyCode:229}),false,'tracked composition stays protected even if keydown omits isComposing');
  assert.equal(await focused(),false);
  await evaluate('document.activeElement.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"分"}))');
  assert.equal(await eventF({isComposing:true}),false);
  assert.equal(await eventF({}),true);await eventF({});
  // Real browser composition events generated through CDP, not an OS input-method simulation.
  await evaluate('window.imeEvents=[];var p=document.createElement("textarea");p.id="ime-probe";for(const type of ["compositionstart","compositionupdate","compositionend"])p.addEventListener(type,e=>imeEvents.push(e.type));document.body.append(p);p.focus()');
  await cdp('Input.imeSetComposition',{text:'fen',selectionStart:3,selectionEnd:3});
  assert.equal(await eventF({key:'Process',keyCode:229}),false);assert.equal(await focused(),false);
  await cdp('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  assert.ok((await evaluate('imeEvents')).includes('compositionstart'));
  await evaluate('document.querySelector("#ime-probe").remove()');
  for(const selector of ['#commit-search','#branch']){await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);assert.equal(await eventF({}),false);}
  await evaluate('var p=document.createElement("div");p.id="editable-probe";p.contentEditable="true";document.body.append(p);p.focus()');assert.equal(await eventF({}),false);await evaluate('document.querySelector("#editable-probe").remove()');
  // Existing Test comments survive display filtering and do not bypass it on navigation.
  await evaluate(`(async()=>{const session=await(await fetch('/api/info')).json();window.testHeaders={'Content-Type':'application/json','X-Review-Project':session.projectId,'X-Review-Token':session.token};const sha=document.querySelector('#commits .commit').dataset.commitSha;const diff=await(await fetch('/api/diff?sha='+sha,{headers:testHeaders})).json();const file=diff.files.find(f=>f.path==='LastTest.java');await fetch('/api/comments',{method:'POST',headers:testHeaders,body:JSON.stringify({sha,anchor:{fileId:file.id,side:'new',startLine:1,endLine:1},body:'Test comment retained'})});document.querySelector('#refresh').click();})()`);
  await wait('!document.querySelector("#refresh").disabled && document.querySelector("#comments").textContent.includes("Test comment retained")');
  await evaluate('document.querySelector("#skip-test-files").click()');
  await wait('document.querySelectorAll("#files .file-link").length===2 && document.querySelector(".change-count")?.textContent==="1 处变更"');
  assert.equal(await evaluate('document.querySelector("#skipped-test-count").textContent'),'已跳过 2 个文件');
  await evaluate('Array.from(document.querySelectorAll("#diff button")).find(n=>n.textContent.includes("下一处")).click()');
  await wait('document.querySelector(".file-title")?.textContent.includes("z.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 2"');

  await evaluate('document.querySelector(".comment-body-link").click()');
  assert.equal(await evaluate('document.querySelector("#notice").textContent.includes("Test 文件")'),true);
  assert.equal(await evaluate('(async()=> (await(await fetch("/api/comments",{headers:testHeaders})).json()).length)()'),1);
  const choose=async name=>{await evaluate(`Array.from(document.querySelectorAll('#commits .commit')).find(n=>n.querySelector('.commit-subject').textContent===${JSON.stringify(name)}).click()`);await wait(`document.querySelector('#commit-detail h2')?.textContent===${JSON.stringify(name)} && (document.querySelector('.next-empty-commit')||document.querySelector('.change-count')?.textContent.includes('处变更'))`);};
  const move=direction=>evaluate(`Array.from(document.querySelectorAll('#diff button')).find(n=>n.textContent.includes(${JSON.stringify(direction==='previous'?'上一处':'下一处')})).click()`);
  await choose('Oldest');
  const paths=await evaluate('Array.from(document.querySelectorAll("#files .file-path")).map(n=>n.textContent)');
  for(const name of ['TestHelper.java','FooTestHelper.js','Test/Foo.java','Footest.java','FooTest.spec.ts'])assert.ok(paths.includes(name),name);
  assert.equal(paths.includes('OnlyTest.java'),false);assert.equal(paths.includes('FooTest'),false);
  await choose('Newest');await move('previous');await wait('document.querySelector("#commit-detail h2")?.textContent==="Only cases" && document.querySelector(".previous-empty-commit")');
  assert.equal(await evaluate('document.querySelectorAll("#files .file-link").length'),0);
  assert.equal(await evaluate('document.querySelector("#skipped-test-count").textContent'),'已跳过 4 个文件');
  await evaluate('document.body.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'[',code:'BracketLeft'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'[',code:'BracketLeft'});
  await wait('document.querySelector("#commit-detail h2")?.textContent==="Oldest" && document.querySelector(".file-title")?.textContent.includes("a.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await evaluate('document.querySelector("#files .file-link").click()');await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 1"');await move('previous');await wait('document.querySelector("#notice").textContent.includes("时间最早")');
  await choose('Newest');await evaluate('Array.from(document.querySelectorAll("#files .file-link")).find(n=>n.textContent.includes("z.js")).click()');await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 2"');
  await move('next');await wait('document.querySelector(".current-change")?.textContent==="当前 2 / 2"');await move('previous');await wait('document.querySelector(".current-change")?.textContent==="当前 1 / 2"');await move('previous');await wait('document.querySelector(".file-title")?.textContent.includes("a.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await evaluate('Array.from(document.querySelectorAll("#commits .commit-row")).find(n=>n.textContent.includes("Only cases")).querySelector("input").click();document.querySelector("#hide-commits").click()');
  await move('previous');await wait('document.querySelector("#commit-detail h2")?.textContent==="Oldest" && document.querySelector(".file-title")?.textContent.includes("a.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await evaluate('document.querySelector("#restore-commits").click();document.querySelector("#commit-search").value="est";document.querySelector("#commit-search").dispatchEvent(new Event("input"))');
  await choose('Newest');await move('previous');await wait('document.querySelector("#commit-detail h2")?.textContent==="Oldest"');
  await choose('Newest');
  await evaluate(`window.originalFetch=window.fetch;window.held=false;window.fetch=async(url,options)=>{if(url.startsWith('/api/diff?')){window.held=true;await new Promise(resolve=>window.releaseHeld=resolve);}return window.originalFetch(url,options);};const b=Array.from(document.querySelectorAll('#diff button')).find(n=>n.textContent.includes('上一处'));for(let i=0;i<6;i++)b.click()`);
  await wait('window.held');await evaluate('window.fetch=window.originalFetch');await choose('Newest');await evaluate('window.releaseHeld()');await delay(200);assert.equal(await evaluate('document.querySelector("#commit-detail h2").textContent'),'Newest');
  await cdp('Page.reload');await wait('document.querySelector("#skip-test-files")?.checked && document.querySelectorAll("#files .file-link").length===2');
  await other.cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(b)});await other.wait('document.querySelectorAll("#files .file-link").length===2');assert.equal(await other.evaluate('document.querySelector("#skip-test-files").checked'),true,'another unset project defaults on');await other.evaluate('document.querySelector("#skip-test-files").click()');await other.wait('document.querySelectorAll("#files .file-link").length===4');await other.cdp('Page.reload');await other.wait('!document.querySelector("#skip-test-files").checked && document.querySelectorAll("#files .file-link").length===4');
  await evaluate('document.querySelector("#focus-diff").click()');assert.equal(await evaluate('document.querySelector("#file-options").hidden'),false,'switch is available in focus mode');
  await writeFile('/tmp/commit-review-controls.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('document.querySelector("#skip-test-files").click()');await wait('document.querySelectorAll("#files .file-link").length===4');
  assert.equal(await evaluate('document.querySelector("#comments").textContent.includes("Test comment retained")'),true);
  await evaluate('document.querySelector("#exit-focus").click()');assert.equal(await focused(),false);
  await evaluate('document.querySelector("#skip-test-files").click()');await wait('document.querySelectorAll("#files .file-link").length===2');
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(b)});await wait('document.querySelectorAll("#files .file-link").length===4');assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),false);
  await cdp('Page.navigate',{url:base+'/?repo='+encodeURIComponent(a)});await wait('document.querySelectorAll("#files .file-link").length===2');assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),true);
  // Default/retained enabled preference also applies to binary next-file and forward commit boundaries.
  await writeFile(path.join(a,'A.bin'),Buffer.from([0,1,2]));await writeFile(path.join(a,'BTest.java'),'test\n');await writeFile(path.join(a,'C.js'),'normal\n');git(a,'add','.');git(a,'commit','-m','Binary navigation');
  await cdp('Page.reload');await wait('document.querySelector(".file-title")?.textContent.includes("A.bin")');
  assert.equal(await evaluate('document.querySelector("#skip-test-files").checked'),true);
  await evaluate('Array.from(document.querySelectorAll("#diff button")).find(n=>n.textContent.includes("下一个文件")).click()');await wait('document.querySelector(".file-title")?.textContent.includes("C.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await writeFile(path.join(a,'DTest.java'),'only test\n');git(a,'add','.');git(a,'commit','-m','Forward only Test');await writeFile(path.join(a,'E.js'),'next normal\n');git(a,'add','.');git(a,'commit','-m','Forward normal');
  await cdp('Page.reload');await wait('document.querySelector(".file-title")?.textContent.includes("E.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await evaluate('Array.from(document.querySelectorAll("#commits .commit")).find(n=>n.querySelector(".commit-subject").textContent==="Binary navigation").click()');await wait('document.querySelector(".file-title")?.textContent.includes("A.bin")');
  await evaluate('Array.from(document.querySelectorAll("#diff button")).find(n=>n.textContent.includes("下一个文件")).click()');await wait('document.querySelector(".file-title")?.textContent.includes("C.js") && document.querySelector(".current-change")?.textContent==="当前 1 / 1"');
  await move('next');await wait('document.querySelector("#commit-detail h2")?.textContent==="Forward only Test" && document.querySelector(".next-empty-commit")');assert.equal(await evaluate('document.querySelectorAll("#files .file-link").length'),0);
  await evaluate('document.querySelector(".next-empty-commit").click()');await wait('document.querySelector(".file-title")?.textContent.includes("E.js")');
  for(const page of [t,other])assert.deepEqual(page.errors,[]);
  console.log('Review controls browser passed: reverse commit/file/diff navigation, hidden/search/empty boundaries, rapid switching, Test filtering and project persistence, physical F, editing exclusions, tracked and CDP composition. OS Chinese candidate UI was not driven.');
} finally {
  sockets.forEach(s=>s.close());
  if(chrome&&chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  if(app){await new Promise(resolve=>app.server.close(resolve));await app.release();}
  await rm(root,{recursive:true,force:true});
}
