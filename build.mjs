import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: {
    app: 'public/app.js',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'public/assets',
  bundle: true,
  format: 'esm',
  splitting: true,
  loader: { '.ttf': 'file' },
  assetNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  minify: true,
  target: ['chrome120', 'safari17'],
});
