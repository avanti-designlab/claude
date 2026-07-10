/**
 * Brand-extract — tolerant CSS parser + selector role classification (pure).
 *
 * CSS text (linked stylesheets + inline `<style>` blocks) is UNTRUSTED input,
 * same discipline as the HTML scanner: index-based, brace-depth-aware, quote-
 * aware, every cap enforced, never throws. `@media`/`@supports`/`@layer` blocks
 * are flattened so their inner rules are seen; `@font-face` descriptor blocks
 * are collected separately (a declared web font is a strong brand-font signal);
 * other at-rules (`@keyframes`, `@import`, `@page`) are skipped whole.
 *
 * Selector classification turns a selector string into role FLAGS
 * (button / heading / link / body / mono / root) so the color + font extractors
 * can weight a value by WHERE it is used — a color on a button or a font on an
 * `h1` is a brand signal, the same value on a footnote is not.
 */

export interface CssDeclaration {
  prop: string;
  value: string;
}
export interface CssRule {
  selectors: string[];
  declarations: CssDeclaration[];
}
export interface ParsedCss {
  rules: CssRule[];
  /** Each `@font-face` block's declarations (contains the `font-family` descriptor). */
  fontFaces: CssDeclaration[][];
  /** Total rules parsed (diagnostics). */
  ruleCount: number;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

export const MAX_CSS_CHARS = 4_000_000;
export const MAX_CSS_RULES = 40_000;
export const MAX_DECLS_PER_RULE = 400;
export const MAX_SELECTORS_PER_RULE = 400;
const MAX_AT_DEPTH = 30;

/* ------------------------------------------------------------------ */
/* Low-level tolerant scanning                                         */
/* ------------------------------------------------------------------ */

/** Strip `/* … *\/` comments (index-based; an unterminated comment runs to end). */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const start = css.indexOf("/*", i);
    if (start === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start);
    const end = css.indexOf("*/", start + 2);
    if (end === -1) break; // unterminated — drop the rest
    i = end + 2;
  }
  return out;
}

/** Index of the `}` matching the `{` at `open`, quote-aware; `end` if unbalanced. */
function matchBrace(css: string, open: number, end: number): number {
  let depth = 0;
  let quote = "";
  let i = open;
  while (i < end) {
    const c = css[i];
    if (quote !== "") {
      if (c === quote && css[i - 1] !== "\\") quote = "";
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return end;
}

/** Split `str` on top-level `sep` only (ignoring `sep` inside (), [], and quotes). */
export function splitTopLevel(str: string, sep: string): string[] {
  const out: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (quote !== "") {
      if (c === quote && str[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depthParen += 1;
    else if (c === ")") depthParen = Math.max(0, depthParen - 1);
    else if (c === "[") depthBracket += 1;
    else if (c === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (c === sep && depthParen === 0 && depthBracket === 0) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  out.push(str.slice(start));
  return out;
}

export function parseDeclarations(block: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  for (const chunk of splitTopLevel(block, ";")) {
    if (out.length >= MAX_DECLS_PER_RULE) break;
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (prop === "" || value === "") continue;
    out.push({ prop, value });
  }
  return out;
}

function atKeyword(prelude: string): string {
  const m = prelude.match(/^@[\w-]+/);
  return m ? m[0].toLowerCase() : "@";
}

function collectRules(css: string, start: number, end: number, depth: number, out: ParsedCss): void {
  if (depth > MAX_AT_DEPTH) return;
  let i = start;
  while (i < end && out.ruleCount < MAX_CSS_RULES) {
    const brace = css.indexOf("{", i);
    if (brace === -1 || brace >= end) break;
    const semi = css.indexOf(";", i);
    if (semi !== -1 && semi < brace) {
      // A statement at-rule (`@import …;`, `@charset …;`) — no block. Skip it.
      i = semi + 1;
      continue;
    }
    const prelude = css.slice(i, brace).trim();
    const close = matchBrace(css, brace, end);
    const bodyStart = brace + 1;

    if (prelude.startsWith("@")) {
      const at = atKeyword(prelude);
      if (at === "@media" || at === "@supports" || at === "@document" || at === "@layer" || at === "@container") {
        collectRules(css, bodyStart, close, depth + 1, out);
      } else if (at === "@font-face") {
        out.fontFaces.push(parseDeclarations(css.slice(bodyStart, close)));
      }
      // @keyframes / @page / @font-feature-values / … → skipped whole.
    } else {
      const selectors = splitTopLevel(prelude, ",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .slice(0, MAX_SELECTORS_PER_RULE);
      const declarations = parseDeclarations(css.slice(bodyStart, close));
      if (selectors.length > 0 && declarations.length > 0) {
        out.rules.push({ selectors, declarations });
        out.ruleCount += 1;
      }
    }
    i = close < end ? close + 1 : end;
  }
}

/** Parse one or more CSS text blobs into flattened rules + `@font-face` blocks. Never throws. */
export function parseCss(blobs: string[]): ParsedCss {
  const out: ParsedCss = { rules: [], fontFaces: [], ruleCount: 0 };
  let budget = MAX_CSS_CHARS;
  for (const blob of blobs) {
    if (typeof blob !== "string" || blob === "" || budget <= 0) continue;
    const slice = blob.length > budget ? blob.slice(0, budget) : blob;
    budget -= slice.length;
    const css = stripComments(slice);
    collectRules(css, 0, css.length, 0, out);
    if (out.ruleCount >= MAX_CSS_RULES) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Selector role classification                                        */
/* ------------------------------------------------------------------ */

export interface SelectorFlags {
  isButton: boolean;
  isHeading: boolean;
  isLink: boolean;
  isBody: boolean;
  isRoot: boolean;
  isMono: boolean;
}

export function emptyFlags(): SelectorFlags {
  return { isButton: false, isHeading: false, isLink: false, isBody: false, isRoot: false, isMono: false };
}

export function mergeFlags(a: SelectorFlags, b: SelectorFlags): SelectorFlags {
  return {
    isButton: a.isButton || b.isButton,
    isHeading: a.isHeading || b.isHeading,
    isLink: a.isLink || b.isLink,
    isBody: a.isBody || b.isBody,
    isRoot: a.isRoot || b.isRoot,
    isMono: a.isMono || b.isMono,
  };
}

const RE_BUTTON = /(?:^|[.#])(?:btn|button|cta)(?![a-z])|^button(?:[.#:[]|$)|\[type=["']?(?:submit|button)/;
const RE_HEADING = /^h[1-6](?:[.#:[]|$)|(?:^|[.#])(?:title|heading|headline|display|hero-?title|page-?title)(?![a-z])/;
const RE_LINK = /^a(?:[.#:[]|$)|(?:^|[.#])(?:nav-?link|menu-?link|link)(?![a-z])/;
const RE_MONO = /^(?:code|pre|kbd|samp|tt)(?:[.#:[]|$)|(?:^|[.#])(?:code|mono)(?![a-z])/;
const RE_BODY = /^(?:body|html|p)(?:[.#:[]|$)|(?:^|[.#])(?:content|prose|article|body-copy|copy|text)(?![a-z])/;

/** Classify a full selector string (compound + combinators) into role flags. */
export function classifySelector(selector: string): SelectorFlags {
  const flags = emptyFlags();
  const compounds = selector.toLowerCase().split(/[\s>+~]+/).filter((t) => t !== "");
  for (const t of compounds) {
    if (RE_BUTTON.test(t)) flags.isButton = true;
    if (RE_HEADING.test(t)) flags.isHeading = true;
    if (RE_LINK.test(t)) flags.isLink = true;
    if (RE_MONO.test(t)) flags.isMono = true;
    if (RE_BODY.test(t)) flags.isBody = true;
    if (t === ":root" || t === "html" || t === "body") flags.isRoot = true;
  }
  return flags;
}

/** Classify an element (tag + class/id haystack) as if it were a compound selector — for inline styles. */
export function classifyElement(tag: string, signal: string): SelectorFlags {
  const classTokens = signal
    .split(/\s+/)
    .filter((c) => c !== "")
    .map((c) => `.${c}`)
    .join("");
  return classifySelector(`${tag}${classTokens}`);
}

/** Union the flags across every selector of a rule. */
export function ruleFlags(rule: CssRule): SelectorFlags {
  let flags = emptyFlags();
  for (const sel of rule.selectors) flags = mergeFlags(flags, classifySelector(sel));
  return flags;
}
