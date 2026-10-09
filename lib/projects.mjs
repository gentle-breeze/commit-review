import { readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GitRepo } from './git.mjs';

export async function discoverProjects(input) {
  let directory, entries;
  try {
    directory = await realpath(input);
    entries = await readdir(directory, { withFileTypes: true });
  } catch { throw new Error('无法读取项目目录，请检查 --projects-dir 路径和访问权限'); }
  const candidates = [directory, ...entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => path.join(directory, entry.name))];
  const projects = new Map();
  for (const candidate of candidates) {
    try {
      const marker = await lstat(path.join(candidate, '.git'));
      if (!marker.isDirectory() && !marker.isFile()) continue;
      const repo = await GitRepo.open(candidate);
      projects.set(repo.path, { name: path.basename(repo.path), path: repo.path });
    } catch { /* Ignore inaccessible directories and invalid Git workspaces. */ }
  }
  return { directory, projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)) };
}
