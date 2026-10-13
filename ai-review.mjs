import {randomUUID} from 'node:crypto';
import { parseArgs } from 'node:util';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBody } from './lib/reviews.mjs';

export async function runAIReview(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:4318' },
    comment: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' },
    scope:{type:'string'},shas:{type:'string'},ref:{type:'string'},path:{type:'string'},sha:{type:'string'},'start-line':{type:'string'},'end-line':{type:'string'},evidence:{type:'string'},'evidence-file':{type:'string'},revision:{type:'string'},'request-id':{type:'string'},
    help: { type: 'boolean', short: 'h' },
  } });
  if(values.help)return '使用方式：node ai-review.mjs <list|scope|target|link|reply|resolve|reopen> --repo /path/to/repo [--url http://127.0.0.1:4318]。scope --scope 页面复制指令中的范围ID：读取完整候选提交；link --scope 范围ID --comment UUID --shas 完整SHA1,完整SHA2 --revision N --request-id UUID --evidence-file 依据文件：替换当前关联，旧记录保留。reply --comment UUID --body 正文（或 --body-file 文件）。关联不改变解决状态。';
  const [action] = positionals;
  if (positionals.length !== 1 || !['list', 'scope', 'target', 'link', 'reply', 'resolve', 'reopen'].includes(action)) throw new Error('请选择 list、scope、target、link、reply、resolve 或 reopen 操作');
  if (!values.repo) throw new Error('必须提供 --repo，防止操作错误项目');
  if (action === 'list' && (values.comment || values.body !== undefined || values['body-file'] !== undefined)) throw new Error('list 不接受评论 ID 或正文');
  if (!['list','scope'].includes(action) && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(values.comment || '')) throw new Error('必须提供有效的 --comment UUID');
  if (values.body !== undefined && values['body-file'] !== undefined) throw new Error('--body 与 --body-file 不能同时使用');
  if(['scope','link'].includes(action)&&!/^[a-f0-9]{64}$/.test(values.scope||''))throw new Error('请使用当前网页复制AI指令中的 --scope 范围ID');
  if(!['scope','link'].includes(action)&&values.scope!==undefined)throw new Error('--scope 仅用于 scope/link');
  if(action!=='link'&&['shas','evidence','evidence-file','revision','request-id'].some(k=>values[k]!==undefined))throw new Error('关联参数仅用于link');
  if(['sha','start-line','end-line'].some(k=>values[k]!==undefined))throw new Error('关联已简化为 --scope 和 --shas，不再填写文件及行号');
  if(action!=='target'&&['ref','path'].some(k=>values[k]!==undefined))throw new Error('ref/path 仅用于只读 target');
  if(['scope','target','link'].includes(action)&&(values.body!==undefined||values['body-file']!==undefined))throw new Error('关联操作不接受回复正文');
  let link;
  if(action==='link'){
    const shas=(values.shas||'').split(',');
    if(!shas.length||shas.some(sha=>!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))||!/^\d+$/.test(values.revision||''))throw new Error('link需要完整SHA列表和当前关联版本');
    if(values.evidence!==undefined&&values['evidence-file']!==undefined)throw new Error('依据参数不能同时使用');
    const evidence=values['evidence-file']!==undefined?await readFile(values['evidence-file'],'utf8'):values.evidence;
    link={scope:values.scope,shas,revision:Number(values.revision),requestId:values['request-id']||randomUUID(),evidence:validateBody(evidence)};
  }
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
  if(action==='scope')return request(`/api/association-scope?id=${values.scope}`,info.token);
  if(action==='target')return request(`/api/comments/${values.comment}/target?${new URLSearchParams({ref:values.ref||'HEAD',...(values.path?{path:values.path}:{})})}`,info.token);
  if(action==='link')return request(`/api/comments/${values.comment}/associations/ai`,info.token,link);
  return request(`/api/comments/${values.comment}/ai`, info.token, { action, ...(body !== undefined ? { body } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAIReview(process.argv.slice(2)).then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
