import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, access, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../server.mjs', import.meta.url));

for (const customDirectory of [false, true]) test(`CLI starts without --repo (${customDirectory ? 'custom' : 'default'} project directory)`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-cli-'));
  const dataDir = path.join(root, 'data');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [script, '--port', String(port), '--data-dir', dataDir, ...(customDirectory ? ['--projects-dir', root] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI did not start: ${output}\n${errors}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Commit Review →')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}: ${errors}`)); });
  });
  assert.match(output, /请在网页中选择/);
  const response = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.repository, null);
  const listing = await (await fetch(`http://127.0.0.1:${port}/api/repositories`, { headers: { 'X-Review-Token': info.token } })).json();
  assert.equal(listing.directory, await realpath(customDirectory ? root : path.dirname(path.dirname(script))));
  if (customDirectory) assert.deepEqual(listing.projects, []);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  child.kill('SIGTERM');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(errors, '');
});

test('CLI help documents optional --repo and explicit invalid options still fail', () => {
  const help = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(help, /\[--repo /);
  assert.match(help, /未指定 --repo/);
  for (const args of [['--port', 'invalid'], ['--repo', '/nonexistent-review-test-repository']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' }), error => error.status === 1);
  }
});
