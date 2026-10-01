import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GitRepo, validateAnchor } from './lib/git.mjs';
import { ReviewStore } from './lib/reviews.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('请求必须使用 application/json');
  if (Number(req.headers['content-length']) > 65536) {
    req.resume();
    throw new Error('请求内容超过 64 KB');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65536) {
      req.resume();
      throw new Error('请求内容超过 64 KB');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function numberParam(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error('分页参数无效');
  return Number(value);
}

export async function createApp({ repoPath, dataDir = path.join(directory, '.reviews') }) {
  const repo = await GitRepo.open(repoPath);
  const key = createHash('sha256').update(repo.path).digest('hex').slice(0, 20);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, `${key}.lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`此仓库的评论目录已被占用。请先关闭另一实例。若上次异常退出，确认无运行实例后删除锁目录：${lock}`);
    throw error;
  }
  let store;
  try {
    await writeFile(path.join(lock, 'pid'), String(process.pid));
    store = await ReviewStore.open(dataDir, repo.path);
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  const token = randomBytes(32).toString('hex');
  let cachedDiff;
  async function getDiff(sha) {
    if (cachedDiff?.sha === sha) return cachedDiff;
    const result = await repo.diff(sha);
    cachedDiff = result;
    return result;
  }
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const allowedHosts = origins.map(origin => new URL(origin).host);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      if (!allowedHosts.includes(req.headers.host) ||
          (req.headers.origin && !origins.includes(req.headers.origin)) ||
          req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '仅允许本地同源访问' });
      const url = new URL(req.url, origins[0]);
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, contentType] = staticFiles.get(url.pathname);
        const bytes = await readFile(path.join(directory, 'public', file));
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(bytes);
      }
      if (req.method === 'GET' && /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|ttf)$/.test(url.pathname)) {
        const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(url.pathname)];
        try {
          const bytes = await readFile(path.join(directory, 'public', url.pathname));
          res.writeHead(200, { 'Content-Type': contentType });
          return res.end(bytes);
        } catch { return send(404, { error: '编辑器资源不存在，请运行 npm run build' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/info') return send(200, {
        repository: repo.path, token, jsonPath: store.jsonPath, markdownPath: store.markdownPath,
      });
      // Require a token even for repository reads: another local origin must not read source code.
      const provided = Buffer.from(req.headers['x-review-token'] || '');
      const expected = Buffer.from(token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(403, { error: '会话已失效，请刷新页面' });
      if (req.method === 'GET' && url.pathname === '/api/branches') return send(200, await repo.branches());
      if (req.method === 'GET' && url.pathname === '/api/commits') {
        return send(200, await repo.commits(url.searchParams.get('ref') || 'HEAD',
          numberParam(url.searchParams.get('offset'), 0, 1000000),
          numberParam(url.searchParams.get('limit'), 50, 100) || 1));
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') return send(200, await getDiff(url.searchParams.get('sha')));
      if (req.method === 'GET' && url.pathname === '/api/file') {
        return send(200, await repo.file(await getDiff(url.searchParams.get('sha')), url.searchParams.get('fileId')));
      }
      if (req.method === 'GET' && url.pathname === '/api/comments') return send(200, store.list());
      if (req.method === 'POST' && url.pathname === '/api/comments') {
        const data = await readJson(req);
        if (!data || typeof data !== 'object') throw new Error('评论数据无效');
        const diff = await getDiff(data.sha);
        const anchor = validateAnchor(diff, data.anchor || {}, await repo.file(diff, data.anchor?.fileId));
        return send(201, await store.add({ sha: diff.sha, parent: diff.parent, anchor, body: data.body }));
      }
      const match = /^\/api\/comments\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match && req.method === 'PATCH') return send(200, await store.update(match[1], await readJson(req)));
      if (match && req.method === 'DELETE') return send(200, await store.remove(match[1]));
      return send(404, { error: '页面或接口不存在' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(400, { error: error.message || '请求失败' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const release = () => rm(lock, { recursive: true, force: true });
  return { server, repo, store, release };
}

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, port: { type: 'string', default: '4318' },
    'data-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !values.repo) {
    console.log('使用方式：node server.mjs --repo /absolute/path/to/repo [--port 4318] [--data-dir /path/to/data]');
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new Error('端口必须为 1–65535');
  const app = await createApp({ repoPath: values.repo, dataDir: values['data-dir'] && path.resolve(values['data-dir']) });
  app.server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请使用 --port 指定其他端口' : error.message);
    await app.release();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    app.server.close(async () => { await app.release(); process.exit(0); });
    app.server.closeIdleConnections();
  });
  app.server.listen(Number(values.port), '127.0.0.1', () => {
    console.log(`\nCommit Review → http://127.0.0.1:${values.port}\n仓库：${app.repo.path}\nAI 评论文件：${app.store.markdownPath}\n按 Ctrl+C 停止。\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
