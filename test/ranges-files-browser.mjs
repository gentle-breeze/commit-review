// Real Chrome regression using only a disposable Git repository, data directory and profile.
// Run after npm run build: node test/ranges-files-browser.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-ranges-files-'));
const screenshotPath = process.env.REVIEW_SCREENSHOT_PATH || path.join(os.tmpdir(), 'commit-review-ranges-files.png');
let app, chrome, socket, capture;
try {
  const repository = path.join(root, 'fixture');
  await mkdir(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], {encoding:'utf8',stdio:'pipe'}).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Range Browser Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repository, 'before.js'), 'export function value() {\n  return 1;\n}\n');
  git('add', '.'); git('commit', '-m', 'Shared base');
  const baseSha = git('rev-parse', 'HEAD');
  git('init', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-u', 'origin', 'main');
  git('checkout', '-b', 'feature');
  await writeFile(path.join(repository, 'before.js'), 'export function value() {\n  return 2;\n}\n');
  git('add', '.'); git('commit', '-m', 'Original feature change');
  const original = git('rev-parse', 'HEAD');
  for (let i = 1; i <= 52; i++) {
    await writeFile(path.join(repository, 'progress.txt'), `Feature progress ${i}\n`);
    git('add', '.'); git('commit', '-m', `Progress ${i}`);
  }
  git('mv', 'before.js', 'after.js'); git('commit', '-m', 'Rename reviewed file');
  const renamed = git('rev-parse', 'HEAD');
  await writeFile(path.join(repository, 'after.js'), 'export function value() {\n  return 3;\n}\n');
  await writeFile(path.join(repository, 'asset.bin'), Buffer.from([0, 1, 2, 255]));
  git('add', '.'); git('commit', '-m', 'Binary and text change');
  const initialHead = git('rev-parse', 'HEAD');
  git('push', '-u', 'origin', 'feature');
  assert.equal(Number(git('rev-list', '--count', 'main..feature')), 55);

  app = await createApp({repoPath:repository, dataDir:path.join(root, 'data')});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const info = await (await fetch(base + '/api/info')).json();
  const headers = {'Content-Type':'application/json','X-Review-Token':info.token,'X-Review-Project':info.projectId};
  const request = async (route, method = 'GET', body, expected = method === 'POST' && route === '/api/comments' ? 201 : 200) => {
    const response = await fetch(base + route, {method, headers, ...(body ? {body:JSON.stringify(body)} : {})});
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
  const originalDiff = await request(`/api/diff?sha=${original}`);
  const legacy = await request('/api/comments', 'POST', {
    sha:original,
    anchor:{fileId:originalDiff.files.find(file => file.path === 'before.js').id,side:'new',startLine:2,endLine:2},
    body:'Legacy line comment remains readable',
  });
  assert.equal(legacy.kind, undefined, 'legacy line anchor has no kind');

  const profile = path.join(root, 'chrome');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], {stdio:'ignore'});
  let port;
  for (let i = 0; i < 100; i++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}`);
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    await delay(100);
  }
  assert.ok(port, 'Chrome debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true});
  });
  let id = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => {pending.delete(current); reject(new Error(`CDP timeout: ${method}`));}, 15000);
    pending.set(current, {
      resolve:value => {clearTimeout(timer); resolve(value);},
      reject:error => {clearTimeout(timer); reject(error);},
    });
    socket.send(JSON.stringify({id:current, method, params}));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 150; i++) {if (await evaluate(expression)) return; await delay(100);}
    const diagnostic = await evaluate('({notice:document.querySelector("#notice")?.textContent,count:document.querySelectorAll("#commits .commit").length,moreHidden:document.querySelector("#more")?.hidden,moreDisabled:document.querySelector("#more")?.disabled,rangeBusy:document.querySelector("#open-file-index")?.disabled,requests:window.requestedURLs?.slice(-8)})');
    throw new Error(`Timed out: ${expression}; state: ${JSON.stringify(diagnostic)}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const select = (selector, value) => evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)};
    if (node.value !== ${JSON.stringify(value)}) throw new Error('Missing option: ' + ${JSON.stringify(value)});
    node.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  const commitCount = () => evaluate('document.querySelectorAll("#commits .commit").length');
  const snapshot = () => evaluate('window.latestReviewScope');
  const scopeChange = async action => {
    const old = (await snapshot())?.id;
    await action();
    await wait(`window.latestReviewScope?.id && window.latestReviewScope.id !== ${JSON.stringify(old)} && !document.querySelector('#refresh').disabled && !document.querySelector('#open-file-index').disabled`);
  };
  const chooseCommit = async sha => {
    await click(`#commits .commit[data-commit-sha="${sha}"]`);
    await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha === ${JSON.stringify(sha)} && document.querySelector('#commit-detail')?.textContent.includes(${JSON.stringify(sha)})`);
  };
  const chooseFile = async name => {
    await evaluate(`Array.from(document.querySelectorAll('#files .file-link')).find(n => n.querySelector('.file-path')?.textContent === ${JSON.stringify(name)}).click()`);
    await wait(`document.querySelector('.file-title')?.textContent.includes(${JSON.stringify(name)}) && document.querySelector('.file-comment-button')`);
  };
  capture = async file => writeFile(file, Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {width:1600,height:1050,deviceScaleFactor:1,mobile:false});
  await cdp('Page.addScriptToEvaluateOnNewDocument', {source:`
    window.requestedURLs = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      window.requestedURLs.push(String(args[0]));
      const response = await originalFetch(...args);
      if (String(args[0]).startsWith('/api/review-scope?') && response.ok) window.latestReviewScope = await response.clone().json();
      return response;
    };
    Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text => {window.copiedAIText = text;}}});
  `});
  await cdp('Page.navigate', {url:base});
  await wait('window.latestReviewScope && !document.querySelector("#refresh").disabled');
  assert.equal(await evaluate('document.querySelector("#range-mode").value'), 'unpushed');
  await wait('document.querySelectorAll("#commits .commit").length === 0');
  assert.equal((await snapshot()).head, initialHead);
  assert.equal((await snapshot()).base, initialHead, 'already pushed feature has no unpushed commits');

  await scopeChange(() => select('#range-mode', 'compare'));
  await scopeChange(() => select('#base-branch', 'refs/heads/main'));
  await scopeChange(() => select('#branch', 'refs/remotes/origin/feature'));
  await wait('document.querySelectorAll("#commits .commit").length === 50');
  const fixed = await snapshot();
  assert.equal(fixed.base, baseSha); assert.equal(fixed.head, initialHead);
  assert.equal(fixed.ref, 'refs/remotes/origin/feature');
  assert.equal(fixed.mergeBase, baseSha);
  assert.match(await evaluate('document.querySelector("#scope-endpoints").textContent'), new RegExp(initialHead.slice(0, 8)));
  assert.match(await evaluate('document.querySelector("#scope-endpoints").textContent'), new RegExp(baseSha.slice(0, 8)));

  // Moving the actual remote-tracking ref must not mix new commits into page two or downstream scopes.
  await writeFile(path.join(repository, 'after-snapshot.txt'), 'Arrived after the review snapshot\n');
  git('add', '.'); git('commit', '-m', 'Arrived after snapshot');
  const advancedHead = git('rev-parse', 'HEAD');
  git('push', 'origin', 'feature');
  await click('#more');
  await wait('document.querySelectorAll("#commits .commit").length === 55 && document.querySelector("#more").hidden');
  assert.equal(await evaluate(`!!document.querySelector('#commits [data-commit-sha="${advancedHead}"]')`), false);
  assert.equal((await snapshot()).id, fixed.id);

  await click('#open-file-index');
  await wait('document.querySelector("#file-index-dialog").open && document.querySelectorAll("#index-files button").length > 0');
  assert.ok((await evaluate('window.requestedURLs')).some(url => url.startsWith('/api/file-index?') && new URL(url, base).searchParams.get('scope') === fixed.id));
  const indexed = [];
  let indexPage, offset = 0, indexSnapshot;
  do {
    const query = new URLSearchParams({scope:fixed.id,offset:String(offset),...(indexSnapshot ? {snapshot:indexSnapshot} : {})});
    indexPage = await request('/api/file-index?' + query);
    assert.equal(indexPage.scope.head, initialHead);
    indexed.push(...indexPage.commits.map(commit => commit.sha));
    indexSnapshot = indexPage.snapshotId; offset = indexPage.nextOffset;
  } while (!indexPage.complete);
  assert.equal(indexed.length, 55); assert.equal(indexed.includes(advancedHead), false);
  await click('#close-file-index');
  await click('#ai-copy'); await wait('!!window.copiedAIText');
  assert.ok((await evaluate('window.copiedAIText')).includes(`--scope '${fixed.id}'`), 'AI commands use the same fixed scope');
  const association = await request('/api/association-scope?id=' + fixed.id);
  assert.equal(association.commits.length, 55);
  assert.deepEqual(association.commits.map(commit => commit.sha), indexed, 'association and file index see the same SHA order');

  await click('#toggle-comments');
  await select('#comment-scope', 'all'); await select('#comment-filter', 'all');
  await wait(`!!document.querySelector('[data-comment-id="${legacy.id}"] .comment-anchor')`);
  assert.match(await evaluate(`document.querySelector('[data-comment-id="${legacy.id}"] .comment-anchor').textContent`), /第 2–2 行/);
  await chooseCommit(renamed); await chooseFile('after.js');
  await click('.file-comment-button'); await wait('document.querySelector("#comment-dialog").open');
  assert.match(await evaluate('document.querySelector("#selection-label").textContent'), /整个文件/);
  assert.equal(await evaluate('document.querySelector("#selection-code").hidden'), true);
  await evaluate('document.querySelector("#comment-body").value="File review survives rename and range changes"');
  assert.equal(await evaluate('(() => {const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()'), true, 'unsaved whole-file draft guards navigation');
  await evaluate(`window.savedFetch = window.fetch; window.fileWrites = 0;
    window.fetch = async (url, options) => {
      if (String(url) === '/api/comments' && options?.method === 'POST') {
        window.fileWrites++; await new Promise(resolve => window.releaseFileSave = resolve);
      }
      return window.savedFetch(url, options);
    };
    document.querySelector('#comment-form').requestSubmit();
    document.querySelector('#comment-form').requestSubmit();
    document.querySelector('#cancel-comment').click();
  `);
  await wait('window.fileWrites === 1');
  assert.equal(await evaluate('document.querySelector("#comment-dialog").open && document.querySelector("#cancel-comment").disabled'), true, 'save disables close and ignores double submit');
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await evaluate('document.querySelector("#comment-dialog").open'), true, 'Escape cannot close an in-flight save');
  await evaluate('window.fetch = window.savedFetch; window.releaseFileSave()');
  await wait('!document.querySelector("#comment-dialog").open && document.querySelector("#comments").textContent.includes("File review survives")');
  let fileComment = app.store.list().find(comment => comment.body.startsWith('File review survives'));
  assert.equal(fileComment.kind, 'file'); assert.equal(fileComment.path, 'after.js'); assert.equal(fileComment.oldPath, 'before.js');
  assert.equal(fileComment.startLine, undefined); assert.equal(fileComment.endLine, undefined);
  assert.equal(fileComment.code || '', '');
  const fileCard = `[data-comment-id="${fileComment.id}"]`;
  assert.equal(await evaluate('document.querySelectorAll(".review-comment-underline").length'), 0, 'whole-file comment has no invented line decoration');
  const fileLabel = await evaluate(`document.querySelector('${fileCard} .comment-anchor').textContent`);
  assert.match(fileLabel, /before\.js.*after\.js/s, 'both rename paths appear on the comment');
  await click(fileCard + ' .reply-comment'); await wait('document.querySelector("#reply-dialog").open');
  await evaluate('document.querySelector("#reply-body").value="The file-level discussion uses the existing reply thread.";document.querySelector("#reply-form").requestSubmit()');
  await wait('!document.querySelector("#reply-dialog").open');
  assert.equal(app.store.list().find(comment => comment.id === fileComment.id).replies.length, 1);
  const statusAction = text => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(fileCard + ' .comment-actions button')})).find(n => n.textContent === ${JSON.stringify(text)}).click()`);
  await statusAction('标记已解决'); await wait(`document.querySelector('${fileCard}').classList.contains('resolved')`);
  await statusAction('重新打开'); await wait(`!document.querySelector('${fileCard}').classList.contains('resolved')`);
  const openAssociations = async () => {
    await click(fileCard + ' .followup-comment');
    await wait('document.querySelector("#followup-dialog").open && !document.querySelector("#followup-save").disabled');
  };
  await openAssociations();
  assert.equal(await evaluate('document.querySelectorAll("#followup-options input").length'), 55);
  await click(`#followup-options input[value="${original}"]`);
  await click(`#followup-options input[value="${initialHead}"]`);
  await click('#followup-save'); await wait('!document.querySelector("#followup-dialog").open');
  fileComment = app.store.list().find(comment => comment.id === fileComment.id);
  assert.equal(fileComment.followups.filter(link => !link.removedAt).length, 2);
  await openAssociations(); await click(`#followup-options input[value="${original}"]`);
  await click('#followup-save'); await wait('!document.querySelector("#followup-dialog").open');
  fileComment = app.store.list().find(comment => comment.id === fileComment.id);
  assert.equal(fileComment.followups.filter(link => !link.removedAt).length, 1);
  assert.ok(fileComment.followups.find(link => link.sha === original).removedAt, 'replaced association retains history');
  assert.equal(fileComment.oldPath, 'before.js');
  await click(fileCard + ' .comment-body-link');
  await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha === ${JSON.stringify(initialHead)}`);
  assert.equal(await evaluate('document.querySelector("#followup-dialog").open'), false, 'comment body navigates to the current association');
  await click(fileCard + ' .comment-anchor');
  await wait(`document.querySelector('#commits .commit.active')?.dataset.commitSha === ${JSON.stringify(renamed)} && document.querySelector('.file-title')?.textContent.includes('after.js')`);

  // Line comments still use Monaco selection; whole-file comments do not add artificial line markers.
  await chooseCommit(initialHead); await chooseFile('after.js');
  await wait('document.querySelectorAll(".editor.modified .line-numbers").length >= 3');
  const gutter = await evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.editor.modified .line-numbers')).find(n => n.textContent.trim() === '2');
    const rect = node.getBoundingClientRect(); return {x:rect.x + rect.width/2,y:rect.y + rect.height/2};
  })()`);
  await cdp('Input.dispatchMouseEvent', {type:'mousePressed',...gutter,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent', {type:'mouseReleased',...gutter,button:'left',clickCount:1});
  await wait('!document.querySelector(".selection-actions").hidden');
  await evaluate('document.querySelector("#inline-comment-body").value="New line comment still works";document.querySelector("#inline-comment-body").dispatchEvent(new Event("input"));document.querySelector(".selection-actions").requestSubmit()');
  await wait('document.querySelector("#comments").textContent.includes("New line comment still works")');
  const lineComment = app.store.list().find(comment => comment.body === 'New line comment still works');
  assert.equal(lineComment.startLine, 2); assert.equal(lineComment.endLine, 2); assert.notEqual(lineComment.kind, 'file');
  await chooseFile('asset.bin'); await click('.file-comment-button');
  await wait('document.querySelector("#comment-dialog").open');
  await evaluate('document.querySelector("#comment-body").value="Binary file review";document.querySelector("#comment-form").requestSubmit()');
  await wait('!document.querySelector("#comment-dialog").open');
  assert.equal(app.store.list().find(comment => comment.body === 'Binary file review').kind, 'file');

  const stored = JSON.stringify(app.store.list());
  await scopeChange(() => click('#refresh'));
  await wait('document.querySelectorAll("#commits .commit").length === 50');
  assert.equal((await snapshot()).head, advancedHead);
  assert.notEqual((await snapshot()).id, fixed.id);
  assert.equal(await evaluate(`document.querySelector('#commits .commit')?.dataset.commitSha`), advancedHead);
  assert.equal(JSON.stringify(app.store.list()), stored, 'refresh preserves all comments and history');
  // A full association candidate list may arrive before a pending second page.
  // The older page must be discarded instead of duplicating rows or leaving controls disabled.
  await evaluate(`window.pageFetch = window.fetch;
    window.fetch = async (url, options) => {
      const requestURL = new URL(url, location.origin);
      if (requestURL.pathname === '/api/commits' && requestURL.searchParams.get('offset') === '50') {
        window.pageHeld = true;
        await new Promise(resolve => window.releasePage = resolve);
      }
      return window.pageFetch(url, options);
    };
    document.querySelector('#more').click();
  `);
  await wait('window.pageHeld');
  await openAssociations();
  assert.equal(await evaluate('document.querySelectorAll("#followup-options input").length'), 56);
  assert.equal(await commitCount(), 56);
  await click('#followup-close');
  await evaluate('window.fetch = window.pageFetch; window.releasePage()');
  await wait('!document.querySelector("#more").disabled && document.querySelector("#more").hidden && !document.querySelector("#ai-copy").disabled && !document.querySelector("#open-file-index").disabled');
  const raceShas = await evaluate('Array.from(document.querySelectorAll("#commits .commit")).map(n => n.dataset.commitSha)');
  assert.equal(raceShas.length, 56); assert.equal(new Set(raceShas).size, 56, 'stale page cannot duplicate the complete candidate list');
  assert.equal(JSON.stringify(app.store.list()), stored, 'opening and cancelling associations changes no data');
  await scopeChange(() => select('#base-branch', 'refs/remotes/origin/feature'));
  await wait('document.querySelectorAll("#commits .commit").length === 0');
  assert.equal((await snapshot()).base, (await snapshot()).head, 'same-ref comparison is empty');
  for (const query of [
    'mode=compare&ref=refs/remotes/origin/missing&base=refs/heads/main',
    'mode=compare&ref=refs/heads/feature&base=refs/heads/missing',
    'mode=history&ref=--all',
  ]) {
    const response = await fetch(base + '/api/review-scope?' + query, {headers});
    assert.equal(response.status, 400, 'invalid branch selection is rejected');
    assert.ok((await response.json()).error);
  }
  assert.equal((await snapshot()).head, advancedHead, 'invalid API input does not change the browser snapshot');

  // A completed merge erases A..B but must leave history available for delayed review.
  git('branch', '-f', 'main', advancedHead);
  await scopeChange(() => select('#base-branch', 'refs/heads/main'));
  await wait('document.querySelectorAll("#commits .commit").length === 0');
  await scopeChange(() => select('#range-mode', 'history'));
  await scopeChange(() => select('#branch', 'refs/heads/main'));
  await wait('document.querySelectorAll("#commits .commit").length === 50');
  await click('#more'); await wait('document.querySelectorAll("#commits .commit").length === 57 && document.querySelector("#more").hidden');
  assert.equal((await snapshot()).mode, 'history'); assert.equal((await snapshot()).base, null);
  assert.equal(await commitCount(), 57, 'merged and pushed commit history remains reviewable');
  git('checkout', '-b', 'author-side', baseSha);
  git('commit', '--allow-empty', '-m', 'Side author commit');
  git('checkout', 'main');
  git('merge', '--no-ff', 'author-side', '-m', 'Two parents without merge keyword');
  const authorIdentity = JSON.stringify(['Range Browser Test', 'test@example.invalid']);
  await scopeChange(() => select('#commit-author', authorIdentity));
  assert.equal((await snapshot()).total, 57, 'merge omitted from complete author count');
  assert.equal(await commitCount(), 50);
  await click('#more'); await wait('document.querySelectorAll("#commits .commit").length === 57 && document.querySelector("#more").hidden');
  assert.match(await evaluate('document.querySelector("#author-count").textContent'), /57 条非 merge/);
  assert.match(await evaluate('document.querySelector("#commit-author").selectedOptions[0].textContent'), /test@example.invalid/);
  await capture(screenshotPath.replace(/\.png$/, '-author.png'));
  await scopeChange(() => click('#clear-author'));
  assert.equal((await snapshot()).total, 58);
  assert.equal(await evaluate('document.querySelector("#commit-author").value'), '');
  assert.equal(JSON.stringify(app.store.list()), stored, 'range changes preserve comments, replies and association history');
  await chooseCommit(renamed); await chooseFile('after.js');
  await click(fileCard + ' .comment-anchor'); await wait('document.querySelector(".file-title")?.textContent.includes("after.js")');
  assert.match(await evaluate(`document.querySelector('${fileCard} .comment-anchor').textContent`), /整个文件/);
  assert.doesNotMatch(await evaluate(`document.querySelector('${fileCard} .comment-anchor').textContent`), /undefined|NaN/);
  await capture(screenshotPath);
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'new range selectors and file comments fit a narrow viewport');
  assert.deepEqual(errors, [], 'no uncaught browser exceptions');
  console.log('Range/file browser passed: pushed remote comparison, empty/error refs, fixed pagination/index/AI/association scope, explicit refresh, merged history, legacy/new line comments, file/binary/rename comments, replies/status and association history.');
  console.log(`Screenshot: ${screenshotPath}`);
} catch (error) {
  if (capture) await capture(screenshotPath.replace(/\.png$/, '-failure.png')).catch(() => {});
  throw error;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve));}
  if (app) {await new Promise(resolve => app.server.close(resolve)); await app.release();}
  await rm(root, {recursive:true,force:true});
}
