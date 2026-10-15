import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_FILES = 300;
const MAX_PATCH = 12 * 1024 * 1024;
const MAX_FILE_LINES = 6000;

async function git(directory, args, maxBuffer = MAX_PATCH) {
  const { stdout } = await execute('git', ['--no-pager', '--literal-pathspecs', '-C', directory,
    '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false',
    '-c', 'log.showNotes=false', '-c', 'diff.suppressBlankEmpty=false', ...args], {
    encoding: 'utf8', timeout: 20000, maxBuffer,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  return stdout;
}

function parseHunks(patch) {
  const hunks = [];
  let hunk, oldLine = 0, newLine = 0, additions = 0, deletions = 0, count = 0, truncated = false;
  for (const text of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[2]);
      hunk = { header: text, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    let line;
    if (text.startsWith('+')) { line = { type: 'add', oldLine: null, newLine: newLine++, text: text.slice(1) }; additions++; }
    else if (text.startsWith('-')) { line = { type: 'delete', oldLine: oldLine++, newLine: null, text: text.slice(1) }; deletions++; }
    else if (text.startsWith(' ')) line = { type: 'context', oldLine: oldLine++, newLine: newLine++, text: text.slice(1) };
    else if (text.startsWith('\\')) line = { type: 'meta', oldLine: null, newLine: null, text };
    else continue;
    if (++count > MAX_FILE_LINES) { truncated = true; continue; }
    hunk.lines.push(line);
  }
  return { hunks: hunks.filter(hunk => hunk.lines.length), additions, deletions, truncated };
}

export class GitRepo {
  static async open(input) {
    if (typeof input !== 'string' || !input) throw new Error('请指定 Git 仓库路径');
    try {
      const directory = await realpath(input);
      const top = (await git(directory, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
      return new GitRepo(await realpath(top));
    } catch { throw new Error('无法打开 Git 工作区，请检查 --repo 路径（不支持裸仓库）'); }
  }

  constructor(directory) { this.path = directory; }

  async branches({includeRemote = false} = {}) {
    const output = await git(this.path, ['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(symref)', 'refs/heads', ...(includeRemote ? ['refs/remotes'] : [])]);
    return output.trimEnd().split('\n').filter(Boolean).flatMap(line => {
      const [name, marker, symbolic] = line.split('\0');
      return symbolic ? [] : [{ name, current: marker === '*' }];
    });
  }

  async resolve(ref) {
    if (typeof ref !== 'string' || !ref || ref.length > 1024 || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) throw new Error('Git 引用无效');
    try { return (await git(this.path, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
    catch { throw new Error('找不到指定的 commit 或分支'); }
  }

  async reviewScope(ref = 'HEAD', {mode = 'unpushed', base: baseRef} = {}) {
    if (!['unpushed', 'compare', 'history'].includes(mode)) throw new Error('提交范围模式无效');
    const empty = (status, message, upstream = null) => ({ mode, ref, commits: [], hasMore: false, status, message, upstream });
    if (mode !== 'unpushed') {
      const branches = await this.branches({includeRemote: true});
      const branchName = async value => {
        if (value === 'HEAD') {
          try { value = (await git(this.path, ['symbolic-ref', '--quiet', 'HEAD'])).trim(); }
          catch { throw new Error('HEAD 未指向分支，请选择本地或远程跟踪分支。'); }
        }
        if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('-') || /[\x00-\x20\x7f]/.test(value)) throw new Error('Git 分支引用无效');
        const found = branches.find(branch => branch.name === value || branch.name === `refs/heads/${value}` || branch.name === `refs/remotes/${value}`);
        if (!found) throw new Error('找不到指定的分支，请选择本地或远程跟踪分支');
        return found.name;
      };
      // Empty repositories may open in history mode, but a missing explicit branch is an error.
      if (ref === 'HEAD' && !branches.length) return empty('unborn', '当前仓库暂无提交。');
      const branch = await branchName(ref), head = await this.resolve(branch);
      if (mode === 'history') return {status:'ready', mode, ref:branch, head, base:null, upstream:null, comparisonRef:null, comparisonMode:'history', message:'此分支暂无历史提交。'};
      const comparisonRef = await branchName(baseRef), base = await this.resolve(comparisonRef);
      let mergeBase;
      try { mergeBase = (await git(this.path, ['merge-base', base, head])).trim(); }
      catch (error) {
        if (error.code === 1) throw new Error('基准分支与待审分支没有共同祖先，无法比较；请改用历史提交。');
        throw new Error('无法计算分支共同祖先，请检查仓库历史是否完整。');
      }
      return {status:'ready', mode, ref:branch, head, base, upstream:null, comparisonRef, comparisonMode:'branches', mergeBase,
        message:'待审分支没有基准分支尚未包含的主线提交。'};
    }
    let branch = ref;
    if (ref === 'HEAD') {
      try { branch = (await git(this.path, ['symbolic-ref', '--quiet', 'HEAD'])).trim(); }
      catch { return empty('detached', 'HEAD 未指向本地分支，请选择一个本地分支。'); }
    } else {
      await this.resolve(ref);
      branch = ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`;
    }
    const branches = await this.branches();
    if (!branches.some(item => item.name === branch)) {
      if (ref === 'HEAD') return empty('unborn', '当前分支暂无提交。');
      throw new Error('请选择本地分支');
    }
    const sha = await this.resolve(branch);
    const upstream = (await git(this.path, ['for-each-ref', '--format=%(upstream)', branch])).trim();
    let base, comparisonRef, comparisonMode;
    if (upstream.startsWith('refs/remotes/')) {
      try { base = await this.resolve(upstream); comparisonRef = upstream; comparisonMode = 'upstream'; }
      catch { /* Missing remote refs fall back to a local base branch. */ }
    }
    if (!base) {
      comparisonRef = ['refs/heads/main', 'refs/heads/master'].find(name => branches.some(item => item.name === name));
      if (!comparisonRef) return empty('no-base', '没有可用的远程跟踪分支，也没有本地 main/master 分支，无法比较。');
      base = await this.resolve(comparisonRef);
      comparisonMode = 'local-base';
    }
    return { status: 'ready', mode, ref, head: sha, base, upstream: upstream || null, comparisonRef, comparisonMode,
      message: comparisonMode === 'upstream' ? '此分支没有未 push 的主线提交。' : `此分支没有相对 ${comparisonRef.replace('refs/heads/', '')} 独有的主线提交。` };
  }

  async commits(ref = 'HEAD', offset = 0, limit = 50) {
    return this.commitPage(await this.reviewScope(ref), offset, limit);
  }

  async commitPage(scope, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页参数无效');
    if (scope.status !== 'ready') return { ...scope, commits: [], hasMore: false };
    const {base, head: sha} = scope;
    const output = await git(this.path, ['log', '--first-parent', '-z', '--no-show-signature', '--no-decorate',
      '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%b', `--skip=${offset}`, `--max-count=${limit + 1}`, scope.mode === 'history' ? sha : `${base}..${sha}`, '--']);
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const [id, parents, subject, author, date, body] = fields.slice(i, i + 6);
      commits.push({ sha: id, parents: parents ? parents.split(' ') : [], subject, author, date, body });
    }
    return { ...scope, commits: commits.slice(0, limit), hasMore: commits.length > limit };
  }

  async fileChanges(commit) {
    if (!SHA.test(commit.sha) || commit.parents.some(parent => !SHA.test(parent))) throw new Error('提交标识无效');
    const base = commit.parents[0] ? ['diff', commit.parents[0], commit.sha] : ['diff-tree', '--root', '--no-commit-id', '-r', commit.sha];
    const fields = (await git(this.path, [...base, '--no-ext-diff', '--no-textconv', '--no-relative', '-M', '--raw', '--numstat', '-z', '--'])).split('\0');
    const files = []; let i = 0;
    while (fields[i]?.startsWith(':')) {
      const match = /^:[0-7]+ [0-7]+ [a-f0-9]+ [a-f0-9]+ ([A-Z][0-9]*)$/.exec(fields[i++]);
      if (!match) throw new Error('无法解析文件改动元数据');
      const status = match[1], oldPath = fields[i++], nextPath = /^[RC]/.test(status) ? fields[i++] : oldPath;
      if (oldPath === undefined || nextPath === undefined) throw new Error('文件路径元数据不完整');
      files.push({id:String(files.length),path:nextPath,oldPath,status});
    }
    const stats = new Map();
    while (fields[i]) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i++]);
      if (!match) throw new Error('无法解析文件增删统计');
      const oldPath = match[3] || fields[i++], nextPath = match[3] || fields[i++];
      if (oldPath === undefined || nextPath === undefined) throw new Error('文件统计路径不完整');
      stats.set(`${oldPath}\0${nextPath}`, {binary:match[1]==='-', additions:match[1]==='-'?null:Number(match[1]), deletions:match[2]==='-'?null:Number(match[2])});
    }
    for (const file of files) {
      const stat = stats.get(`${file.oldPath}\0${file.path}`);
      if (!stat) throw new Error('文件改动与统计不匹配');
      Object.assign(file, stat);
    }
    return files;
  }

  async latestFollowup(comment, ids) {
    const links=(comment.followups||[]).filter(link=>!link.removedAt&&ids.includes(link.id));
    const ranked=[], skipped=[];
    for(const link of links){
      try{
        const sha=await this.resolve(link.sha);
        const [date,parents]=(await git(this.path,['show','-s','--format=%aI%n%P',sha,'--'])).trimEnd().split('\n');
        ranked.push({link,date,parents:parents?parents.split(' '):[]});
      }catch{skipped.push({id:link.id,sha:link.sha,reason:'提交对象不可读'});}
    }
    let order=[];
    if(ranked.length)order=(await git(this.path,['rev-list','--first-parent','--topo-order','--max-count=10000',...[...new Set(ranked.map(item=>item.link.sha))].sort(),'--'])).trim().split('\n');
    const position=sha=>{const i=order.indexOf(sha);return i<0?Infinity:i;};
    ranked.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)||position(a.link.sha)-position(b.link.sha)||a.link.sha.localeCompare(b.link.sha)||a.link.id.localeCompare(b.link.id));
    for(const item of ranked){
      try{
        if(item.link.kind==='commit')return {link:item.link,date:item.date,skipped};
        const target=await this.commentTarget(comment,item.link.sha,item.link.path);
        if(target.unavailable||item.link.endLine>target.lineCount)throw new Error(target.unavailable||'保存的行范围不可定位');
        const file=(await this.fileChanges({sha:item.link.sha,parents:item.parents})).find(file=>file.path===item.link.path&&!file.status.startsWith('D'));
        return {link:item.link,date:item.date,fileId:file?.id,skipped};
      }catch(error){skipped.push({id:item.link.id,sha:item.link.sha,reason:error.message});}
    }
    return {link:null,skipped};
  }

  async commentTarget(comment, ref, explicitPath) {
    const sha = await this.resolve(ref);
    const originalPath = comment.side === 'old' ? comment.oldPath : comment.path;
    let name = explicitPath || originalPath;
    const warnings = [];
    if (!explicitPath) {
      try {
        const changes = await this.fileChanges({sha, parents:[comment.side === 'old' ? comment.parent || comment.sha : comment.sha]});
        const renamed = changes.filter(file => file.status.startsWith('R') && file.oldPath === originalPath);
        if (renamed.length === 1) name = renamed[0].path;
      } catch { warnings.push('原始对象不可读或重命名线索不可用；请人工核对目标路径。'); }
    }
    if (typeof name !== 'string' || !name || name.length > 4096 || name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) throw new Error('目标相对路径无效');
    if (comment.kind === 'file') return {sha,path:name,kind:'file',warnings,candidates:[],
      unavailable:'文件级评论不支持行定位，请在目标提交按路径查看整个文件。'};
    const versions = await this.file({sha,parent:null,files:[{id:'target',path:name,oldPath:name,status:'M'}]},'target');
    if (versions.unavailable) return {sha,path:name,warnings,unavailable:versions.unavailable,candidates:[]};
    const text=versions.new.text, lines=text.split('\n');
    if (lines.at(-1)==='') lines.pop();
    const candidates=[]; const needle=comment.code?.replace(/\r\n?/g,'\n');
    if (needle?.trim()) {
      let from=0, index;
      while ((index=text.indexOf(needle,from))>=0 && candidates.length<20) {
        const startLine=text.slice(0,index).split('\n').length;
        const endLine=startLine+needle.replace(/\n$/,'').split('\n').length-1;
        candidates.push({startLine,endLine,basis:'exact-text'});from=index+1;
      }
      if (index>=0 && candidates.length===20) warnings.push('最多展示 20 个文本匹配位置，可能还有更多；请人工选择。');
    }
    if (!candidates.length && lines.length) candidates.push({startLine:Math.min(comment.startLine,lines.length),endLine:Math.min(comment.endLine,lines.length),basis:'path-only'});
    return {sha,path:name,text,lineCount:lines.length,candidates,warnings,
      message:'位置候选不是提交身份映射，也不是问题已解决的证据；文本相同也可能存在业务问题。请按代码和提交证据核对；AI可先建立初步关联，用户可后续确认或纠正，可关联多个提交。'};
  }

  async file(diff, fileId) {
    const file = diff.files.find(file => file.id === fileId);
    if (!file) throw new Error('无法定位评论文件');
    if (file.binary) return { fileId, unavailable: '二进制文件不支持文本比较' };
    const readVersion = async (sha, name, absent) => {
      if (!sha || absent) return { text: '', lineCount: 0, exists: false };
      const entry = await git(this.path, ['ls-tree', '-z', sha, '--', name]);
      const record = entry.split('\0').find(value => value.slice(value.indexOf('\t') + 1) === name);
      const match = record && /^([0-7]+) (blob|commit|tree) ([a-f0-9]+)\t/.exec(record);
      if (!match || match[2] !== 'blob') throw new Error('子模块或非普通文本对象不支持编辑器比较');
      const size = Number((await git(this.path, ['cat-file', '-s', match[3]])).trim());
      if (size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB，未加载全文');
      const { stdout } = await execute('git', ['-C', this.path, 'cat-file', 'blob', match[3]], {
        encoding: 'buffer', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      if (stdout.includes(0)) throw new Error('二进制文件不支持文本比较');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); }
      catch { throw new Error('非 UTF-8 文件不支持编辑器比较'); }
      // Monaco normalizes all line endings; keep API anchors on the same logical lines.
      text = text.replace(/\r\n?/g, '\n');
      const lineCount = sourceLines(text).length;
      if (lineCount > 20000) throw new Error('文件超过 20000 行，未加载全文');
      return { text, lineCount, exists: true };
    };
    try {
      const old = await readVersion(diff.parent, file.oldPath, file.status.startsWith('A'));
      const next = await readVersion(diff.sha, file.path, file.status.startsWith('D'));
      return { fileId, old, new: next };
    } catch (error) { return { fileId, unavailable: error.message }; }
  }

  async diff(sha, selectedFileId) {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('请提供完整 commit SHA');
    const resolved = await this.resolve(sha);
    if (resolved !== sha) throw new Error('对象不是 commit');
    const info = await git(this.path, ['show', '-s', '--no-show-signature', '--format=%P%x00%s%x00%b%x00%an%x00%aI', sha, '--']);
    const [parentString, subject, body, author, date] = info.replace(/\n$/, '').split('\0');
    const parents = parentString ? parentString.split(' ') : [];
    const parent = parents[0] || null;
    const base = parent ? ['diff', parent, sha] : ['diff-tree', '--root', '--no-commit-id', '-r', sha];
    const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--submodule=short', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', '-M'];
    const metadata = (await git(this.path, [...base, ...options, '--name-status', '-z', '--'])).split('\0');
    const files = [];
    for (let i = 0; i < metadata.length && metadata[i];) {
      const status = metadata[i++];
      const oldPath = metadata[i++];
      const newPath = /^[RC]/.test(status) ? metadata[i++] : oldPath;
      if (oldPath === undefined || newPath === undefined) throw new Error('Git 文件列表不完整');
      files.push({ id: String(files.length), path: newPath, oldPath, status, binary: false, truncated: false, additions: 0, deletions: 0, hunks: [] });
    }
    let selected;
    if (selectedFileId !== undefined) {
      if (typeof selectedFileId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(selectedFileId)) throw new Error('文件标识无效');
      selected = files.find(file => file.id === selectedFileId);
      if (!selected) throw new Error('无法定位评论文件');
    }
    const result = { sha, parent, parents, subject, body, author, date, files: selected ? [selected] : files.slice(0, MAX_FILES), truncated: !selected && files.length > MAX_FILES, ...(selected ? {focusedFileId:selected.id} : {}) };
    if (!files.length) return result;
    let patch;
    try {
      patch = await git(this.path, [...base, ...options, '--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--', ...(selected ? [...new Set([selected.oldPath, selected.path])] : [])]);
    } catch (error) {
      if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('读取 diff 失败或超时');
      result.truncated = true;
      result.files.forEach(file => { file.truncated = true; });
      return result;
    }
    const blocks = patch.split(/^diff --git /m).slice(1);
    if (blocks.length !== (selected ? 1 : files.length)) {
      if (!selected) throw new Error('Git diff 与文件列表不匹配，无法安全定位评论');
      result.truncated = true; selected.truncated = true; return result;
    }
    result.files.forEach((file, index) => {
      const block = blocks[index];
      file.binary = /^Binary files .* differ$/m.test(block) || /^GIT binary patch$/m.test(block);
      Object.assign(file, parseHunks(block));
      if (file.truncated) result.truncated = true;
    });
    return result;
  }
}

export function sourceLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.replace(/\r$/, ''));
}

export function validateAnchor(diff, anchor, versions) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) throw new Error('评论位置无效');
  if ('kind' in anchor && !['file', 'line'].includes(anchor.kind)) throw new Error('评论位置类型无效');
  if (anchor.kind === 'file') {
    if (Object.keys(anchor).some(key => !['kind', 'fileId'].includes(key))) throw new Error('文件评论只接受文件标识，不接受行号或路径');
    const file = typeof anchor.fileId === 'string' && diff.files.find(file => file.id === anchor.fileId);
    if (!file) throw new Error('无法定位评论文件');
    return { kind:'file', fileId:file.id, path:file.path, oldPath:file.oldPath, status:file.status,
      side:file.status.startsWith('D') ? 'old' : 'new', code:'' };
  }
  const kind = anchor.kind === 'line' ? {kind:'line'} : {};
  const { fileId, side, startLine, endLine, startColumn, endColumn } = anchor;
  const precise = 'startColumn' in anchor || 'endColumn' in anchor;
  const lastCoveredLine = precise && endColumn === 1 && endLine > startLine ? endLine - 1 : endLine;
  if (typeof fileId !== 'string' || !['old', 'new'].includes(side) || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || lastCoveredLine - startLine >= 200) throw new Error('评论行范围无效');
  if (precise && (!Number.isSafeInteger(startColumn) || !Number.isSafeInteger(endColumn) || startColumn < 1 || endColumn < 1 || (startLine === endLine && endColumn <= startColumn))) throw new Error('评论字符范围无效');
  if (precise && !versions) throw new Error('字符评论需要历史文件全文');
  const file = diff.files.find(file => file.id === fileId);
  if (!file || file.binary) throw new Error('无法定位评论文件');
  if (versions) {
    if (versions.unavailable || versions.fileId !== fileId || !versions[side]?.exists) throw new Error('文件内容不可用于评论');
    const lines = precise ? versions[side].text.split(/\r\n|\r|\n/) : sourceLines(versions[side].text);
    if (endLine > lines.length) throw new Error('评论行范围超出文件');
    if (precise) {
      const validColumn = (line, column) => {
        const offset = column - 1;
        return offset <= line.length && !(offset > 0 && /[\uD800-\uDBFF]/.test(line[offset - 1]) && /[\uDC00-\uDFFF]/.test(line[offset] || ''));
      };
      if (!validColumn(lines[startLine - 1], startColumn) || !validColumn(lines[endLine - 1], endColumn)) throw new Error('评论字符范围超出文件或拆分字符');
      const selected = lines.slice(startLine - 1, endLine);
      selected[selected.length - 1] = selected.at(-1).slice(0, endColumn - 1);
      selected[0] = selected[0].slice(startColumn - 1);
      return { ...kind, fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, startColumn, endColumn, code: selected.join('\n') };
    }
    return { ...kind, fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, code: lines.slice(startLine - 1, endLine).join('\n') };
  }
  const key = side === 'old' ? 'oldLine' : 'newLine';
  for (const hunk of file.hunks) {
    const lines = hunk.lines.filter(line => line[key] !== null && line[key] >= startLine && line[key] <= endLine);
    if (lines.length === endLine - startLine + 1 && lines.every((line, index) => line[key] === startLine + index)) {
      return { ...kind, fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, code: lines.map(line => line.text).join('\n') };
    }
  }
  throw new Error('所选行必须在同一可见 diff 区块内');
}
