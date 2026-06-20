// gen.js — turn a carousel spec (JSON) into self-contained, deterministically
// renderable slide HTML files in slides/.
//
//   node gen.js [path/to/spec.json]     (default: specs/sample.json)
//
// Each slide HTML:
//   • links ../styles/base.css and ../assets/gsap.min.js (local, file://-safe)
//   • builds an inline GSAP timeline (paused)
//   • exposes a render API so the renderer can seek to any frame:
//        window.__ready  — true once fonts are loaded & first frame is set
//        window.__dur()  — timeline duration in seconds
//        window.__seek(t)— pause & jump to time t (seconds)
//   • ?render=1 holds at frame 0; otherwise it plays (handy for live preview)
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEMPLATES } from './lib/templates.js';
import { resolveIcon, normalizeSvg } from './lib/icons.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const gi = name => normalizeSvg(resolveIcon(name).svg); // inline glyph

// AMG-style dotted brand mark (approximate; replace with real logo file when supplied)
const DOTMARK = `<svg class="dotmark" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="6" r="2.4"/><circle cx="5" cy="13" r="2.4"/><circle cx="11" cy="9.5" r="2.4"/><circle cx="11" cy="16.5" r="2.4"/><circle cx="17" cy="6" r="2.4"/><circle cx="17" cy="13" r="2.4"/></svg>`;

function footerHTML(footer){
  if (!footer) return '';
  const items = [];
  if (footer.phone)   items.push(`<span class="fitem">${gi('phone')}${esc(footer.phone)}</span>`);
  if (footer.address) items.push(`<span class="fitem">${gi('pin')}${esc(footer.address)}</span>`);
  if (footer.web)     items.push(`<span class="fitem">${gi('globe')}${esc(footer.web)}</span>`);
  if (footer.email)   items.push(`<span class="fitem">${gi('mail')}${esc(footer.email)}</span>`);
  const mark = footer.brand ? `<span class="brandmark">${DOTMARK}${esc(footer.brand)}</span>` : '';
  return `<div class="footerbar">${mark}<span class="finfo">${items.join('')}</span></div>`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;

function brandCSS(brand = {}){
  const keys = ['accent','accent-2','bg-core','bg-edge','plate','tile','ink','font'];
  const decl = keys.filter(k => brand[k]).map(k => `  --${k}: ${brand[k]};`).join('\n');
  return decl ? `:root{\n${decl}\n}` : '';
}

function pageHTML(slide, anim, body, brand, hold, ctx){
  const footer = brand.footer;
  const pagecount = brand.pageCounter !== false && ctx
    ? `<div class="pagecount"><b>${ctx.index+1}</b> | ${ctx.total}</div>` : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, initial-scale=1">
<link rel="stylesheet" href="../styles/base.css">
<style>${brandCSS(brand)}</style>
</head>
<body class="${footer?'has-footer':''}">
${body}
${pagecount}
${footerHTML(footer)}
<script src="../assets/gsap.min.js"></script>
<script>
(function(){
  var FPS = ${FPS};
  gsap.config({force3D:true});
  gsap.ticker.lagSmoothing(0);
  var tl = gsap.timeline({paused:true, defaults:{ease:"power3.out", duration:.8}});
  // ---- slide animation ----
${anim}
  // ---- rest/hold so the slide settles before the loop/encode ----
  tl.to({}, {duration:${hold}});

  // ---- deterministic render runtime ----
  window.__tl  = tl;
  window.__dur = function(){ return tl.duration(); };
  window.__seek= function(t){ tl.pause(); tl.time(Math.max(0, Math.min(t, tl.duration())), false); };
  window.FPS   = FPS;

  var params = new URLSearchParams(location.search);
  function start(){
    document.documentElement.setAttribute('data-ready','1');
    window.__ready = true;
    if (params.get('render') === '1'){ tl.pause(); tl.time(0, false); }
    else { tl.play(0); }            // live preview just plays through
  }
  if (document.fonts && document.fonts.ready){
    document.fonts.ready.then(function(){ requestAnimationFrame(start); });
  } else { requestAnimationFrame(start); }
})();
</script>
</body></html>`;
}

async function main(){
  const specPath = path.resolve(process.argv[2] || path.join(__dirname,'specs','sample.json'));
  const spec = JSON.parse(await fs.readFile(specPath,'utf8'));
  const slides = spec.slides || [];
  const brand = spec.brand || {};
  const slidesDir = path.join(__dirname,'slides');

  // clean previous slides
  await fs.rm(slidesDir,{recursive:true,force:true});
  await fs.mkdir(slidesDir,{recursive:true});

  const manifest = [];
  for (let i=0;i<slides.length;i++){
    const s = slides[i];
    const tpl = TEMPLATES[s.type];
    if (!tpl){ console.error(`! unknown slide type "${s.type}" (#${i+1}) — skipped`); continue; }
    const ctx = { index:i, total:slides.length };
    const { body, anim } = tpl(s, ctx);
    const hold = typeof s.hold === 'number' ? s.hold : 1.4;
    const html = pageHTML(s, anim, body, brand, hold, ctx);
    const name = String(i+1).padStart(2,'0') + '-' + s.type + '.html';
    await fs.writeFile(path.join(slidesDir,name), html, 'utf8');
    manifest.push({ file:name, type:s.type });
    console.log(`✓ slide ${i+1}/${slides.length}  ${name}`);
  }
  await fs.writeFile(path.join(slidesDir,'manifest.json'), JSON.stringify({ fps:FPS, title:spec.title||'', slides:manifest }, null, 2));
  console.log(`\nGenerated ${manifest.length} slides → slides/  (fps ${FPS})`);
  console.log(`Preview any slide in a browser, or QA all frames with: bash render.sh --frames-only`);
}

main().catch(e => { console.error(e); process.exit(1); });
