// Browser-only display preferences. No Git objects or comments are changed.
export const skipTestFilesKey = repository => `commit-review.skip-test-files:${JSON.stringify(repository)}`;
export function isTestFile(filePath) {
  const name = filePath.split('/').at(-1);
  const extension = name.lastIndexOf('.');
  const stem = extension > 0 ? name.slice(0, extension) : name;
  return stem.endsWith('Test') || name.endsWith('Tests.java');
}
export function visibleFiles(files, skipTests) {
  return skipTests ? files.filter(file => !isTestFile(file.path)) : files;
}
export function readSkipTestFiles(storage, repository) {
  // Only an explicit opt-out disables filtering; missing/invalid values use the default.
  return storage.getItem(skipTestFilesKey(repository)) !== 'false';
}
export function focusShortcut(event, { editing = false, composing = false } = {}) {
  if (editing || composing || event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  // 229 alone also occurs with an idle IME. Require an explicit physical F in that case.
  return event.code === 'KeyF' || (!event.code && event.keyCode !== 229 && event.key?.toLowerCase() === 'f');
}
