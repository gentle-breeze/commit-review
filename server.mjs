import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GitRepo, validateAnchor } from './lib/git.mjs';
import { ReviewStore } from './lib/reviews.mjs';
import { FileIndex } from './lib/file-index.mjs';
import { discoverProjects } from './lib/projects.mjs';

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

export async function createApp({ repoPath, projectsDir = path.dirname(directory), dataDir = path.join(directory, '.reviews') } = {}) {
  const sessions = new Map();
  let defaultSession, released = false, opening = Promise.resolve();
  const token = randomBytes(32).toString('hex');
  const info = (session = defaultSession) => ({
    repository: session?.repo.path ?? null, token: session?.token ?? token,
    multiRepository: true, projectId: session?.id ?? null,
    jsonPath: session?.store.jsonPath ?? null, markdownPath: session?.store.markdownPath ?? null,
    aiScriptPath: path.join(directory, 'ai-review.mjs'),
  });
  function openRepository(input) {
    const result = opening.then(async () => {
      if (released) throw new Error('服务正在关闭');
      const repo = await GitRepo.open(input);
      const key = createHash('sha256').update(repo.path).digest('hex').slice(0, 20);
      if (sessions.has(key)) {
        const existing = sessions.get(key);
        if (existing.repo.path !== repo.path) throw new Error('项目标识冲突');
        return info(existing);
      }
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const lock = path.join(dataDir, `${key}.lock`);
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error(`此仓库的评论目录已被占用。请先关闭另一实例。若上次异常退出，确认无运行实例后删除锁目录：${lock}`);
        throw error;
      }
      try {
        await writeFile(path.join(lock, 'pid'), String(process.pid));
        const store = await ReviewStore.open(dataDir, repo.path);
        sessions.set(key, { id: key, repo, store, lock, token: randomBytes(32).toString('hex'), cachedDiff: null, reviewScopes: new Map(), associationScopes: new Map(), fileIndex: new FileIndex(repo) });
      } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return info(sessions.get(key));
    });
    opening = result.catch(() => {});
    return result;
  }
  if (repoPath !== undefined) {
    const selected = await openRepository(repoPath);
    defaultSession = sessions.get(selected.projectId);
  }
  // Legacy unscoped requests work only for a fixed default or a single open repository.
  const legacySession = () => defaultSession || (sessions.size === 1 ? sessions.values().next().value : undefined);
  async function getDiff(session, sha, fileId) {
    if (session.cachedDiff?.sha === sha && (fileId === undefined ? session.cachedDiff.focusedFileId === undefined : session.cachedDiff.files.some(file => file.id === fileId))) return session.cachedDiff;
    const result = await session.repo.diff(sha, fileId);
    session.cachedDiff = result;
    return result;
  }
  const scopeKey = scope => JSON.stringify([scope.status,scope.head,scope.base,scope.comparisonRef,...(scope.author ? [scope.author] : [])]);
  function reviewSnapshot(session, id) {
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new Error('审查范围标识无效');
    const saved=session.reviewScopes.get(id);
    if(!saved)throw new Error('审查范围已失效，请刷新页面重新加载范围');
    return saved;
  }
  async function createReviewSnapshot(session, options) {
    const scope=await session.repo.authorScope(await session.repo.reviewScope(options.ref, options), options.author);
    const snapshot={id:randomBytes(32).toString('hex'),scope,scopeKey:scopeKey(scope)};
    session.reviewScopes.set(snapshot.id,snapshot);
    if(session.reviewScopes.size>32)session.reviewScopes.delete(session.reviewScopes.keys().next().value);
    return {id:snapshot.id,scopeKey:snapshot.scopeKey,...scope};
  }
  async function associationScope(session, {ref, id}) {
    if(id!==undefined&&id!==null){
      if(!/^[a-f0-9]{64}$/.test(id))throw new Error('审查范围标识无效');
      const fixed=session.reviewScopes.get(id);
      if(fixed){
        if(!fixed.association){
          const commits=[];
          let page;
          do {
            page=await session.repo.commitPage(fixed.scope,commits.length,100);
            commits.push(...page.commits);
            if(commits.length>=5000&&page.hasMore)throw new Error('审查范围超过 5000 条提交，无法加载完整关联候选；请缩小范围。');
          } while(page.hasMore);
          fixed.association={id,ref:fixed.scope.ref,scopeKey:fixed.scopeKey,...fixed.scope,commits};
        }
        return fixed.association;
      }
      const saved=session.associationScopes.get(id);
      if(!saved)throw new Error('审查范围已失效，请从当前页面重新复制AI指令或打开修改关联');
      if(scopeKey(await session.repo.reviewScope(saved.ref))!==saved.scopeKey)throw new Error('审查范围已变化，请刷新页面后重新选择关联');
      return saved;
    }
    const scope=await session.repo.reviewScope(ref), commits=[];
    let page;
    do {page=await session.repo.commitPage(scope,commits.length,100);commits.push(...page.commits);} while(page.hasMore);
    if(scopeKey(await session.repo.reviewScope(ref))!==scopeKey(scope))throw new Error('审查范围已变化，请刷新后重试');
    const key=scopeKey(scope), token=createHash('sha256').update(JSON.stringify([session.id,ref,key])).digest('hex');
    const result={id:token,ref,scopeKey:key,commits};
    session.associationScopes.set(token,result);
    if(session.associationScopes.size>32)session.associationScopes.delete(session.associationScopes.keys().next().value);
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
      if (req.method === 'GET' && url.pathname === '/api/info') return send(200, info());
      // Bind project identity and token before reading any repository or comment data.
      const projectId = req.headers['x-review-project'];
      if (projectId !== undefined && (typeof projectId !== 'string' || !/^[a-f0-9]{20}$/.test(projectId) || !sessions.has(projectId))) return send(403, { error: '项目会话无效，请重新选择项目' });
      const management = ['/api/repositories', '/api/repository'].includes(url.pathname);
      const session = projectId ? sessions.get(projectId) : legacySession();
      const provided = Buffer.from(req.headers['x-review-token'] || '');
      const allowedToken = projectId ? session.token : management ? (defaultSession?.token ?? token) : session?.token;
      // For old picker clients only, the bootstrap token can address the sole session.
      const matches = value => { const expected = Buffer.from(value || ''); return provided.length > 0 && provided.length === expected.length && timingSafeEqual(provided, expected); };
      const bootstrapLegacy = !projectId && !defaultSession && sessions.size <= 1 && matches(token);
      if (!matches(allowedToken) && !bootstrapLegacy) return send(403, { error: '会话已失效或项目不匹配，请刷新页面' });
      if (req.method === 'GET' && url.pathname === '/api/repositories') return send(200, await discoverProjects(projectsDir));
      if (req.method === 'POST' && url.pathname === '/api/repository') {
        const data = await readJson(req);
        if (!data || typeof data.repository !== 'string' || !data.repository.trim() || !path.isAbsolute(data.repository) || data.repository.includes('\0')) throw new Error('请选择需要 Review 的 Git 项目');
        return send(200, await openRepository(data.repository));
      }
      if (!session && url.pathname.startsWith('/api/')) return send(409, { error: '请先选择需要 Review 的 Git 项目；多项目请求必须指定项目标识' });
      const { repo, store } = session || {};
      if (req.method === 'GET' && url.pathname === '/api/branches') return send(200, await repo.branches({includeRemote:url.searchParams.get('all')==='1'}));
      if (req.method === 'GET' && url.pathname === '/api/review-scope') return send(200, await createReviewSnapshot(session, {
        author:url.searchParams.get('author') || '',mode:url.searchParams.get('mode') || 'unpushed',ref:url.searchParams.get('ref') || 'HEAD',base:url.searchParams.get('base') ?? undefined,
      }));
      if (req.method === 'GET' && url.pathname === '/api/commits') {
        if(url.searchParams.has('scope')){
          const snapshot=reviewSnapshot(session,url.searchParams.get('scope'));
          return send(200,{...await repo.commitPage(snapshot.scope,numberParam(url.searchParams.get('offset'),0,1000000),numberParam(url.searchParams.get('limit'),50,100)||1),id:snapshot.id,scopeKey:snapshot.scopeKey});
        }
        return send(200, await repo.commits(url.searchParams.get('ref') || 'HEAD',
          numberParam(url.searchParams.get('offset'), 0, 1000000),
          numberParam(url.searchParams.get('limit'), 50, 100) || 1));
      }
      if (req.method === 'GET' && url.pathname === '/api/file-index') {
        const fixed=url.searchParams.has('scope')?reviewSnapshot(session,url.searchParams.get('scope')):null;
        return send(200, await session.fileIndex.page({ref:url.searchParams.get('ref') || 'HEAD',scope:fixed?.scope,scopeId:fixed?.id,snapshotId:url.searchParams.get('snapshot') || undefined,offset:numberParam(url.searchParams.get('offset'),0,4999)}));
      }
      if (req.method === 'GET' && ['/api/comparison', '/api/comparison-file'].includes(url.pathname)) {
        const snapshot = reviewSnapshot(session, url.searchParams.get('scope'));
        // Cache only within this project and immutable scope, never in the commit diff cache.
        snapshot.comparison ??= repo.comparison(snapshot.scope).catch(error => { delete snapshot.comparison; throw error; });
        const diff = await snapshot.comparison;
        return send(200, url.pathname === '/api/comparison' ? {...diff, scopeId:snapshot.id} : await repo.file(diff, url.searchParams.get('fileId')));
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') return send(200, await getDiff(session, url.searchParams.get('sha'), url.searchParams.get('fileId') ?? undefined));
      if (req.method === 'GET' && url.pathname === '/api/file') {
        return send(200, await repo.file(await getDiff(session, url.searchParams.get('sha'), url.searchParams.get('fileId') ?? undefined), url.searchParams.get('fileId')));
      }
      if (req.method === 'GET' && url.pathname === '/api/comments') return send(200, store.list());
      if (req.method === 'POST' && url.pathname === '/api/comments') {
        const data = await readJson(req);
        if (!data || typeof data !== 'object') throw new Error('评论数据无效');
        const diff = await getDiff(session, data.sha, data.anchor?.fileId);
        const anchor = validateAnchor(diff, data.anchor || {}, data.anchor?.kind === 'file' ? undefined : await repo.file(diff, data.anchor?.fileId));
        return send(201, await store.add({ sha: diff.sha, parent: diff.parent, anchor, body: data.body }));
      }
      if(req.method==='GET'&&url.pathname==='/api/association-scope')return send(200,await associationScope(session,{ref:url.searchParams.get('ref')||'HEAD',id:url.searchParams.get('id')}));
      const associationMatch=/^\/api\/comments\/([a-f0-9-]{36})\/associations(\/ai)?$/.exec(url.pathname);
      if(associationMatch&&req.method==='POST'){
        const data=await readJson(req),source=associationMatch[2]?'ai':'user';
        if(!data||Array.isArray(data)||Object.keys(data).some(key=>!['scope','shas','revision','requestId',...(source==='ai'?['evidence']:[])].includes(key))||typeof data.scope!=='string'||!/^[a-f0-9]{64}$/.test(data.scope)||!Array.isArray(data.shas)||data.shas.length>100||data.shas.some(sha=>typeof sha!=='string'))throw new Error('关联选择无效');
        const snapshot=await associationScope(session,{id:data.scope}), bySha=new Map(snapshot.commits.map(c=>[c.sha,c]));
        if(data.shas.some(sha=>!bySha.has(sha)))throw new Error('只能选择当前项目本次审查范围中的提交');
        return send(200,await store.replaceAssociations(associationMatch[1],{...data,source,targets:[...new Set(data.shas)].map(sha=>({sha,subject:bySha.get(sha).subject,kind:'commit'}))}));
      }
      const latestMatch=/^\/api\/comments\/([a-f0-9-]{36})\/latest$/.exec(url.pathname);
      if(latestMatch&&req.method==='POST'){
        const comment=store.list().find(item=>item.id===latestMatch[1]);if(!comment)throw new Error('评论不存在');
        const data=await readJson(req);
        if(!data||!Array.isArray(data.ids)||data.ids.length>100||Object.keys(data).some(key=>key!=='ids')||data.ids.some(id=>typeof id!=='string'))throw new Error('关联选择范围无效');
        return send(200,await repo.latestFollowup(comment,data.ids));
      }
      const linkMatch = /^\/api\/comments\/([a-f0-9-]{36})\/(target|links)(\/ai)?$/.exec(url.pathname);
      if (linkMatch) {
        const comment=store.list().find(item=>item.id===linkMatch[1]);
        if(!comment)throw new Error('评论不存在');
        if(req.method==='GET' && linkMatch[2]==='target' && !linkMatch[3]) return send(200,await repo.commentTarget(comment,url.searchParams.get('ref')||'HEAD',url.searchParams.get('path')||undefined));
        if(req.method==='POST' && linkMatch[2]==='links') {
          throw new Error('关联接口已简化，请刷新页面，使用当前审查范围多选替换关联');
        }
      }
      const replyEditMatch = /^\/api\/comments\/([a-f0-9-]{36})\/replies\/([a-f0-9-]{36})(\/restore)?$/.exec(url.pathname);
      if(replyEditMatch && (replyEditMatch[3] ? req.method==='POST' : ['PATCH','DELETE'].includes(req.method))) {
        const data=await readJson(req);
        if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['body','revision','requestId'].includes(key)))throw new Error('回复修改字段无效');
        return send(200,await store.mutateReply(replyEditMatch[1],replyEditMatch[2],{...data,action:replyEditMatch[3]?'restore':req.method==='DELETE'?'delete':'edit'}));
      }
      const replyMatch = /^\/api\/comments\/([a-f0-9-]{36})\/(replies|ai)$/.exec(url.pathname);
      if (replyMatch && req.method === 'POST') {
        const data = await readJson(req);
        if (replyMatch[2] === 'ai') return send(200, await store.aiAction(replyMatch[1], data));
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'body')) throw new Error('回复只支持 body 字段');
        return send(201, await store.reply(replyMatch[1], data.body));
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
  let releasing;
  const release = () => {
    released = true;
    return releasing ??= (async () => {
      await opening;
      for (const session of sessions.values()) {
        await session.store.queue;
        await rm(session.lock, { recursive: true, force: true });
      }
    })();
  };
  return { server, get repo() { return legacySession()?.repo; }, get store() { return legacySession()?.store; }, release };
}

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, port: { type: 'string', default: '4318' },
    'data-dir': { type: 'string' }, 'projects-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('使用方式：node server.mjs [--repo /absolute/path/to/repo] [--port 4318] [--data-dir /path/to/data] [--projects-dir /path/to/projects]\n未指定 --repo 时，在网页下拉框中选择项目；默认列出工具所在目录的同级 Git 项目。');
    return;
  }
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new Error('端口必须为 1–65535');
  const app = await createApp({ repoPath: values.repo, dataDir: values['data-dir'] && path.resolve(values['data-dir']),
    projectsDir: values['projects-dir'] && path.resolve(values['projects-dir']) });
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
    const target = app.repo ? `仓库：${app.repo.path}\nAI 评论文件：${app.store.markdownPath}` : '请在网页中选择需要 Review 的 Git 项目。';
    console.log(`\nCommit Review → http://127.0.0.1:${values.port}\n${target}\n按 Ctrl+C 停止。\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
