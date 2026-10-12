// Display preferences only; never writes Git or review data.
export const hiddenCommitsKey = repository => `commit-review.hidden-commits:${JSON.stringify(repository)}`;
export function readHiddenCommits(storage, repository) {
  const values = JSON.parse(storage.getItem(hiddenCommitsKey(repository)) || '[]');
  return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)) : []);
}
export function writeHiddenCommits(storage, repository, hidden) {
  storage.setItem(hiddenCommitsKey(repository), JSON.stringify([...hidden]));
}
export function visibleCommits(commits, hidden, showHidden = false, query = '') {
  const needle = query.trim().toLowerCase();
  return commits.filter(commit => hidden.has(commit.sha) === showHidden &&
    (!needle || `${commit.sha} ${commit.subject} ${commit.author}`.toLowerCase().includes(needle)));
}
