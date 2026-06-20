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
  // insurance / contact glyphs
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5L16 9" stroke-linecap="round"/></svg>`,
  plane:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg>`,
  heart:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 20s-7-4.3-9.2-8.5C1.3 8.3 2.7 5 6 5c2 0 3.2 1.2 4 2.4C10.8 6.2 12 5 14 5c3.3 0 4.7 3.3 3.2 6.5C19 15.7 12 20 12 20z"/></svg>`,
  umbrella:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2M3 12a9 9 0 0118 0H3zM12 12v6a2.5 2.5 0 01-5 0"/></svg>`,
  briefcase:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18"/></svg>`,
  family: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="2.6"/><circle cx="16" cy="7" r="2.6"/><path d="M3.5 19v-1a4 4 0 014-4h1a4 4 0 014 4v1M12.5 19v-1a4 4 0 014-4h0a4 4 0 014 4v1"/></svg>`,
  phone:  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a14 14 0 006.6 6.6l2.2-2.2a1 1 0 011-.24 11 11 0 003.5.56 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.2.2 2.4.56 3.5a1 1 0 01-.24 1L6.6 10.8z"/></svg>`,
  globe:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/></svg>`,
  mail:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M4 6.5l8 6 8-6"/></svg>`,
  pin:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-7-5.5-7-11a7 7 0 0114 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
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
