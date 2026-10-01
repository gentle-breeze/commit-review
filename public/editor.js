import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/features/find/register.js';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/csharp/register.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/swift/register.js';
import 'monaco-editor/languages/definitions/kotlin/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/scss/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/powershell/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';

monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'] });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
  [/"(?:[^"\\]|\\.)*"/, 'string'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
  [/\b(?:true|false|null)\b/, 'keyword'],
] } });

self.MonacoEnvironment = {
  getWorker() { return new Worker('/assets/editor.worker.js', { type: 'module' }); },
};
const theme = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => monaco.editor.setTheme(theme.matches ? 'vs-dark' : 'vs');
applyTheme();
theme.addEventListener('change', applyTheme);

function language(path) {
  const filename = path.split('/').at(-1).toLowerCase();
  const extension = filename.includes('.') ? `.${filename.split('.').at(-1)}` : '';
  return monaco.languages.getLanguages().find(item => item.filenames?.some(name => name.toLowerCase() === filename) || (extension && item.extensions?.includes(extension)))?.id || 'plaintext';
}

export function createComparison(container, { file, versions, onSelect, onChanges, onCurrentChange, wrap, collapse }) {
  const editor = monaco.editor.createDiffEditor(container, {
    readOnly: true, originalEditable: false, domReadOnly: true,
    renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
    automaticLayout: true, fontSize: 13, lineHeight: 21,
    minimap: { enabled: false }, glyphMargin: true, lineNumbersMinChars: 3,
    scrollBeyondLastLine: false, renderOverviewRuler: true,
    renderIndicators: true, renderMarginRevertIcon: false, renderGutterMenu: false,
    diffAlgorithm: 'advanced', ignoreTrimWhitespace: false,
    wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off',
    hideUnchangedRegions: { enabled: collapse, contextLineCount: 4, minimumLineCount: 10, revealLineCount: 20 },
    stickyScroll: { enabled: false }, folding: false,
    padding: { top: 10, bottom: 10 },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    accessibilityVerbose: true,
  });
  const models = {
    old: monaco.editor.createModel(versions.old.text, language(file.oldPath)),
    new: monaco.editor.createModel(versions.new.text, language(file.path)),
  };
  const panes = { old: editor.getOriginalEditor(), new: editor.getModifiedEditor() };
  const decorations = { old: panes.old.createDecorationsCollection(), new: panes.new.createDecorationsCollection() };
  const currentDecorations = { old: panes.old.createDecorationsCollection(), new: panes.new.createDecorationsCollection() };
  editor.setModel({ original: models.old, modified: models.new });
  let silent = false;
  let changes = [], current = -1;
  const changeRange = (change, side) => {
    const prefix = side === 'old' ? 'original' : 'modified';
    const start = change[`${prefix}StartLineNumber`], end = change[`${prefix}EndLineNumber`];
    // A zero end denotes an insertion/deletion gap; mark the nearest boundary line.
    const from = Math.max(1, Math.min(end === 0 ? start + 1 : start, models[side].getLineCount()));
    return { start: from, end: end === 0 ? from : end, gap: end === 0 };
  };
  const activate = (index, reveal = false) => {
    current = index;
    for (const side of ['old', 'new']) {
      const range = changes[current] && changeRange(changes[current], side);
      currentDecorations[side].set(range ? [{
        range: new monaco.Range(range.start, 1, range.end, 1),
        options: { isWholeLine: true, className: range.gap ? 'review-current-gap' : 'review-current-diff', linesDecorationsClassName: 'review-current-diff-margin' },
      }] : []);
      if (reveal && range) panes[side].revealLineInCenter(range.start);
    }
    onCurrentChange(current + 1, changes.length);
  };
  const navigate = direction => {
    if (!changes.length) return;
    activate((current + (direction === 'previous' ? -1 : 1) + changes.length) % changes.length, true);
  };
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['[', ']'].includes(event.key)) return;
    const target = event.target;
    if (document.querySelector('dialog[open]') || target.isContentEditable || target.closest('input, select, textarea') && !target.matches('.monaco-editor textarea.inputarea')) return;
    if (!changes.length) return;
    event.preventDefault(); event.stopPropagation();
    navigate(event.key === '[' ? 'previous' : 'next');
  };
  document.addEventListener('keydown', keydown, true);
  const listeners = [{ dispose: () => document.removeEventListener('keydown', keydown, true) }];
  for (const side of ['old', 'new']) {
    panes[side].updateOptions({ ariaLabel: side === 'old' ? '修改前代码' : '修改后代码' });
    listeners.push(panes[side].onDidChangeCursorPosition(event => {
      const index = changes.findIndex(change => {
        const range = changeRange(change, side);
        return event.position.lineNumber >= range.start && event.position.lineNumber <= range.end;
      });
      if (index >= 0 && index !== current) activate(index);
    }));
    listeners.push(panes[side].onMouseDown(event => {
      if (![monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS, monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN].includes(event.target.type)) return;
      event.event.preventDefault();
      const line = event.target.position?.lineNumber;
      if (line && line <= versions[side].lineCount) onSelect(side, line, line, event.event.shiftKey);
    }));
    const selectedText = () => {
      const selection = panes[side].getSelection();
      if (silent || !selection || selection.isEmpty()) return;
      const end = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
      if (end <= versions[side].lineCount) onSelect(side, selection.startLineNumber, end, false);
    };
    listeners.push(panes[side].onMouseUp(event => {
      if (event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT || event.target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY) selectedText();
    }));
    listeners.push(panes[side].onKeyUp(event => { if (event.shiftKey) selectedText(); }));
  }
  listeners.push(editor.onDidUpdateDiff(() => {
    changes = editor.getLineChanges() || [];
    onChanges(changes.length);
    activate(changes.length ? Math.max(0, Math.min(current, changes.length - 1)) : -1);
  }));
  return {
    paint(selection, comments) {
      for (const side of ['old', 'new']) {
        const items = comments.filter(comment => comment.side === side).map(comment => ({
          range: new monaco.Range(comment.startLine, 1, comment.endLine, 1),
          options: { isWholeLine: true, glyphMarginClassName: 'review-comment-marker', linesDecorationsClassName: 'review-comment-line' },
        }));
        if (selection?.side === side) items.push({
          range: new monaco.Range(selection.startLine, 1, selection.endLine, 1),
          options: { isWholeLine: true, className: 'review-selected-line' },
        });
        decorations[side].set(items);
      }
    },
    reveal(selection) {
      silent = true;
      try {
        editor.updateOptions({ hideUnchangedRegions: { enabled: false } });
        const pane = panes[selection.side];
        pane.setSelection(new monaco.Range(selection.startLine, 1, selection.endLine, models[selection.side].getLineMaxColumn(selection.endLine)));
        pane.revealLineInCenter(selection.startLine);
        pane.focus();
      } finally { silent = false; }
    },
    navigate,
    options({ wrap, collapse }) {
      editor.updateOptions({ wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off', hideUnchangedRegions: { enabled: collapse } });
    },
    dispose() {
      listeners.forEach(listener => listener.dispose());
      editor.dispose();
      models.old.dispose(); models.new.dispose();
    },
  };
}
