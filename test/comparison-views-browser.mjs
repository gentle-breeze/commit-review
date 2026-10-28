// Real Chrome regression using only a disposable Git repository, data directory and profile.
// Run after npm run build: node test/ranges-files-browser.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-comparison-views-'));
const screenshotPath = process.env.REVIEW_SCREENSHOT_PATH || path.join(os.tmpdir(), 'commit-review-comparison-views.png');
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
  await writeFile(path.join(repository, 'deleted.txt'), 'remove me\n');
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
  git('rm', 'deleted.txt');
  await writeFile(path.join(repository, 'DemoTests.java'), 'class DemoTests {}\n');
  git('add', '.'); git('commit', '-m', 'Binary and text change');
  const initialHead = git('rev-parse', 'HEAD');
  git('push', '-u', 'origin', 'feature');
  assert.equal(Number(git('rev-list', '--count', 'main..feature')), 55);

  git('switch','-c','composition',baseSha);
  await writeFile(path.join(repository,'lines.txt'),'aaa\n');git('add','.');git('commit','-m','Add aaa');const aaa = git('rev-parse','HEAD');
  git('config','user.name','Bob');git('config','user.email','bob@example.invalid');
  await writeFile(path.join(repository,'lines.txt'),'aaa\nbbb\n');git('add','.');git('commit','-m','Add bbb');const bbb = git('rev-parse','HEAD');
  await writeFile(path.join(repository,'lines.txt'),'aaa\nbbb\nccc\n');git('add','.');git('commit','-m','Add ccc');const ccc = git('rev-parse','HEAD');
  git('switch','-c','dependency');await writeFile(path.join(repository,'lines.txt'),'AAA\nbbb\nccc\n');git('add','.');git('commit','-m','Replace aaa');
  git('switch','feature');
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
      if (String(args[0]).startsWith('/api/comparison-file?') && response.ok) window.latestComparisonFile = await response.clone().json();
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


  const headDiff = await request(`/api/diff?sha=${initialHead}`);
  const headComment = await request('/api/comments', 'POST', {sha:initialHead,anchor:{kind:'file',fileId:headDiff.files.find(f=>f.path==='after.js').id},body:'Head comment stays at commit'});
  await click('#refresh');
  await wait(`document.querySelector('.file-comment-button') && !document.querySelector('#refresh').disabled`);
  const stored = JSON.stringify(app.store.list());
  await chooseFile('after.js');
  const aggregateReady = `document.querySelector('#commit-detail').textContent.includes('全部文件 · 可见提交改动') && document.querySelector('.file-title')`;
  await select('#comparison-view', 'files'); await wait(aggregateReady);
  const paths = await evaluate(`Array.from(document.querySelectorAll('#files .file-path')).map(n=>n.textContent)`);
  assert.deepEqual(paths.sort(), ['after.js','asset.bin','deleted.txt','progress.txt']);
  assert.equal(await evaluate(`document.querySelectorAll('.file-comment-button, [data-actions]').length`), 0);
  assert.match(await evaluate(`document.querySelector('#commit-detail').textContent`), /共同祖先/);
  await click('#skip-test-files');
  await wait(`Array.from(document.querySelectorAll('#files .file-path')).some(n=>n.textContent==='DemoTests.java')`);
  await click('#skip-test-files');
  await evaluate(`Array.from(document.querySelectorAll('#files .file-link')).find(n=>n.title==='deleted.txt').click()`);
  await wait(`document.querySelector('.file-title')?.textContent.includes('D  deleted.txt')`);
  await select('#comparison-view','commits');
  await wait(`document.querySelector('.file-title')?.textContent.includes('after.js') && document.querySelector('.file-comment-button')`);
  await select('#comparison-view','files');
  await wait(`document.querySelector('.file-title')?.textContent.includes('deleted.txt') && !document.querySelector('.file-comment-button')`);
  await scopeChange(()=>select('#branch','refs/heads/main'));
  await wait(`document.querySelector('#diff').textContent.includes('没有净改动')`);
  await scopeChange(()=>select('#branch','refs/remotes/origin/feature'));
  await wait(aggregateReady);
  const author = JSON.stringify(['Range Browser Test','test@example.invalid']);
  await scopeChange(()=>select('#commit-author',author)); await wait(aggregateReady);
  assert.match(await evaluate(`document.querySelector('#commit-detail').textContent`), /作者筛选/);
  await scopeChange(()=>click('#clear-author')); await wait(aggregateReady);
  // Delay old aggregate responses to prove switches cannot install stale files.
  await evaluate(`window.fetchBeforeDelay = window.fetch; window.fetch = async (...args) => {
    const response = await window.fetchBeforeDelay(...args);
    if (String(args[0]).startsWith('/api/comparison')) await new Promise(r=>setTimeout(r,500));
    return response;
  }`);
  await select('#comparison-view','commits');
  await select('#comparison-view','files');
  await select('#comparison-view','commits');
  await delay(900);
  await wait(`document.querySelector('.file-comment-button') && document.querySelector('#comparison-view').value==='commits'`);
  await select('#comparison-view','files');
  await select('#branch','refs/heads/main');
  await wait(`document.querySelector('#diff').textContent.includes('没有净改动')`);
  await delay(700);
  assert.equal(await evaluate(`document.querySelectorAll('#files .file-link').length`),0);
  await scopeChange(()=>select('#branch','refs/remotes/origin/feature')); await wait(aggregateReady);
  await click('#toggle-comments');
  await select('#comment-scope','all');
  await click(`#comments [data-comment-id="${legacy.id}"] .comment-anchor`);
  await wait(`document.querySelector('#comparison-view').value==='commits' && document.querySelector('.file-title')?.textContent.includes('before.js')`);
  assert.equal(JSON.stringify(app.store.list()), stored, 'view switches and jumps preserve comment data');
  await select('#comparison-view','files'); await wait(aggregateReady);
  await wait(`document.querySelector('#comments [data-comment-id="${headComment.id}"]')`);
  await click(`#comments [data-comment-id="${headComment.id}"] .comment-anchor`);
  await wait(`document.querySelector('#comparison-view').value==='commits' && document.querySelector('.file-comment-button')`);
  await select('#comparison-view','files'); await wait(aggregateReady);
  await evaluate(`Array.from(document.querySelectorAll('#files .file-link')).find(n=>n.title==='asset.bin').click()`);
  await wait(`document.querySelector('.warning')?.textContent.includes('二进制')`);
  await click('.editor-tools button:last-child');
  await wait(`document.querySelector('.file-title')?.textContent.includes('deleted.txt')`);
  // Real UI hiding must remove changes from the same file, not just filter paths.
  await scopeChange(()=>select('#branch','refs/heads/composition')); await wait(aggregateReady);
  await select('#comparison-view','commits');
  await wait(`document.querySelector('.file-comment-button')`);
  const hide = async sha => {
    await click(`#commits input[value="${sha}"]`); await click('#hide-commits');
    await wait(`!document.querySelector('#commits input[value="${sha}"]')`);
  };
  await hide(aaa);
  await select('#comparison-view','files');
  await wait(`window.latestComparisonFile?.new?.text === 'bbb\\nccc\\n' && document.querySelector('.file-title')?.textContent.includes('lines.txt')`);
  assert.match(await evaluate(`document.querySelector('#commit-detail').textContent`), /选入 2 条，排除 1 条/);
  await click('#show-hidden');
  await wait(`window.latestComparisonFile?.new?.text === 'aaa\\n'`);
  await click('#show-hidden'); await wait(`window.latestComparisonFile?.new?.text === 'bbb\\nccc\\n'`);
  await scopeChange(()=>select('#commit-author',JSON.stringify(['Bob','bob@example.invalid'])));
  await wait(`window.latestComparisonFile?.new?.text === 'bbb\\nccc\\n' && document.querySelector('.file-title')`);
  await click('#show-hidden'); await wait(`document.querySelector('#diff').textContent.includes('没有净改动')`);
  await click('#show-hidden'); await wait(`document.querySelector('.file-title')`);
  await scopeChange(()=>click('#clear-author')); await wait(aggregateReady);
  await select('#comparison-view','commits'); await wait(`document.querySelector('.file-comment-button')`);
  await hide(bbb); await hide(ccc);
  await select('#comparison-view','files');await wait(`document.querySelector('#diff').textContent.includes('没有净改动')`);
  await click('#restore-commits');await wait(`window.latestComparisonFile?.new?.text === 'aaa\\nbbb\\nccc\\n' && document.querySelector('.file-title')`);
  await select('#comparison-view','commits'); await wait(`document.querySelector('.file-comment-button')`);await hide(aaa);
  await select('#comparison-view','files');await wait(`window.latestComparisonFile?.new?.text === 'bbb\\nccc\\n'`);
  await scopeChange(()=>select('#branch','refs/heads/dependency'));
  await wait(`document.querySelector('#diff').textContent.includes('依赖已排除的行')`);
  assert.equal(await evaluate(`document.querySelectorAll('#files .file-link').length`),0,'conflict must not show partial or fallback diff');
  await click('#restore-commits');await wait(`window.latestComparisonFile?.new?.text === 'AAA\\nbbb\\nccc\\n' && document.querySelector('.file-title')`);
  // Trigger two delayed compositions, ending in ordinary visible mode.
  await click('#show-hidden'); await click('#show-hidden');
  await delay(1200);
  await wait(`document.querySelector('.file-title') && document.querySelector('#show-hidden').getAttribute('aria-pressed')==='false'`);
  assert.equal(await evaluate(`window.latestComparisonFile.new.text`),'AAA\nbbb\nccc\n');
  assert.equal(JSON.stringify(app.store.list()),stored,'compositions never rewrite real comment anchors');
  assert.doesNotMatch(await evaluate(`document.querySelector('#files').textContent`), /null/);
  await capture(screenshotPath);
  await cdp('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.deepEqual(errors, [], 'no uncaught browser exceptions');
  console.log('Comparison browser passed: duplicate paths, rename/delete/binary, Tests.java, selection restore, author, empty/changed branches, delayed rapid switches, original comment jump and isolation.');
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
