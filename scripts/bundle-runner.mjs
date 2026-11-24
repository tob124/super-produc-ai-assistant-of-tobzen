import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// SP loads the iframe from srcdoc and only serves its inline scripts.
const { outputFiles } = await build({
  stdin: { contents: 'export { ChatCompletionRunner } from "openai/lib/ChatCompletionRunner";', resolveDir: process.cwd() },
  globalName: 'OpenAIToolRunner', platform: 'browser', format: 'iife',
  target: 'es2022', bundle: true, minify: true, write: false
});
const html = await readFile('index.html', 'utf8');
const license = await readFile('node_modules/openai/LICENSE', 'utf8');
const start = '/* BEGIN bundled OpenAI tool runner */';
const end = '/* END bundled OpenAI tool runner */';
const before = html.indexOf(start), after = html.indexOf(end, before);
if (before < 0 || after < 0) throw Error('Missing SDK bundle markers');
const bundle = [start, '/* openai-node · https://github.com/openai/openai-node\n'+license+'*/', outputFiles[0].text, end].join('\n');
await writeFile('index.html', html.slice(0,before)+bundle+html.slice(after+end.length));
