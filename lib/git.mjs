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

  async branches() {
    const output = await git(this.path, ['for-each-ref', '--format=%(refname)%00%(HEAD)', 'refs/heads']);
    return output.trimEnd().split('\n').filter(Boolean).map(line => {
      const [name, marker] = line.split('\0');
      return { name, current: marker === '*' };
    });
  }

  async resolve(ref) {
    if (typeof ref !== 'string' || !ref || ref.length > 1024 || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) throw new Error('Git 引用无效');
    try { return (await git(this.path, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
    catch { throw new Error('找不到指定的 commit 或分支'); }
  }

  async commits(ref = 'HEAD', offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页参数无效');
    const empty = (status, message, upstream = null) => ({ commits: [], hasMore: false, status, message, upstream });
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
    const output = await git(this.path, ['log', '--first-parent', '-z', '--no-show-signature', '--no-decorate',
      '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%b', `--skip=${offset}`, `--max-count=${limit + 1}`, `${base}..${sha}`, '--']);
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const [id, parents, subject, author, date, body] = fields.slice(i, i + 6);
      commits.push({ sha: id, parents: parents ? parents.split(' ') : [], subject, author, date, body });
    }
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit, status: 'ready', upstream: upstream || null, comparisonRef, comparisonMode,
      message: comparisonMode === 'upstream' ? '此分支没有未 push 的主线提交。' : `此分支没有相对 ${comparisonRef.replace('refs/heads/', '')} 独有的主线提交。` };
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

  async diff(sha) {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('请提供完整 commit SHA');
    const resolved = await this.resolve(sha);
    if (resolved !== sha) throw new Error('对象不是 commit');
    const info = await git(this.path, ['show', '-s', '--no-show-signature', '--format=%P%x00%s', sha, '--']);
    const [parentString, subject] = info.replace(/\n$/, '').split('\0');
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
    const result = { sha, parent, parents, subject, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
    if (!files.length) return result;
    let patch;
    try {
      patch = await git(this.path, [...base, ...options, '--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', '--']);
    } catch (error) {
      if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('读取 diff 失败或超时');
      result.truncated = true;
      result.files.forEach(file => { file.truncated = true; });
      return result;
    }
    const blocks = patch.split(/^diff --git /m).slice(1);
    if (blocks.length !== files.length) throw new Error('Git diff 与文件列表不匹配，无法安全定位评论');
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
      return { fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, startColumn, endColumn, code: selected.join('\n') };
    }
    return { fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, code: lines.slice(startLine - 1, endLine).join('\n') };
  }
  const key = side === 'old' ? 'oldLine' : 'newLine';
  for (const hunk of file.hunks) {
    const lines = hunk.lines.filter(line => line[key] !== null && line[key] >= startLine && line[key] <= endLine);
    if (lines.length === endLine - startLine + 1 && lines.every((line, index) => line[key] === startLine + index)) {
      return { fileId, path: file.path, oldPath: file.oldPath, side, startLine, endLine, code: lines.map(line => line.text).join('\n') };
    }
  }
  throw new Error('所选行必须在同一可见 diff 区块内');
}
