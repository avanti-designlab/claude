/**
 * Brand-extract — font candidate extraction + ranking (pure).
 *
 * Font families are read from: parsed CSS `font-family` declarations, `@font-face`
 * `font-family` descriptors (a declared web font is a strong brand-font signal),
 * Google-Fonts `<link>` hrefs (`family=` params), and inline `style=""`
 * font-family. The PRIMARY family of a stack is its first non-generic member;
 * generic keywords (serif/sans-serif/monospace/system-ui/…) are recorded but
 * never chosen as a brand face.
 *
 * The display-vs-body heuristic comes from WHICH SELECTORS reference a family:
 * heading selectors (h1–h6, `.title`…) → display; body/root selectors
 * (`body`, `p`, `.content`…) → body; code/monospace selectors or a monospace
 * stack → mono. A family seen only via `@font-face`/Google-link with no selector
 * usage stays `unknown` (honest — its role is undetermined).
 */

import { splitTopLevel, parseDeclarations, type CssDeclaration, type CssRule, type SelectorFlags } from "./css-scan";
import { classifyElement, classifySelector, mergeFlags, emptyFlags } from "./css-scan";
import type { InlineStyleUse } from "./html-scan";
import type { FontCandidate, FontRole, FontSourceKind } from "./types";

export const MAX_FONT_CANDIDATES = 12;

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

const SOURCE_ORDER: FontSourceKind[] = ["css-selector", "font-face", "google-fonts-link", "inline-style"];

function cleanFamily(raw: string): string | null {
  const unquoted = raw.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
  const collapsed = unquoted.replace(/\s+/g, " ");
  return collapsed === "" ? null : collapsed;
}

function isGeneric(family: string): boolean {
  return GENERIC_FAMILIES.has(family.toLowerCase());
}

/** Split a font stack, clean each family. */
function stackFamilies(value: string): string[] {
  return splitTopLevel(value, ",")
    .map(cleanFamily)
    .filter((f): f is string => f !== null);
}

/** The primary (first non-generic) family of a stack, plus whether the stack declares a monospace category. */
function primaryOf(value: string): { family: string; generic: boolean; mono: boolean } | null {
  const families = stackFamilies(value);
  if (families.length === 0) return null;
  const mono = families.some((f) => {
    const l = f.toLowerCase();
    return l === "monospace" || l === "ui-monospace";
  });
  const primary = families.find((f) => !isGeneric(f));
  if (primary !== undefined) return { family: primary, generic: false, mono };
  return { family: families[0], generic: true, mono };
}

interface FontAgg {
  family: string;
  frequency: number;
  sources: Set<FontSourceKind>;
  headingHits: number;
  bodyHits: number;
  monoHits: number;
  generic: boolean;
}

function getAgg(map: Map<string, FontAgg>, family: string, generic: boolean): FontAgg {
  const key = family.toLowerCase();
  let agg = map.get(key);
  if (agg === undefined) {
    agg = { family, frequency: 0, sources: new Set(), headingHits: 0, bodyHits: 0, monoHits: 0, generic };
    map.set(key, agg);
  }
  // A later non-generic sighting of the same key wins the display name + drops the generic mark.
  if (!generic && agg.generic) {
    agg.generic = false;
    agg.family = family;
  }
  return agg;
}

function applyFamily(
  map: Map<string, FontAgg>,
  value: string,
  flags: SelectorFlags,
  source: FontSourceKind,
): void {
  const primary = primaryOf(value);
  if (primary === null) return;
  const agg = getAgg(map, primary.family, primary.generic);
  agg.frequency += 1;
  agg.sources.add(source);
  if (primary.mono || flags.isMono) agg.monoHits += 1;
  else if (flags.isHeading) agg.headingHits += 1;
  else if (flags.isBody || flags.isRoot) agg.bodyHits += 1;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Font families named in Google-Fonts `<link>` hrefs (`family=Playfair+Display:wght@700`). */
export function parseGoogleFamilies(hrefs: string[]): string[] {
  const out: string[] = [];
  for (const href of hrefs) {
    const qIdx = href.indexOf("?");
    if (qIdx === -1) continue;
    for (const param of href.slice(qIdx + 1).split("&")) {
      const eq = param.indexOf("=");
      if (eq === -1 || param.slice(0, eq) !== "family") continue;
      for (const fam of param.slice(eq + 1).split("|")) {
        const name = safeDecode(fam.split(":")[0].replace(/\+/g, " ")).trim();
        if (name !== "") out.push(name);
      }
    }
  }
  return out;
}

function resolveRole(agg: FontAgg): FontRole {
  if (agg.monoHits > 0 && agg.monoHits >= agg.headingHits && agg.monoHits >= agg.bodyHits) return "mono";
  if (agg.headingHits > agg.bodyHits) return "display";
  if (agg.bodyHits > agg.headingHits) return "body";
  if (agg.headingHits > 0) return "display";
  return "unknown";
}

function score(agg: FontAgg): number {
  let s = agg.frequency;
  if (agg.sources.has("font-face")) s += 30;
  if (agg.sources.has("google-fonts-link")) s += 20;
  s += agg.headingHits * 4 + agg.bodyHits * 4 + agg.monoHits * 3;
  if (agg.generic) s -= 1000; // generics rank last; the draft skips them entirely
  return s;
}

export interface FontExtractionSources {
  rules: CssRule[];
  fontFaces: CssDeclaration[][];
  googleFontHrefs: string[];
  inlineStyles: InlineStyleUse[];
}

export function extractFonts(sources: FontExtractionSources): FontCandidate[] {
  const map = new Map<string, FontAgg>();

  for (const rule of sources.rules) {
    let flags = emptyFlags();
    for (const sel of rule.selectors) flags = mergeFlags(flags, classifySelector(sel));
    for (const decl of rule.declarations) {
      if (decl.prop === "font-family") applyFamily(map, decl.value, flags, "css-selector");
    }
  }

  for (const face of sources.fontFaces) {
    for (const decl of face) {
      if (decl.prop === "font-family") applyFamily(map, decl.value, emptyFlags(), "font-face");
    }
  }

  for (const fam of parseGoogleFamilies(sources.googleFontHrefs)) {
    applyFamily(map, fam, emptyFlags(), "google-fonts-link");
  }

  for (const use of sources.inlineStyles) {
    const flags = classifyElement(use.tag, use.signal);
    for (const decl of parseDeclarations(use.style)) {
      if (decl.prop === "font-family") applyFamily(map, decl.value, flags, "inline-style");
    }
  }

  return Array.from(map.values())
    .sort((a, b) => {
      const d = score(b) - score(a);
      return d !== 0 ? d : a.family.toLowerCase() < b.family.toLowerCase() ? -1 : a.family.toLowerCase() > b.family.toLowerCase() ? 1 : 0;
    })
    .slice(0, MAX_FONT_CANDIDATES)
    .map((agg) => ({
      family: agg.family,
      role: resolveRole(agg),
      sources: SOURCE_ORDER.filter((s) => agg.sources.has(s)),
      frequency: agg.frequency,
      generic: agg.generic,
    }));
}
