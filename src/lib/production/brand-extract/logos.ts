/**
 * Brand-extract — logo, imagery, and structured-data extraction (pure).
 *
 * Logo candidates are RANKED across the sources a first-pass brand read can
 * trust: header/nav `<img>` with logo-ish alt/class/filename, an Organization
 * `logo` declared in JSON-LD structured data, inline header `<svg>`,
 * `apple-touch-icon`/`icon` links, and `og:image` as a last resort. Each carries
 * the RESOLVED absolute URL (or null for an inline SVG, which has no addressable
 * URL) and a fixed-template, operator-facing reason — reasons never embed
 * untrusted site text.
 *
 * Imagery candidates (og:image, twitter:image, hero `<img>`, CSS hero
 * backgrounds) are resolved to absolute URLs for a later preview step.
 */

import { fileNameOf, resolveUrl } from "./url";
import type { CssRule } from "./css-scan";
import type { PageModel } from "./html-scan";
import type { ImageryCandidate, LogoCandidate, LogoKind } from "./types";

export const MAX_LOGO_CANDIDATES = 10;
export const MAX_IMAGERY_CANDIDATES = 12;
const MAX_INLINE_SVG_CANDIDATES = 3;
/** Bounded JSON-LD walk. */
const MAX_JSONLD_NODES = 5_000;

const LOGO_WORD = /logo|brand|wordmark|lockup/;
const HEADERISH_SIGNAL = /header|navbar|topbar|masthead/;
const HERO_SELECTOR = /hero|banner|masthead|cover|jumbotron|splash/;

interface ScoredLogo {
  score: number;
  cand: LogoCandidate;
}

/* ------------------------------------------------------------------ */
/* Structured data (schema.org Organization)                           */
/* ------------------------------------------------------------------ */

function urlLike(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = urlLike(x);
      if (u !== null) return u;
    }
    return null;
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string") return o.url;
    if (typeof o.contentUrl === "string") return o.contentUrl;
  }
  return null;
}

function typeIsOrg(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /organization|localbusiness|corporation|ngo|store|restaurant/i.test(x));
}

export interface StructuredData {
  name: string | null;
  logo: string | null;
}

/** Read Organization name + logo from JSON-LD blocks. Tolerant — invalid JSON is skipped, never thrown. */
export function readStructuredData(blocks: string[]): StructuredData {
  let name: string | null = null;
  let logo: string | null = null;
  for (const raw of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_JSONLD_NODES) {
      const node = queue.shift();
      visited += 1;
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (node === null || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const org = typeIsOrg(o["@type"]);
      if (logo === null && "logo" in o) logo = urlLike(o.logo);
      if (org && name === null && typeof o.name === "string" && o.name.trim() !== "") name = o.name.trim();
      for (const value of Object.values(o)) {
        if (value !== null && typeof value === "object") queue.push(value);
      }
    }
    if (name !== null && logo !== null) break;
  }
  return { name, logo };
}

/* ------------------------------------------------------------------ */
/* Logos                                                               */
/* ------------------------------------------------------------------ */

export function extractLogos(page: PageModel, base: string | null, structured: StructuredData): LogoCandidate[] {
  const scored: ScoredLogo[] = [];

  // Header/nav (or header-ish class) images.
  for (const img of page.images) {
    const haystack = `${img.signal} ${img.alt ?? ""} ${fileNameOf(img.src)}`.toLowerCase();
    const hasLogoWord = LOGO_WORD.test(haystack);
    const headerish = img.inHeader || img.inNav || HEADERISH_SIGNAL.test(img.signal);
    if (!hasLogoWord && !headerish) continue;
    const kind: LogoKind = img.inNav ? "nav-img" : "header-img";
    const where = img.inNav ? "navigation" : "header";
    let scoreVal: number;
    let reason: string;
    if (hasLogoWord && headerish) {
      scoreVal = img.inNav ? 96 : 100;
      reason = `Image in the site ${where} flagged as a logo (its alt, class, or filename says "logo").`;
    } else if (hasLogoWord) {
      scoreVal = 70;
      reason = `Image flagged as a logo (its alt, class, or filename says "logo").`;
    } else if (img.order === 0) {
      scoreVal = 60;
      reason = `First image in the site ${where} — commonly the logo.`;
    } else {
      scoreVal = 45;
      reason = `Image in the site ${where}.`;
    }
    scored.push({ score: scoreVal, cand: { kind, url: resolveUrl(img.src, base), reason } });
  }

  // Structured-data Organization logo (only when it resolves to a URL).
  if (structured.logo !== null) {
    const url = resolveUrl(structured.logo, base);
    if (url !== null) {
      scored.push({
        score: 90,
        cand: { kind: "structured-data", url, reason: "Organization logo declared in the site's structured data (schema.org)." },
      });
    }
  }

  // Inline header/nav SVGs (no addressable URL).
  let svgCount = 0;
  for (const svg of page.headerSvgs) {
    if (svgCount >= MAX_INLINE_SVG_CANDIDATES) break;
    svgCount += 1;
    const where = svg.inNav ? "navigation" : "header";
    scored.push({
      score: 55,
      cand: {
        kind: "inline-svg",
        url: null,
        reason: `Inline SVG in the site ${where} — often the logo mark, but it has no addressable URL to reuse directly.`,
      },
    });
  }

  // Icon links.
  const iconSeen = new Set<string>();
  for (const link of page.iconLinks) {
    const url = resolveUrl(link.href, base);
    if (url === null || iconSeen.has(url)) continue;
    iconSeen.add(url);
    if (link.rel.includes("apple-touch-icon")) {
      scored.push({ score: 40, cand: { kind: "apple-touch-icon", url, reason: "Apple touch icon — a square, app-style brand mark." } });
    } else if (link.rel.includes("mask-icon")) {
      scored.push({ score: 34, cand: { kind: "icon-link", url, reason: "Safari mask icon — a monochrome brand mark." } });
    } else {
      scored.push({ score: 30, cand: { kind: "icon-link", url, reason: "Site favicon." } });
    }
  }

  // og:image as a last-resort brand image.
  const og = page.metaByName.get("og:image") ?? page.metaByName.get("og:image:url");
  if (og !== undefined) {
    const url = resolveUrl(og, base);
    if (url !== null) {
      scored.push({
        score: 15,
        cand: { kind: "og-image", url, reason: "Social share image (og:image) — a fallback brand image, not necessarily a logo." },
      });
    }
  }

  scored.sort((a, b) => {
    const d = b.score - a.score;
    if (d !== 0) return d;
    const ka = `${a.cand.kind}|${a.cand.url ?? ""}`;
    const kb = `${b.cand.kind}|${b.cand.url ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const out: LogoCandidate[] = [];
  const urlSeen = new Set<string>();
  for (const { cand } of scored) {
    if (out.length >= MAX_LOGO_CANDIDATES) break;
    if (cand.url !== null) {
      if (urlSeen.has(cand.url)) continue;
      urlSeen.add(cand.url);
    }
    out.push(cand);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Imagery                                                             */
/* ------------------------------------------------------------------ */

const URL_FUNC = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function urlsInValue(value: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  URL_FUNC.lastIndex = 0;
  while ((m = URL_FUNC.exec(value)) !== null) {
    const u = m[2].trim();
    if (u !== "") out.push(u);
  }
  return out;
}

export function extractImagery(page: PageModel, rules: CssRule[], base: string | null): ImageryCandidate[] {
  const out: ImageryCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined, kind: ImageryCandidate["kind"], reason: string): void => {
    if (raw === undefined) return;
    if (out.length >= MAX_IMAGERY_CANDIDATES) return;
    const url = resolveUrl(raw, base);
    if (url === null || seen.has(url)) return;
    seen.add(url);
    out.push({ kind, url, reason });
  };

  push(page.metaByName.get("og:image") ?? page.metaByName.get("og:image:url"), "og-image", "Open Graph share image (og:image).");
  push(page.metaByName.get("twitter:image") ?? page.metaByName.get("twitter:image:src"), "twitter-image", "Twitter/X card image (twitter:image).");

  for (const img of page.images) {
    if (img.hero) push(img.src, "hero-image", "Large or hero-marked image in the page header/banner area.");
  }

  for (const rule of rules) {
    if (!HERO_SELECTOR.test(rule.selectors.join(" ").toLowerCase())) continue;
    for (const decl of rule.declarations) {
      if (decl.prop === "background" || decl.prop === "background-image") {
        for (const u of urlsInValue(decl.value)) push(u, "hero-background", "Hero/banner background image declared in CSS.");
      }
    }
  }

  return out;
}
