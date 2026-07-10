/**
 * Brand-extract — color candidate extraction + ranking (pure).
 *
 * Colors come from parsed CSS declarations, inline `style=""` attributes, and
 * brand-signal meta tags (`theme-color`, `msapplication-TileColor`). Every color
 * is normalized to the skill's hex grammar (`normalizeHex` — 3/4/6/8 hex, alpha
 * dropped; `rgb()/rgba()/hsl()/hsla()` converted via the skill's own color
 * math). A color that does not parse is DROPPED, never coerced.
 *
 * Ranking is by a deterministic usage score: frequency plus a bonus for
 * prominent brand roles (a brand custom-property, then buttons, links, headings,
 * backgrounds). Exact duplicates merge; near-duplicates (perceptually within a
 * small RGB radius) collapse into the higher-scoring representative. Each color
 * is classified `accent` (chromatic) vs `neutral` (grayscale / near-black-or-
 * white) from its HSL — so the draft can tell a brand color from page chrome.
 */

import { hexToRgb, hslToRgb, normalizeHex, rgbToHex } from "@/lib/skills/brand-kit";
import {
  classifyElement,
  parseDeclarations,
  ruleFlags,
  type CssRule,
  type ParsedCss,
  type SelectorFlags,
} from "./css-scan";
import type { InlineStyleUse } from "./html-scan";
import type { ColorCandidate, ColorClassification, ColorRoleSignals } from "./types";

export const MAX_COLOR_CANDIDATES = 16;
/** Colors within this RGB Euclidean distance collapse into one representative. */
export const NEAR_DUP_DISTANCE = 12;
/**
 * Absolute RGB chroma (max channel − min channel, 0–255) at/below which a color
 * reads as a NEUTRAL. Absolute chroma (not HSL saturation) is used on purpose:
 * a dark ink like `#111827` is barely off-gray (chroma 22) yet has a high HSL
 * saturation (~39%) because saturation is inflated at low lightness — chroma
 * keeps it correctly neutral, while a real accent like `#2b6cff` (chroma 212)
 * stays accent.
 */
export const NEUTRAL_CHROMA_MAX = 30;

/* ------------------------------------------------------------------ */
/* Color value parsing → normalized hex list                           */
/* ------------------------------------------------------------------ */

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

/** Parse one `rgb()/rgba()` argument list to a hex, or null. */
function rgbFuncToHex(args: string): string | null {
  const parts = args.split(/[\s,/]+/).filter((p) => p !== "");
  if (parts.length < 3) return null;
  const chan = (raw: string): number | null => {
    const pct = raw.endsWith("%");
    const num = Number(pct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(num)) return null;
    return clamp255(pct ? (num / 100) * 255 : num);
  };
  const r = chan(parts[0]);
  const g = chan(parts[1]);
  const b = chan(parts[2]);
  if (r === null || g === null || b === null) return null;
  return rgbToHex({ r, g, b });
}

/** Parse one `hsl()/hsla()` argument list to a hex, or null. */
function hslFuncToHex(args: string): string | null {
  const parts = args.split(/[\s,/]+/).filter((p) => p !== "");
  if (parts.length < 3) return null;
  const h = Number(parts[0].replace(/deg$/i, ""));
  const s = Number(parts[1].replace(/%$/, ""));
  const l = Number(parts[2].replace(/%$/, ""));
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return rgbToHex(hslToRgb({ h, s, l }));
}

const HEX_RUN = /#[0-9a-fA-F]+/g;
const RGB_FUNC = /rgba?\(([^)]*)\)/gi;
const HSL_FUNC = /hsla?\(([^)]*)\)/gi;

/** Every valid color in a CSS value, normalized to `#rrggbb`. Invalid runs are dropped. */
export function colorsInValue(value: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;

  HEX_RUN.lastIndex = 0;
  while ((m = HEX_RUN.exec(value)) !== null) {
    const run = m[0].slice(1);
    // Only the grammar the skill accepts; a 5- or 7-digit run is not a color.
    if (run.length === 3 || run.length === 4 || run.length === 6 || run.length === 8) {
      try {
        out.push(normalizeHex(m[0]));
      } catch {
        /* not a color — drop */
      }
    }
  }
  RGB_FUNC.lastIndex = 0;
  while ((m = RGB_FUNC.exec(value)) !== null) {
    const hex = rgbFuncToHex(m[1]);
    if (hex !== null) out.push(hex);
  }
  HSL_FUNC.lastIndex = 0;
  while ((m = HSL_FUNC.exec(value)) !== null) {
    const hex = hslFuncToHex(m[1]);
    if (hex !== null) out.push(hex);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Role assignment                                                     */
/* ------------------------------------------------------------------ */

function emptyRoles(): ColorRoleSignals {
  return {
    background: false,
    button: false,
    header: false,
    link: false,
    text: false,
    border: false,
    brandVariable: false,
    inline: false,
  };
}

const BRAND_VAR_NAME = /accent|primary|brand|secondary|theme|main/;

/** Which roles a declaration under `flags` contributes, from prop + selector context. */
function rolesForDeclaration(prop: string, flags: SelectorFlags, inline: boolean): ColorRoleSignals {
  const roles = emptyRoles();
  roles.inline = inline;

  if (prop === "background" || prop === "background-color" || prop === "background-image") {
    roles.background = true;
  }
  if (prop === "color") {
    if (flags.isLink) roles.link = true;
    else if (flags.isHeading) roles.header = true;
    else roles.text = true;
  }
  if (prop === "outline" || prop === "outline-color" || (prop.startsWith("border") && prop.includes("color")) || prop === "border") {
    roles.border = true;
  }
  if (flags.isButton) roles.button = true;
  if (prop.startsWith("--") && BRAND_VAR_NAME.test(prop)) roles.brandVariable = true;

  return roles;
}

interface ColorAgg {
  hex: string;
  frequency: number;
  roles: ColorRoleSignals;
}

function mergeRolesInto(target: ColorRoleSignals, add: ColorRoleSignals): void {
  target.background ||= add.background;
  target.button ||= add.button;
  target.header ||= add.header;
  target.link ||= add.link;
  target.text ||= add.text;
  target.border ||= add.border;
  target.brandVariable ||= add.brandVariable;
  target.inline ||= add.inline;
}

function bump(map: Map<string, ColorAgg>, hex: string, roles: ColorRoleSignals, weight: number): void {
  let agg = map.get(hex);
  if (agg === undefined) {
    agg = { hex, frequency: 0, roles: emptyRoles() };
    map.set(hex, agg);
  }
  agg.frequency += weight;
  mergeRolesInto(agg.roles, roles);
}

/* ------------------------------------------------------------------ */
/* Scoring, classification, dedup                                      */
/* ------------------------------------------------------------------ */

function score(agg: ColorAgg): number {
  let s = agg.frequency;
  if (agg.roles.brandVariable) s += 50;
  if (agg.roles.button) s += 20;
  if (agg.roles.link) s += 12;
  if (agg.roles.header) s += 8;
  if (agg.roles.background) s += 6;
  if (agg.roles.border) s += 1;
  return s;
}

export function classifyColor(hex: string): ColorClassification {
  const { r, g, b } = hexToRgb(hex);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return chroma <= NEUTRAL_CHROMA_MAX ? "neutral" : "accent";
}

function distance(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const dr = x.r - y.r;
  const dg = x.g - y.g;
  const db = x.b - y.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Deterministic comparator: score desc, then hex asc (total order → byte-identical output). */
function byScore(a: ColorAgg, b: ColorAgg): number {
  const d = score(b) - score(a);
  return d !== 0 ? d : a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface ColorExtractionSources {
  parsedCss?: ParsedCss;
  rules?: CssRule[];
  inlineStyles: InlineStyleUse[];
  metaByName: Map<string, string>;
}

export function extractColors(sources: ColorExtractionSources): ColorCandidate[] {
  const rules = sources.parsedCss?.rules ?? sources.rules ?? [];
  const map = new Map<string, ColorAgg>();

  // CSS rules.
  for (const rule of rules) {
    const flags = ruleFlags(rule);
    for (const decl of rule.declarations) {
      const roles = rolesForDeclaration(decl.prop, flags, false);
      for (const hex of colorsInValue(decl.value)) bump(map, hex, roles, 1);
    }
  }

  // Inline styles.
  for (const use of sources.inlineStyles) {
    const flags = classifyElement(use.tag, use.signal);
    for (const decl of parseDeclarations(use.style)) {
      const roles = rolesForDeclaration(decl.prop, flags, true);
      for (const hex of colorsInValue(decl.value)) bump(map, hex, roles, 1);
    }
  }

  // Brand-signal meta colors (theme-color, tile color). Weighted like a brand var.
  for (const key of ["theme-color", "msapplication-tilecolor"]) {
    const content = sources.metaByName.get(key);
    if (content === undefined) continue;
    for (const hex of colorsInValue(content)) {
      const roles = emptyRoles();
      roles.brandVariable = true;
      bump(map, hex, roles, 3);
    }
  }

  // Near-duplicate collapse: strongest-first, merge weaker near-neighbours in.
  const sorted = Array.from(map.values()).sort(byScore);
  const reps: ColorAgg[] = [];
  for (const agg of sorted) {
    const near = reps.find((r) => distance(r.hex, agg.hex) <= NEAR_DUP_DISTANCE);
    if (near !== undefined) {
      near.frequency += agg.frequency;
      mergeRolesInto(near.roles, agg.roles);
    } else {
      reps.push(agg);
    }
  }

  return reps
    .sort(byScore)
    .slice(0, MAX_COLOR_CANDIDATES)
    .map((agg) => ({
      hex: agg.hex,
      frequency: agg.frequency,
      roles: agg.roles,
      classification: classifyColor(agg.hex),
    }));
}
