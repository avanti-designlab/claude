// Bundle once, then render a list of frames as half-size PNG stills + a contact sheet.
// usage: node tools/qa-stills.mjs 40 120 260 ...
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const frames = process.argv.slice(2).map(Number);
const outDir = path.resolve('out/qa');
fs.mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const browserExecutable = process.env.REMOTION_BROWSER || null;
const composition = await selectComposition({ serveUrl, id: 'AmgEthosReel', browserExecutable });
const files = [];
for (const frame of frames) {
  const output = path.join(outDir, `f${String(frame).padStart(3, '0')}.png`);
  await renderStill({ composition, serveUrl, frame, output, scale: 0.4, browserExecutable });
  files.push(output);
}
const args = ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `hstack=${files.length}`, path.join(outDir, 'sheet.png')];
if (files.length > 1) execFileSync('ffmpeg', args);
console.log('done', files.length);
