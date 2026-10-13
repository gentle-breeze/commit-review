import { parseArgs } from 'node:util';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBody } from './lib/reviews.mjs';

export async function runAIReview(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:4318' },
    comment: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return '使用方式：node ai-review.mjs <list|reply|resolve|reopen> --repo /path/to/repo [--url http://127.0.0.1:4318] [--comment UUID] [--body "回复内容" | --body-file /path/to/text]\nreply 必须提供正文；resolve/reopen 可附带说明。AI 标签表示操作来源，不是模型身份验证。';
  const [action] = positionals;
  if (positionals.length !== 1 || !['list', 'reply', 'resolve', 'reopen'].includes(action)) throw new Error('请选择 list、reply、resolve 或 reopen 操作');
  if (!values.repo) throw new Error('必须提供 --repo，防止操作错误项目');
  if (action === 'list' && (values.comment || values.body !== undefined || values['body-file'] !== undefined)) throw new Error('list 不接受评论 ID 或正文');
  if (action !== 'list' && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(values.comment || '')) throw new Error('必须提供有效的 --comment UUID');
  if (values.body !== undefined && values['body-file'] !== undefined) throw new Error('--body 与 --body-file 不能同时使用');
  const body = values['body-file'] !== undefined ? await readFile(values['body-file'], 'utf8') : values.body;
  if (action === 'reply' || body !== undefined) validateBody(body);
  const url = new URL(values.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--url 必须为本地 HTTP 服务地址（localhost 或 127.0.0.1），不能包含路径、凭证或查询参数');
  let projectId;
  const request = async (route, token, data) => {
    const response = await fetch(new URL(route, url), {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { 'X-Review-Token': token } : {}), ...(projectId ? { 'X-Review-Project': projectId } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
  const repository = await realpath(values.repo);
  let info = await request('/api/info');
  if (info.multiRepository) info = await request('/api/repository', info.token, {repository});
  projectId = info.projectId;
  if (!info.repository || repository !== info.repository) throw new Error('服务当前项目与 --repo 不匹配，请确认服务地址及项目的根目录');
  if (action === 'list') return request('/api/comments', info.token);
  return request(`/api/comments/${values.comment}/ai`, info.token, { action, ...(body !== undefined ? { body } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAIReview(process.argv.slice(2)).then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
