// icons.js — resolve an icon name to an inline SVG string.
// 1) tries simple-icons (real app/brand logos, e.g. "instagram", "notion")
// 2) falls back to a small built-in UI glyph set (arrow, check, bolt, ...)
import * as si from 'simple-icons';

// built-in stroke/line glyphs (single accent, inherit currentColor)
const UI = {
  arrow:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  swipe:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  check:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6"/></svg>`,
  bolt:   `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>`,
  spark:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.2L20.4 11l-6.2 2.2L12 20l-2.2-6.2L3.6 11l6.2-2.2L12 2z"/></svg>`,
  clock:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  chart:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7"/></svg>`,
  lock:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>`,
  rocket: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3c4 0 7 3 7 7 0 1-3 6-7 8-1-1-5-1-6-6 2-4 7-9 6-9zM6 16c-2 1-3 5-3 5s4-1 5-3"/></svg>`,
  message:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5z"/></svg>`,
  eye:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

function toPascal(name){
  return 'si' + name.replace(/[^a-z0-9]+/gi,' ').trim()
    .split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join('');
}

// returns { svg, hex|null, brand:bool }
export function resolveIcon(name){
  const key = String(name||'').trim();
  // built-in UI glyph?
  if (UI[key.toLowerCase()]) return { svg: UI[key.toLowerCase()], hex: null, brand:false };
  // simple-icons brand?
  const direct = si[toPascal(key)];
  if (direct && direct.svg) return { svg: direct.svg, hex: '#'+direct.hex, brand:true };
  // unknown -> spark placeholder so layout never breaks
  return { svg: UI.spark, hex: null, brand:false };
}

// strip width/height so CSS controls size; optionally force a fill color
export function normalizeSvg(svg, { fill } = {}){
  let s = svg.replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" ');
  if (fill) s = s.replace(/<svg /, `<svg fill="${fill}" `);
  return s;
}
