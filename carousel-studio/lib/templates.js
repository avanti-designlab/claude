// templates.js — slide templates. Each returns { body, anim, css? }.
// body : HTML that lives inside <body>
// anim : GSAP code that pushes tweens onto an existing timeline `tl`
// All motion is GSAP-driven so frames are deterministic when seeked.
import { resolveIcon, normalizeSvg } from './icons.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// build an icon chip; `accent` makes a line glyph render in the accent color
function chip(name, { dark=false } = {}){
  const { svg, hex, brand } = resolveIcon(name);
  if (brand){
    return `<div class="chip"><div style="width:64px;height:64px;color:${hex}">${normalizeSvg(svg,{fill:hex})}</div></div>`;
  }
  // UI glyph -> accent colored, on a chip (dark plate chip if requested)
  const cls = dark ? 'chip dark' : 'chip';
  const color = dark ? 'var(--accent)' : 'var(--accent)';
  return `<div class="${cls}"><div style="width:64px;height:64px;color:${color}">${normalizeSvg(svg)}</div></div>`;
}

function dotsHTML(index, total){
  let s = '<div class="dots">';
  for (let i=0;i<total;i++) s += `<i class="${i===index?'on':''}"></i>`;
  return s + '</div>';
}
const swipeHTML = `<div class="swipe">Swipe ${normalizeSvg(resolveIcon('arrow').svg)}</div>`;

/* ============================== COVER ============================== */
// centered dark headline plate, icons/elements ringed around it, fills frame.
function cover(s, ctx){
  const icons = (s.icons||[]).slice(0,6);
  const RX = 496, RY = 520;            // orbit ellipse — wider than the plate so nothing collides
  const start = -Math.PI/2;            // first orb at top (eyebrow lives INSIDE the plate, so top is clear)
  const orbs = icons.map((name,i)=>{
    const a = start + (i/Math.max(icons.length,1))*Math.PI*2;
    const x = Math.cos(a)*RX, y = Math.sin(a)*RY;
    return `<div class="orb" style="transform:translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)">${chip(name)}</div>`;
  }).join('');

  const body = `
  <div class="stage center">
    <div class="bloom a"></div><div class="bloom b"></div>
    <div class="ring" id="ring">${orbs}</div>
    <div class="col center" style="z-index:2">
      <div class="plate" id="plate" style="padding:64px 60px;max-width:604px;text-align:center">
        ${s.eyebrow?`<div class="eyebrow" id="eb" style="color:var(--accent);justify-content:center;margin-bottom:26px">${esc(s.eyebrow)}</div>`:''}
        <div class="h-1" id="head" style="font-size:74px;line-height:.98">${esc(s.title)}</div>
        ${s.subtitle?`<div class="lead" id="sub" style="color:var(--on-plate-soft);margin-top:26px;font-size:32px">${esc(s.subtitle)}</div>`:''}
      </div>
    </div>
    ${dotsHTML(ctx.index, ctx.total)}
    ${swipeHTML}
  </div>`;

  const anim = `
    gsap.set("#ring .orb", {scale:0, opacity:0});
    gsap.set("#plate", {scale:.9, opacity:0, y:24});
    gsap.set(".bloom", {scale:.7, opacity:0});
    tl.to(".bloom",{scale:1,opacity:.55,duration:1.2,stagger:.12},0)
      .to("#plate",{scale:1,opacity:1,y:0,duration:.9,ease:"power4.out"},.15)
      .from("#head",{yPercent:16,opacity:0,duration:.7,ease:"power3.out"},.3)
      .to("#ring .orb",{scale:1,opacity:1,duration:.7,ease:"back.out(1.7)",stagger:.09},.5);
    // gentle continuous orbit drift (held frames keep a subtle life to them)
    tl.to("#ring",{rotation:5,duration:2.6,ease:"sine.inOut",transformOrigin:"50% 50%"},.7)
      .to("#ring .orb > .chip",{rotation:-5,duration:2.6,ease:"sine.inOut"},.7);
  `;
  return { body, anim };
}

/* ============================= STEP (hero) ========================= */
// one big idea: number badge + icon chip + heading + one supporting line.
function step(s, ctx){
  const body = `
  <div class="stage">
    <div class="bloom a"></div>
    <div class="row" id="top" style="gap:28px">
      ${s.step?`<div class="badge" id="badge">${esc(s.step)}</div>`:''}
      ${s.eyebrow?`<div class="eyebrow" id="eb">${esc(s.eyebrow)}</div>`:''}
    </div>
    <div class="spacer"></div>
    <div class="tile" id="tile" style="padding:70px;display:flex;flex-direction:column;gap:42px">
      <div class="row" style="gap:36px">
        ${s.icon?`<div id="chip">${chip(s.icon)}</div>`:''}
        <div class="h-1" id="head" style="flex:1">${esc(s.title)}</div>
      </div>
      ${s.line?`<div class="lead" id="line">${esc(s.line)}</div>`:''}
    </div>
    <div class="spacer"></div>
    ${dotsHTML(ctx.index, ctx.total)}
    ${swipeHTML}
  </div>`;

  const anim = `
    gsap.set("#tile",{y:60,opacity:0});
    ${s.step?'gsap.set("#badge",{scale:0,opacity:0});':''}
    ${s.eyebrow?'gsap.set("#eb",{x:-24,opacity:0});':''}
    ${s.icon?'gsap.set("#chip",{scale:.6,opacity:0});':''}
    gsap.set("#head",{y:24,opacity:0});
    ${s.line?'gsap.set("#line",{y:20,opacity:0});':''}
    gsap.set(".bloom",{opacity:0});
    tl.to(".bloom",{opacity:.5,duration:1.0},0)
      ${s.step?'.to("#badge",{scale:1,opacity:1,duration:.6,ease:"back.out(1.8)"},.1)':''}
      ${s.eyebrow?'.to("#eb",{x:0,opacity:1,duration:.5},.2)':''}
      .to("#tile",{y:0,opacity:1,duration:.8,ease:"power4.out"},.25)
      ${s.icon?'.to("#chip",{scale:1,opacity:1,duration:.6,ease:"back.out(1.7)"},.45)':''}
      .to("#head",{y:0,opacity:1,duration:.7},.5)
      ${s.line?'.to("#line",{y:0,opacity:1,duration:.6},.66)':''};
  `;
  return { body, anim };
}

/* ============================== LIST =============================== */
// compact multi-row list: each row = small chip + bold label + thin line.
function list(s, ctx){
  const items = (s.items||[]).slice(0,4);
  const rows = items.map((it,i)=>`
    <div class="tile row" id="r${i}" style="padding:34px 38px;gap:30px;align-items:center">
      <div style="flex:0 0 auto">${chip(it.icon||'check')}</div>
      <div class="col" style="gap:8px;flex:1">
        <div class="h-2" style="font-size:46px">${esc(it.title)}</div>
        ${it.line?`<div class="kicker">${esc(it.line)}</div>`:''}
      </div>
    </div>`).join('');

  const body = `
  <div class="stage">
    <div class="bloom a"></div>
    ${s.eyebrow?`<div class="eyebrow" id="eb">${esc(s.eyebrow)}</div>`:''}
    <div class="h-1" id="head" style="font-size:72px;margin-top:22px;max-width:880px">${esc(s.title)}</div>
    <div class="spacer"></div>
    <div class="col" id="rows" style="gap:24px">${rows}</div>
    <div class="spacer"></div>
    ${dotsHTML(ctx.index, ctx.total)}
    ${swipeHTML}
  </div>`;

  const anim = `
    ${s.eyebrow?'gsap.set("#eb",{x:-24,opacity:0});':''}
    gsap.set("#head",{y:28,opacity:0});
    gsap.set(${JSON.stringify(items.map((_,i)=>`#r${i}`))},{x:40,opacity:0});
    gsap.set(".bloom",{opacity:0});
    tl.to(".bloom",{opacity:.5,duration:1.0},0)
      ${s.eyebrow?'.to("#eb",{x:0,opacity:1,duration:.5},.05)':''}
      .to("#head",{y:0,opacity:1,duration:.7},.15)
      .to(${JSON.stringify(items.map((_,i)=>`#r${i}`))},{x:0,opacity:1,duration:.6,ease:"power3.out",stagger:.12},.35);
  `;
  return { body, anim };
}

/* ============================= BIG-STAT ============================ */
// giant counter numeral + unit + label + supporting line.
function stat(s, ctx){
  const value = String(s.value ?? '0');
  const num = parseFloat(value.replace(/[^0-9.]/g,'')) || 0;
  const prefix = (value.match(/^[^0-9.]+/)||[''])[0];
  const suffix = (value.match(/[^0-9.]+$/)||[''])[0];

  const body = `
  <div class="stage">
    <div class="bloom a"></div><div class="bloom b"></div>
    ${s.eyebrow?`<div class="eyebrow" id="eb">${esc(s.eyebrow)}</div>`:''}
    <div class="spacer" style="flex:0.6"></div>
    <div class="col" style="gap:18px">
      <div class="stat" id="stat"><span id="num">${prefix}0${suffix}</span>${s.unit?`<span class="unit">${esc(s.unit)}</span>`:''}</div>
      ${s.label?`<div class="h-2" id="label" style="font-size:60px;max-width:880px">${esc(s.label)}</div>`:''}
      ${s.line?`<div class="lead" id="line" style="max-width:840px">${esc(s.line)}</div>`:''}
    </div>
    <div class="spacer"></div>
    ${dotsHTML(ctx.index, ctx.total)}
    ${swipeHTML}
  </div>`;

  const decimals = (value.split('.')[1]||'').length;
  const anim = `
    ${s.eyebrow?'gsap.set("#eb",{x:-24,opacity:0});':''}
    gsap.set("#stat",{y:40,opacity:0,scale:.94});
    ${s.label?'gsap.set("#label",{y:24,opacity:0});':''}
    ${s.line?'gsap.set("#line",{y:20,opacity:0});':''}
    gsap.set(".bloom",{opacity:0});
    var counter={v:0};
    tl.to(".bloom",{opacity:.55,duration:1.1},0)
      ${s.eyebrow?'.to("#eb",{x:0,opacity:1,duration:.5},.05)':''}
      .to("#stat",{y:0,opacity:1,scale:1,duration:.8,ease:"power4.out"},.2)
      .to(counter,{v:${num},duration:1.4,ease:"power2.out",onUpdate:function(){
        var n=counter.v.toFixed(${decimals});
        document.getElementById("num").textContent=${JSON.stringify(prefix)}+Number(n).toLocaleString()+${JSON.stringify(suffix)};
      }},.3)
      ${s.label?'.to("#label",{y:0,opacity:1,duration:.6},.7)':''}
      ${s.line?'.to("#line",{y:0,opacity:1,duration:.6},.85)':''};
  `;
  return { body, anim };
}

/* =============================== CTA =============================== */
// comment-keyword call to action — the closer.
function cta(s, ctx){
  const kw = s.keyword || 'GO';
  const body = `
  <div class="stage center">
    <div class="bloom a"></div><div class="bloom b"></div>
    <div class="col center" style="gap:46px;z-index:2">
      ${s.eyebrow?`<div class="eyebrow" id="eb">${esc(s.eyebrow)}</div>`:''}
      <div class="plate" id="plate" style="padding:80px 72px;max-width:900px">
        <div class="h-1" id="head" style="font-size:78px">${esc(s.title||'Want the full playbook?')}</div>
        ${s.line?`<div class="lead" id="line" style="color:var(--on-plate-soft);margin-top:28px">${esc(s.line)}</div>`:''}
        <div class="row center" id="kwrap" style="margin-top:46px;justify-content:center">
          <div class="pill" style="font-size:40px;padding:26px 46px">
            <span style="width:34px;height:34px;display:inline-flex;color:#fff">${normalizeSvg(resolveIcon('message').svg)}</span>
            Comment &ldquo;<span id="kw">${esc(kw)}</span>&rdquo;
          </div>
        </div>
      </div>
      ${s.handle?`<div class="kicker" id="handle">${esc(s.handle)}</div>`:''}
    </div>
    ${dotsHTML(ctx.index, ctx.total)}
  </div>`;

  const anim = `
    gsap.set("#plate",{scale:.92,opacity:0,y:30});
    ${s.eyebrow?'gsap.set("#eb",{y:20,opacity:0});':''}
    gsap.set("#kwrap",{scale:.8,opacity:0});
    ${s.handle?'gsap.set("#handle",{y:18,opacity:0});':''}
    gsap.set(".bloom",{scale:.7,opacity:0});
    tl.to(".bloom",{scale:1,opacity:.6,duration:1.2,stagger:.1},0)
      ${s.eyebrow?'.to("#eb",{y:0,opacity:1,duration:.6},.2)':''}
      .to("#plate",{scale:1,opacity:1,y:0,duration:.9,ease:"power4.out"},.25)
      .from("#head",{yPercent:14,opacity:0,duration:.7},.4)
      .to("#kwrap",{scale:1,opacity:1,duration:.7,ease:"back.out(1.8)"},.7)
      ${s.handle?'.to("#handle",{y:0,opacity:1,duration:.5},.9)':''};
    // pulse the keyword pill so it reads as the action (loops within hold)
    tl.to("#kwrap",{scale:1.05,duration:.5,ease:"sine.inOut",yoyo:true,repeat:3},"+=0.1");
  `;
  return { body, anim };
}

export const TEMPLATES = { cover, step, list, stat, cta };
