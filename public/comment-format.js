// Deliberately limited to **strong**. Code spans/fences and all other syntax stay literal.
export function commentParts(text) {
  const markers = [...text.matchAll(/`+|\*{2,}/g)];
  const parts = [];
  let cursor = 0;
  const escaped = index => {
    let count = 0;
    while (index > 0 && text[--index] === '\\') count++;
    return count % 2 === 1;
  };
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i], start = marker.index;
    if (escaped(start)) continue;
    if (marker[0][0] === '`') {
      let end = i + 1;
      while (end < markers.length && (markers[end][0] !== marker[0] || escaped(markers[end].index))) end++;
      if (end === markers.length) break;
      i = end;
      continue;
    }
    if (marker[0] !== '**' || !text[start + 2] || /\s/.test(text[start + 2])) continue;
    // Do not cross code markers, nested star runs, or escaped delimiters.
    const close = markers[i + 1];
    if (!close || close[0] !== '**' || escaped(close.index) || close.index <= start + 2 || /\s/.test(text[close.index - 1])) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), bold: false });
    parts.push({ text: text.slice(start + 2, close.index), bold: true });
    cursor = close.index + 2;
    i++;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), bold: false });
  return parts;
}

export function renderCommentText(node, text) {
  const document = node.ownerDocument;
  node.replaceChildren(...commentParts(text).map(part => {
    if (!part.bold) return document.createTextNode(part.text);
    const strong = document.createElement('strong');
    strong.textContent = part.text;
    return strong;
  }));
  return node;
}
