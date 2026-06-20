// capture.mjs — screenshot every frame of every slide with headless Chromium.
//
//   node capture.mjs [--slide 03-stat.html] [--concurrency 2]
//
// Robustness:
//   • frames within a slide are captured sequentially (seek -> paint -> shot)
//   • a small pool renders a few slides at once (low parallelism, default 2)
//   • after capture, a retry pass re-shoots any missing/empty frames
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLIDES = path.join(__dirname,'slides');
const FRAMES = path.join(__dirname,'output','frames');
const W = 1080, H = 1350;

const arg = (k,d)=>{ const i=process.argv.indexOf(k); return i>=0 ? process.argv[i+1] : d; };
const only = arg('--slide', null);
const CONC = Math.max(1, parseInt(arg('--concurrency','2'),10));
const MIN_BYTES = 1500; // anything smaller is a dropped/blank frame

async function launch(){
  const exe = await chromium.executablePath();
  return puppeteer.launch({
    executablePath: exe,
    headless: 'shell',
    args: [
      ...chromium.args,
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--disable-lcd-text',
      `--window-size=${W},${H}`,
    ],
  });
}

async function newPage(browser){
  const page = await browser.newPage();
  await page.setViewport({ width:W, height:H, deviceScaleFactor:1 });
  page.setDefaultTimeout(60000);
  return page;
}

// capture a single frame at time t (seconds) -> png at fullPath
async function shoot(page, t, fullPath){
  await page.evaluate(async (time)=>{
    window.__seek(time);
    // wait two paints so the seeked state is actually rendered
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  }, t);
  await page.screenshot({ path: fullPath, clip:{ x:0, y:0, width:W, height:H }, optimizeForSpeed:false });
}

async function frameCount(page){
  const dur = await page.evaluate(()=>window.__dur());
  const fps = await page.evaluate(()=>window.FPS || 30);
  return { fps, total: Math.max(1, Math.round(dur*fps)) };
}

async function captureSlide(browser, file){
  const base = file.replace(/\.html$/,'');
  const outDir = path.join(FRAMES, base);
  await fs.mkdir(outDir,{recursive:true});
  const page = await newPage(browser);
  const url = pathToFileURL(path.join(SLIDES,file)).href + '?render=1';
  await page.goto(url, { waitUntil:'load' });
  await page.waitForFunction('window.__ready===true', { timeout:60000 });
  const { fps, total } = await frameCount(page);

  for (let f=0; f<total; f++){
    const t = f/fps;
    await shoot(page, t, path.join(outDir, `f${String(f).padStart(5,'0')}.png`));
  }

  // ---- retry pass: re-shoot missing / suspiciously small frames ----
  let repaired = 0;
  for (let f=0; f<total; f++){
    const p = path.join(outDir, `f${String(f).padStart(5,'0')}.png`);
    let ok=false;
    try { ok = (await fs.stat(p)).size >= MIN_BYTES; } catch {}
    if (!ok){ await shoot(page, f/fps, p); repaired++; }
  }
  await page.close();
  console.log(`✓ ${file}  ${total} frames @ ${fps}fps${repaired?`  (repaired ${repaired})`:''}`);
  return { base, total, fps };
}

async function main(){
  const manifest = JSON.parse(await fs.readFile(path.join(SLIDES,'manifest.json'),'utf8'));
  let files = manifest.slides.map(s=>s.file);
  if (only) files = files.filter(f=>f===only || f.includes(only));
  if (!files.length){ console.error('no slides to capture'); process.exit(1); }

  await fs.mkdir(FRAMES,{recursive:true});
  const browser = await launch();

  const results = [];
  let idx = 0;
  async function worker(){
    while (idx < files.length){
      const my = files[idx++];
      results.push(await captureSlide(browser, my));
    }
  }
  await Promise.all(Array.from({length:Math.min(CONC,files.length)}, worker));
  await browser.close();

  // write a per-slide frame map for the encoder
  const map = {};
  for (const r of results) map[r.base] = { total:r.total, fps:r.fps };
  await fs.writeFile(path.join(FRAMES,'frames.json'), JSON.stringify(map,null,2));
  console.log(`\nCaptured ${results.length} slides → output/frames/`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
