// Optional integration check: node test/browser-smoke.mjs (requires Google Chrome on macOS).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'review-browser-'));
let app, chrome, socket;
try {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Browser Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'example.js'), 'export function sum(values) {\n  return values.reduce((a, b) => a + b);\n}\n');
  git('add', 'example.js'); git('commit', '-m', 'Add sum helper');
  git('branch', 'initial');
  await writeFile(path.join(root, 'example.js'), 'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n');
  git('add', 'example.js'); git('commit', '-m', 'Handle empty arrays');
  app = await createApp({ repoPath: root, dataDir: path.join(root, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const profile = path.join(root, 'chrome');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chrome.exitCode}`);
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    await delay(100);
  }
  if (!port) throw new Error('Chrome did not expose debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text);
    const request = pending.get(data.id);
    if (request) { pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(current, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Browser condition timed out: ${expression}`);
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await wait('document.querySelectorAll(".monaco-editor .line-numbers").length >= 6');
  await wait('document.querySelector(".change-count")?.textContent === "1 处变更"');
  const clickLine = async (side, line, shift = false) => {
    const point = await evaluate(`(() => {
      const pane = document.querySelector('.monaco-diff-editor .editor.${side === 'old' ? 'original' : 'modified'}');
      const number = [...pane.querySelectorAll('.line-numbers')].find(node => node.textContent.trim() === '${line}');
      number.scrollIntoView({block:'center'});
      const box = number.getBoundingClientRect();
      return {x:box.x+box.width/2,y:box.y+box.height/2};
    })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, modifiers: shift ? 8 : 0 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, modifiers: shift ? 8 : 0 });
  };
  await clickLine('new', 1);
  await clickLine('new', 2, true);
  await wait('document.querySelector(".selection-description")?.textContent.includes("1–2")');
  assert.equal(await evaluate('document.querySelectorAll(".editor.original .review-selected-line").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".editor-headings strong").length'), 2);
  await clickLine('old', 2, true);
  assert.match(await evaluate('document.querySelector(".selection-description").textContent'), /新版本.*1–2/);
  await evaluate('document.querySelector(".selection-actions .primary").click(); document.querySelector("#comment-body").value="需要空数组测试 <script>alert(1)</script>"; document.querySelector("#comment-form").requestSubmit();');
  await wait('document.querySelectorAll(".comment-card").length === 1');
  assert.equal(app.store.list()[0].endLine, 2);
  assert.match(app.store.list()[0].code, /export function sum/);
  assert.equal(await evaluate('document.querySelector(".comment-card script") === null'), true);
  await cdp('Page.reload');
  await wait('document.querySelectorAll(".comment-card").length === 1 && document.querySelector(".change-count")?.textContent === "1 处变更"');
  await evaluate('document.querySelector(".comment-actions button").click()');
  await wait('document.querySelectorAll(".comment-card").length === 0');
  assert.equal(app.store.list()[0].resolved, true);
  await evaluate('document.querySelector("#comment-filter").value="resolved"; document.querySelector("#comment-filter").dispatchEvent(new Event("change"));');
  await wait('document.querySelectorAll(".comment-card").length === 1');
  await evaluate('document.querySelectorAll(".comment-actions button")[1].click(); document.querySelector("#comment-body").value="编辑后的审查意见"; document.querySelector("#comment-form").requestSubmit();');
  await wait('document.querySelector(".comment-card p")?.textContent === "编辑后的审查意见"');
  await clickLine('old', 2);
  await evaluate('document.querySelector("#comment-filter").value="all"; document.querySelector("#comment-filter").dispatchEvent(new Event("change")); document.querySelector(".selection-actions .primary").click(); document.querySelector("#comment-body").value="删除行也需要检查"; document.querySelector("#comment-form").requestSubmit();');
  await wait('document.querySelectorAll(".comment-card").length === 2');
  assert.equal(app.store.list()[1].side, 'old');
  assert.equal(app.store.list()[1].code, '  return values.reduce((a, b) => a + b);');
  await evaluate('document.querySelector("#wrap-lines").click(); document.querySelector("#collapse-lines").click(); document.querySelectorAll(".editor-tools button")[1].click()');
  await evaluate('document.querySelector("#branch").value="refs/heads/initial"; document.querySelector("#branch").dispatchEvent(new Event("change"));');
  await wait('document.querySelector("#commit-detail h2")?.textContent === "Add sum helper" && document.querySelector(".change-count")?.textContent === "1 处变更"');
  assert.equal(await evaluate('document.querySelectorAll(".comment-card").length'), 0);
  assert.match(await evaluate('document.querySelector(".editor-headings").textContent'), /此版本中不存在/);
  await clickLine('old', 1);
  assert.equal(await evaluate('document.querySelector(".selection-actions").hidden'), true);
  await evaluate('document.querySelector("#comment-scope").value="all"; document.querySelector("#comment-scope").dispatchEvent(new Event("change")); document.querySelector(".comment-anchor").click();');
  await wait('document.querySelector("#commit-detail h2")?.textContent === "Handle empty arrays" && document.querySelector(".selection-description")?.textContent.includes("旧版本")');
  await evaluate('window.confirm = () => true; document.querySelectorAll(".comment-actions button")[2].click()');
  await wait('document.querySelectorAll(".comment-card").length === 1');
  assert.equal(app.store.list().length, 1);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow on mobile');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = path.join(os.tmpdir(), 'commit-review-browser.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(errors, []);
  console.log(`Browser smoke passed: multiline comments, persistence, resolve/filter, escaping, responsive layout. Screenshot: ${screenshotPath}`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)); }
  if (app) { await new Promise(resolve => app.server.close(resolve)); await app.release(); }
  await rm(root, { recursive: true, force: true });
}
