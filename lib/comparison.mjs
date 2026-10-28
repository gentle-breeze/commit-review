import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const splitLines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const textOf = lines => lines.map(line => line.text).join('');
const same = (a,b) => a === b || !!a && !!b && a.mode === b.mode && a.bytes.equals(b.bytes);
const asText = entry => {
  if (!entry || !['100644','100755'].includes(entry.mode) || entry.bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(entry.bytes); } catch { return null; }
};
const version = entry => {
  if (!entry) return {text:'',lineCount:0,exists:false};
  const text = asText(entry)?.replace(/\r\n?/g,'\n');
  if (text === undefined) return null;
  return {text,lineCount:splitLines(text).length,exists:true};
};

// Hunk positions refer to the actual historical parent. Object identity tracks line
// provenance through excluded edits, so omitted adjacent insertions are not dependencies.
export function applyVisibleHunks(historical, visible, hunks, nextLines) {
  const result = [...visible];
  for (const hunk of [...hunks].reverse()) {
    const removed = historical.slice(hunk.oldStart, hunk.oldStart + hunk.oldCount);
    let start;
    if (removed.length) {
      start = result.indexOf(removed[0]);
      if (start < 0 || removed.some((line,index) => result[start + index] !== line)) {
        throw new Error('修改或删除依赖已排除的行，或被排除的删除使目标不再连续');
      }
    } else {
      const positions = new Map(result.map((line,index) => [line,index]));
      let left = -1, right = result.length;
      for (let i = hunk.oldStart - 1; i >= 0; i--) if (positions.has(historical[i])) { left = positions.get(historical[i]); break; }
      for (let i = hunk.oldStart; i < historical.length; i++) if (positions.has(historical[i])) { right = positions.get(historical[i]); break; }
      if (right !== left + 1) throw new Error('新增位置依赖已排除的删除或替换，无法唯一定位');
      start = right;
    }
    result.splice(start, removed.length, ...nextLines.slice(hunk.newStart, hunk.newStart + hunk.newCount));
  }
  return result;
}

export async function composeComparison(repo, scope, commits, included) {
  const temporary = await mkdtemp(path.join(tmpdir(),'review-compose-'));
  const oldFile = path.join(temporary,'old'), newFile = path.join(temporary,'new');
  let size = 0, changesCount = 0;
  const historical = new Map(), visiblePaths = new Map(), entities = [];
  const tokens = entry => {
    const text = asText(entry);
    if (text === null) return null;
    const lines = splitLines(text);
    if (lines.length > 20000) throw new Error('文件超过 20000 行，无法安全组合');
    return lines.map(text => ({text}));
  };
  const read = async (sha,name) => {
    const entry = await repo.comparisonEntry(sha,name);
    size += entry?.bytes.length || 0;
    if (size > 64 * 1024 * 1024) throw new Error('组合读取超过 64 MiB，请缩小范围');
    return entry;
  };
  const ensure = async name => {
    if (historical.has(name)) return historical.get(name);
    const entry = await read(scope.mergeBase,name);
    if (!entry) { historical.set(name,null); return null; }
    const lines = tokens(entry);
    const entity = {basePath:name,base:entry,visible:entry,path:name,lines};
    entities.push(entity); visiblePaths.set(name,entity);
    const record = {...entry,lines,entity}; historical.set(name,record); return record;
  };
  const hunksBetween = async (oldBytes,newBytes) => {
    if (oldBytes.equals(newBytes)) return [];
    await writeFile(oldFile,oldBytes); await writeFile(newFile,newBytes);
    let output;
    try {
      ({stdout:output} = await execute('git',['-c','core.quotePath=false','diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--diff-algorithm=myers','--unified=0','--',oldFile,newFile],
        {encoding:'utf8',timeout:20000,maxBuffer:12*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}));
    } catch (error) {
      if (error.code !== 1) throw new Error('无法读取用于组合的文件差异');
      output = error.stdout;
    }
    return [...output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => {
      const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1);
      return {oldStart:Number(match[1]) - (oldCount ? 1 : 0),oldCount,newStart:Number(match[3]) - (newCount ? 1 : 0),newCount};
    });
  };
  try {
    let parent = scope.mergeBase;
    for (const commit of commits) {
      if (commit.parents[0] !== parent) throw new Error('共同祖先到待审分支不是连续的第一父提交链，无法安全组合；请调整比较基准');
      parent = commit.sha;
      for (const file of await repo.fileChanges(commit)) {
        if (++changesCount > 100000) throw new Error('组合超过 100000 条文件改动，请缩小范围');
        try {
          const prior = await ensure(file.oldPath);
          const next = file.status.startsWith('D') ? null : await read(commit.sha,file.path);
          const selected = included.has(commit.sha);
          let entity = prior?.entity;
          if (!entity) { entity = {basePath:null,base:null,visible:null,path:file.path,lines:[]}; entities.push(entity); }
          if (file.path !== file.oldPath) await ensure(file.path);
          const previousLines = prior?.lines ?? (prior ? null : []);
          let nextLines = next ? tokens(next) : [];
          let hunks = null;
          if (previousLines !== null && nextLines !== null) {
            hunks = await hunksBetween(prior?.bytes || Buffer.alloc(0),next?.bytes || Buffer.alloc(0));
            const reconstructed = [...previousLines];
            for (const hunk of [...hunks].reverse()) reconstructed.splice(hunk.oldStart,hunk.oldCount,...nextLines.slice(hunk.newStart,hunk.newStart+hunk.newCount));
            if (textOf(reconstructed) !== (asText(next) ?? '')) throw new Error('差异行号无法完整还原历史版本');
            nextLines = reconstructed;
          }
          if (selected) {
            if (!prior && entity.visible) throw new Error('新增文件与保留的文件冲突');
            if (file.status.startsWith('D')) {
              if (!same(entity.visible,prior)) throw new Error('删除整个文件依赖已排除的文件改动');
              visiblePaths.delete(entity.path); entity.visible = null; entity.lines = [];
            } else {
              const target = file.status.startsWith('R') || !entity.visible ? file.path : entity.path;
              const occupied = visiblePaths.get(target);
              if (occupied && occupied !== entity) throw new Error('目标路径与保留的文件冲突');
              let bytes, lines;
              if (hunks && entity.lines !== null) {
                lines = applyVisibleHunks(previousLines,entity.lines,hunks,nextLines);
                bytes = Buffer.from(textOf(lines));
              } else {
                if (!same(entity.visible,prior)) throw new Error('二进制、文件类型或编码改动依赖已排除的版本');
                bytes = next.bytes; lines = nextLines;
              }
              if (bytes.length > 2 * 1024 * 1024 || lines && lines.length > 20000) throw new Error('组合文件超过 2 MiB 或 20000 行');
              let mode = entity.visible?.mode || '100644';
              if (!prior || prior.mode !== next.mode) {
                if (prior && mode !== prior.mode) throw new Error('文件权限改动依赖已排除的版本');
                mode = next.mode;
              }
              if (!entity.visible && prior && !['100644','100755'].includes(next.mode)) throw new Error('文件类型依赖已排除的创建');
              visiblePaths.delete(entity.path); entity.path = target;
              entity.visible = {mode,bytes}; entity.lines = lines; visiblePaths.set(target,entity);
            }
          }
          historical.set(file.oldPath,null);
          if (next) historical.set(file.path,{...next,lines:nextLines,entity});
        } catch (error) { throw new Error(`无法组合 ${commit.sha.slice(0,8)} · ${file.path}：${error.message}。请恢复依赖提交或改用按 commit 查看。`); }
      }
    }
    // Compare the resulting trees by path, not per historical file lifetime:
    // a selected delete/recreate must yield one net file, possibly no change.
    const originals = new Map(entities.filter(entity => entity.base).map(entity => [entity.basePath,entity.base]));
    const remaining = new Map(visiblePaths);
    const pairs = [];
    for (const entity of remaining.values()) {
      if (entity.basePath && entity.basePath !== entity.path && !remaining.has(entity.basePath) && !originals.has(entity.path)) {
        pairs.push({base:entity.base,next:entity.visible,oldPath:entity.basePath,path:entity.path});
        originals.delete(entity.basePath); remaining.delete(entity.path);
      }
    }
    for (const name of new Set([...originals.keys(),...remaining.keys()])) {
      pairs.push({base:originals.get(name),next:remaining.get(name)?.visible,oldPath:name,path:name});
    }
    const files = [], versions = new Map();
    for (const pair of pairs) {
      const {base,next,oldPath,path:name} = pair;
      if (!base && !next || same(base,next) && oldPath === name) continue;
      const oldVersion = version(base), newVersion = version(next);
      const binary = !oldVersion || !newVersion;
      const hunks = binary ? [] : await hunksBetween(base?.bytes || Buffer.alloc(0),next?.bytes || Buffer.alloc(0));
      const id = String(files.length), status = !base ? 'A' : !next ? 'D' : oldPath !== name ? 'R' : 'M';
      files.push({id,path:name,oldPath,status,binary,
        additions:binary?null:hunks.reduce((sum,hunk)=>sum+hunk.newCount,0),deletions:binary?null:hunks.reduce((sum,hunk)=>sum+hunk.oldCount,0)});
      versions.set(id,binary ? {fileId:id,unavailable:'二进制、非 UTF-8 或非普通文件不支持文本比较'} : {fileId:id,old:oldVersion,new:newVersion});
    }
    if (files.length > 10000) throw new Error('组合结果超过 10000 个文件，请缩小范围');
    return {files,versions};
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
