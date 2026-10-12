import test from 'node:test';
import assert from 'node:assert/strict';
import { commentParts } from '../public/comment-format.js';

const plain = text => [{ text, bold: false }];
test('comment emphasis preserves ordinary text and newlines', () => {
  assert.deepEqual(commentParts('普通文本\n下一行'), plain('普通文本\n下一行'));
  assert.deepEqual(commentParts(''), []);
  assert.deepEqual(commentParts('结论：**需要修复**。\n**已验证**'), [
    {text:'结论：',bold:false}, {text:'需要修复',bold:true},
    {text:'。\n',bold:false}, {text:'已验证',bold:true},
  ]);
  assert.deepEqual(commentParts('**两行\n重点**'), [{text:'两行\n重点',bold:true}]);
});
test('ambiguous stars and unfinished emphasis remain literal', () => {
  for (const text of ['**未闭合', '** leading**', '**trailing **', '****', '***三颗星***', '*普通*', String.raw`\**转义**`]) {
    assert.deepEqual(commentParts(text), plain(text));
  }
});
test('code spans and fences preserve literal emphasis markers', () => {
  for (const text of ['`**literal**`', '```js\nconst a = "**literal**";\n```', '`unclosed **literal**', '``a ` **literal**``']) {
    assert.deepEqual(commentParts(text), plain(text));
  }
  assert.deepEqual(commentParts('`**code**` **重点**'), [{text:'`**code**` ',bold:false},{text:'重点',bold:true}]);
});
test('HTML and links are just text, including inside emphasis', () => {
  const html = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  assert.deepEqual(commentParts(html), plain(html));
  assert.deepEqual(commentParts('**'+html+'**'), [{text:html,bold:true}]);
  const link = '[link](javascript:alert(1)) ![image](https://example.invalid/x)';
  assert.deepEqual(commentParts(link), plain(link));
});
