import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { runAIReview } from '../ai-review.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../ai-review.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-ai-cli-'));
  execFileSync('git', ['-C', root, 'init', '-b', 'main'], { stdio: 'pipe' });
  const app = await createApp({ repoPath: root, dataDir: path.join(root, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.release();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const comment = await app.store.add({ sha: 'a'.repeat(40), parent: null, anchor: { fileId: '0', path: 'file', oldPath: 'file', side: 'new', startLine: 1, endLine: 1, code: 'code' }, body: '检查' });
  const options = ['--repo', root, '--url', url];
  return { root, app, comment, options };
}

test('AI CLI lists, replies, resolves and reopens through the running service', async t => {
  const { root, app, comment, options } = await fixture(t);
  const list = await execute(process.execPath, [script, 'list', ...options]);
  assert.equal(JSON.parse(list.stdout)[0].id, comment.id);
  const replied = await runAIReview(['reply', ...options, '--comment', comment.id, '--body', 'AI回复']);
  assert.equal(replied.replies[0].author, 'ai');
  const bodyFile = path.join(root, 'note.txt');
  await writeFile(bodyFile, '已修改\n测试通过\n中文与单引号 \'');
  const resolved = await execute(process.execPath, [script, 'resolve', ...options, '--comment', comment.id, '--body-file', bodyFile]);
  const result = JSON.parse(resolved.stdout);
  assert.equal(result.resolved, true);
  assert.equal(result.resolvedBy, 'ai');
  assert.match(result.replies[1].body, /测试通过/);
  await runAIReview(['reopen', ...options, '--comment', comment.id]);
  assert.equal(app.store.list()[0].resolved, false);
  await assert.rejects(execute(process.execPath, [script, 'reply', ...options, '--comment', comment.id]), error => error.code === 1 && /评论必须/.test(error.stderr));
});

test('AI CLI rejects wrong repositories, unsafe URLs, forged operations and invalid arguments', async t => {
  const { root, app, comment, options } = await fixture(t);
  for (const url of ['https://localhost:4318', 'http://example.com', 'http://user:secret@localhost', 'http://127.0.0.1/path', 'http://localhost/?token=x', 'http://localhost/#fragment']) {
    await assert.rejects(runAIReview(['list', '--repo', root, '--url', url]), /本地 HTTP/);
  }
  await assert.rejects(runAIReview(['list', '--repo', os.tmpdir(), '--url', options.at(-1)]), /不匹配/);
  for (const args of [[], ['delete', ...options], ['list'], ['reply', ...options, '--comment', 'invalid', '--body', 'text'], ['list', ...options, '--body', 'text'], ['reply', ...options, '--comment', comment.id, '--body', 'text', '--body-file', 'other']]) {
    await assert.rejects(runAIReview(args));
  }
  assert.equal(app.store.list()[0].replies, undefined);
});

test('AI CLI refuses redirected service responses', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-ai-redirect-'));
  const server = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://example.invalid/' }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(runAIReview(['list', '--repo', root, '--url', `http://127.0.0.1:${server.address().port}`]), /fetch failed/);
});
