// png-carousel.js — build a carousel spec from a folder of finished PNG slides.
//
//   node png-carousel.js [srcDir] [--motion kenburns] [--dur 4]
//   (default srcDir: assets/uploads ; images are used in sorted filename order)
//
// Writes specs/png.json, then generate + render as usual:
//   node gen.js specs/png.json && bash render.sh
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k,d)=>{ const i=process.argv.indexOf(k); return i>=0 ? process.argv[i+1] : d; };

const srcArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'assets/uploads';
const srcDir = path.resolve(__dirname, srcArg);
const dur = parseFloat(arg('--dur','4'));
const mode = arg('--motion','varied'); // 'varied' | a single preset name

// gentle, cohesive rotation so a multi-slide carousel doesn't feel uniform
const VARIED = ['kenburns-in','pan-left','kenburns-out','pan-right','pan-up'];

// read width/height from a PNG header (IHDR) without any deps
async function pngSize(file){
  const fd = await fs.open(file,'r');
  try {
    const buf = Buffer.alloc(24);
    await fd.read(buf,0,24,0);
    if (buf.toString('ascii',1,4) !== 'PNG') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } finally { await fd.close(); }
}

async function main(){
  let files;
  try { files = (await fs.readdir(srcDir)).filter(f=>/\.png$/i.test(f)).sort(); }
  catch { console.error(`No folder at ${srcDir}. Create it and drop your PNG slides in.`); process.exit(1); }
  if (!files.length){ console.error(`No .png files in ${srcDir}.`); process.exit(1); }

  const slides = [];
  for (let i=0;i<files.length;i++){
    const abs = path.join(srcDir, files[i]);
    const size = await pngSize(abs);
    if (size && (size.w!==1080 || size.h!==1350)){
      console.warn(`⚠ ${files[i]} is ${size.w}x${size.h} (not 1080x1350) — it will be cropped to fill 4:5.`);
    }
    const motion = mode==='varied' ? VARIED[i % VARIED.length] : mode;
    slides.push({
      type:'png',
      // path is relative to slides/ where the HTML lives
      image: path.relative(path.join(__dirname,'slides'), abs).split(path.sep).join('/'),
      motion, motionDur: dur, hold: 0,
    });
    console.log(`+ ${files[i]}  →  motion: ${motion}`);
  }

  const spec = { title:'PNG carousel', brand:{}, slides };
  const out = path.join(__dirname,'specs','png.json');
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out, JSON.stringify(spec,null,2));
  console.log(`\nWrote ${out} (${slides.length} slides).`);
  console.log(`Next:  node gen.js specs/png.json  &&  bash render.sh --frames-only   (QA, then drop --frames-only)`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
