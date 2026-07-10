/**
 * Brand-extract — tolerant HTML tokenizer + page scanner (pure, no DOM).
 *
 * The same hostile-input discipline as the M2 crawl extractor
 * (src/lib/intelligence/crawl/extract.ts): client HTML is UNTRUSTED. Scanning is
 * index-based (`indexOf`) and every loop iteration advances the cursor, so
 * pathological markup (unclosed quotes/tags/comments, `<<<<<` floods, attribute
 * bombs) terminates in linear time. Everything collected is CAPPED. The scanner
 * NEVER throws — garbage input yields an honestly-empty page model, never a
 * fabricated signal.
 *
 * This parses SERVER HTML only — no JS execution, no CSS cascade. It is exactly
 * the surface a non-rendering AI crawler sees, which is the surface a first-pass
 * brand read should reason about.
 */

/* ------------------------------------------------------------------ */
/* Caps (single source of truth for the scanner's bounds)              */
/* ------------------------------------------------------------------ */

export const MAX_TOKENS = 400_000;
export const MAX_TEXT_CHUNKS = 20_000;
export const MAX_TEXT_CHUNK_CHARS = 20_000;
export const MAX_IMAGES = 2_000;
export const MAX_ICON_LINKS = 200;
export const MAX_INLINE_STYLES = 5_000;
export const MAX_STYLE_BLOCKS = 500;
export const MAX_META = 1_000;
export const MAX_JSONLD_BLOCKS = 100;
export const MAX_ATTR_CHARS = 4_000;
const MAX_ATTRS_PER_TAG = 100;

/* ------------------------------------------------------------------ */
/* Shared text helpers (exported — sub-parsers reuse them)             */
/* ------------------------------------------------------------------ */

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Decode the handful of entities that matter for text/URL fidelity (linear-safe pattern). */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function isTagNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-";
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/* ------------------------------------------------------------------ */
/* Token shapes                                                        */
/* ------------------------------------------------------------------ */

export interface HtmlOpenToken {
  type: "open";
  name: string;
  attrs: Map<string, string>;
  /**
   * Inner content for raw-text elements (script/style/title/textarea/svg/…),
   * captured verbatim to the matching close tag; `null` for every other tag.
   */
  raw: string | null;
}
export interface HtmlCloseToken {
  type: "close";
  name: string;
}
export interface HtmlTextToken {
  type: "text";
  text: string;
}
export type HtmlToken = HtmlOpenToken | HtmlCloseToken | HtmlTextToken;

/** Raw-text elements: inner content is taken as a block, never tokenized as tags. */
const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "textarea", "title", "svg"]);

interface ParsedTag {
  name: string;
  attrs: Map<string, string>;
  /** Index just past the tag's closing ">" (or the recovery point on malformed markup). */
  end: number;
}

/**
 * Parse one opening tag starting at `lt` (which must point at "<"). Returns null
 * when what follows is not a tag (a stray "<") — the caller emits the "<" as
 * text and advances one char, guaranteeing progress on "<<<<<" floods.
 */
function parseTag(html: string, lt: number): ParsedTag | null {
  const n = html.length;
  let i = lt + 1;
  const first = html[i];
  if (first === undefined || !((first >= "a" && first <= "z") || (first >= "A" && first <= "Z"))) return null;

  let nameEnd = i;
  while (nameEnd < n && isTagNameChar(html[nameEnd])) nameEnd += 1;
  const name = html.slice(i, nameEnd).toLowerCase();
  i = nameEnd;

  const attrs = new Map<string, string>();
  let attrCount = 0;
  while (i < n) {
    while (i < n && (isWhitespace(html[i]) || html[i] === "/")) i += 1;
    if (i >= n) break;
    const ch = html[i];
    if (ch === ">") return { name, attrs, end: i + 1 };
    if (ch === "<") return { name, attrs, end: i };
    if (attrCount >= MAX_ATTRS_PER_TAG) {
      const gt = html.indexOf(">", i);
      return { name, attrs, end: gt === -1 ? n : gt + 1 };
    }
    let j = i;
    while (j < n && !isWhitespace(html[j]) && html[j] !== "=" && html[j] !== ">" && html[j] !== "/" && html[j] !== "<") {
      j += 1;
    }
    const attrName = html.slice(i, j).toLowerCase();
    i = j;
    while (i < n && isWhitespace(html[i])) i += 1;
    let value = "";
    if (html[i] === "=") {
      i += 1;
      while (i < n && isWhitespace(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, close === -1 ? n : close);
        i = close === -1 ? n : close + 1;
      } else {
        let k = i;
        while (k < n && !isWhitespace(html[k]) && html[k] !== ">") k += 1;
        value = html.slice(i, k);
        i = k;
      }
    }
    if (attrName !== "" && !attrs.has(attrName)) {
      attrs.set(attrName, decodeEntities(value).slice(0, MAX_ATTR_CHARS));
    }
    attrCount += 1;
  }
  return { name, attrs, end: n };
}

/** Tokenize HTML into a bounded, linear token stream. Never throws. */
export function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  if (typeof html !== "string" || html === "") return tokens;
  const n = html.length;
  const htmlLower = html.toLowerCase();

  const pushText = (raw: string): void => {
    if (tokens.length >= MAX_TOKENS) return;
    const decoded = decodeEntities(raw);
    if (decoded.trim() === "") return;
    tokens.push({ type: "text", text: decoded.slice(0, MAX_TEXT_CHUNK_CHARS) });
  };

  let i = 0;
  while (i < n && tokens.length < MAX_TOKENS) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      let nameEnd = lt + 2;
      while (nameEnd < n && isTagNameChar(html[nameEnd])) nameEnd += 1;
      const name = html.slice(lt + 2, nameEnd).toLowerCase();
      const gt = html.indexOf(">", nameEnd);
      i = gt === -1 ? n : gt + 1;
      if (name !== "") tokens.push({ type: "close", name });
      continue;
    }

    const tag = parseTag(html, lt);
    if (tag === null) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (RAW_TEXT_TAGS.has(tag.name)) {
      const close = htmlLower.indexOf(`</${tag.name}`, tag.end);
      const inner = html.slice(tag.end, close === -1 ? n : close);
      if (close === -1) {
        i = n;
      } else {
        const closeGt = html.indexOf(">", close);
        i = closeGt === -1 ? n : closeGt + 1;
      }
      tokens.push({ type: "open", name: tag.name, attrs: tag.attrs, raw: inner });
      continue;
    }

    tokens.push({ type: "open", name: tag.name, attrs: tag.attrs, raw: null });
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Page model (structured facts the sub-parsers consume)               */
/* ------------------------------------------------------------------ */

export interface RawImg {
  src: string;
  /** null = no alt attribute (undecorative unknown); "" = explicit empty alt. */
  alt: string | null;
  /** Lowercased haystack of class + id + role + aria-label — the logo-ish signal source. */
  signal: string;
  inHeader: boolean;
  inNav: boolean;
  inFooter: boolean;
  hero: boolean;
  /** Document order among images (stable ranking tiebreak). */
  order: number;
}

export interface IconLink {
  rel: string;
  href: string;
  sizes: string;
}

export interface InlineStyleUse {
  /** Element tag name. */
  tag: string;
  /** Lowercased class + id haystack for role classification. */
  signal: string;
  /** Raw `style` attribute value (a declaration list). */
  style: string;
}

export interface HeaderSvg {
  inHeader: boolean;
  inNav: boolean;
  /** `<title>` text inside the SVG, if any — an accessible logo often titles itself. */
  title: string | null;
}

export interface PageModel {
  title: string | null;
  metaDescription: string | null;
  /** Lowercased meta name/property → content (og:*, twitter:*, theme-color, application-name…). */
  metaByName: Map<string, string>;
  iconLinks: IconLink[];
  /** `<link rel~="stylesheet">` google-fonts hrefs and any `<link>` to fonts.googleapis.com. */
  googleFontHrefs: string[];
  /** Raw `<style>` block contents found in the HTML (a CSS-absent fallback source). */
  styleBlocks: string[];
  images: RawImg[];
  headerSvgs: HeaderSvg[];
  inlineStyles: InlineStyleUse[];
  jsonLdBlocks: string[];
  /** Visible copy chunks (nav/footer excluded), decoded, for later voice summarization. */
  textChunks: string[];
  hadAnyTag: boolean;
}

const HERO_HINT = /hero|banner|cover|masthead|jumbotron|splash/;
const LOGO_LINK_RELS = /icon|apple-touch-icon|mask-icon|shortcut/;

/** Take the SVG `<title>…</title>` text from raw SVG inner markup (bounded, never throws). */
function svgTitle(raw: string): string | null {
  const lower = raw.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return null;
  const gt = raw.indexOf(">", open);
  if (gt === -1) return null;
  const close = lower.indexOf("</title", gt);
  const text = collapseWhitespace(decodeEntities(raw.slice(gt + 1, close === -1 ? raw.length : close)));
  return text === "" ? null : text;
}

/**
 * Fold a token stream into structured page facts. Header/nav/footer context is
 * tracked with floor-at-zero depth counters (tolerant of unbalanced markup).
 */
export function scanPage(tokens: HtmlToken[]): PageModel {
  const model: PageModel = {
    title: null,
    metaDescription: null,
    metaByName: new Map(),
    iconLinks: [],
    googleFontHrefs: [],
    styleBlocks: [],
    images: [],
    headerSvgs: [],
    inlineStyles: [],
    jsonLdBlocks: [],
    textChunks: [],
    hadAnyTag: false,
  };

  let headerDepth = 0;
  let navDepth = 0;
  let footerDepth = 0;
  let imgOrder = 0;

  for (const tok of tokens) {
    if (tok.type === "text") {
      if (navDepth > 0 || footerDepth > 0) continue; // menu/legal boilerplate — not voice material
      if (model.textChunks.length >= MAX_TEXT_CHUNKS) continue;
      const chunk = collapseWhitespace(tok.text);
      if (chunk === "") continue;
      model.textChunks.push(chunk);
      continue;
    }
    if (tok.type === "close") {
      if (tok.name === "header") headerDepth = Math.max(0, headerDepth - 1);
      else if (tok.name === "nav") navDepth = Math.max(0, navDepth - 1);
      else if (tok.name === "footer") footerDepth = Math.max(0, footerDepth - 1);
      continue;
    }

    // open token
    model.hadAnyTag = true;
    const { name, attrs, raw } = tok;
    const inHeader = headerDepth > 0;
    const inNav = navDepth > 0;
    const inFooter = footerDepth > 0;

    // Inline style attribute — a colors/fonts signal for any element.
    const styleAttr = attrs.get("style");
    if (styleAttr !== undefined && styleAttr.trim() !== "" && model.inlineStyles.length < MAX_INLINE_STYLES) {
      const signal = `${attrs.get("class") ?? ""} ${attrs.get("id") ?? ""}`.toLowerCase();
      model.inlineStyles.push({ tag: name, signal, style: styleAttr });
    }

    switch (name) {
      case "header":
        headerDepth += 1;
        break;
      case "nav":
        navDepth += 1;
        break;
      case "footer":
        footerDepth += 1;
        break;
      case "title": {
        if (model.title === null && raw !== null) {
          const t = collapseWhitespace(decodeEntities(raw));
          model.title = t === "" ? null : t;
        }
        break;
      }
      case "style": {
        if (raw !== null && raw.trim() !== "" && model.styleBlocks.length < MAX_STYLE_BLOCKS) {
          model.styleBlocks.push(raw);
        }
        break;
      }
      case "script": {
        const type = (attrs.get("type") ?? "").toLowerCase();
        if (type.includes("ld+json") && raw !== null && model.jsonLdBlocks.length < MAX_JSONLD_BLOCKS) {
          model.jsonLdBlocks.push(raw.trim());
        }
        break;
      }
      case "svg": {
        if (inHeader || inNav) {
          model.headerSvgs.push({ inHeader, inNav, title: raw !== null ? svgTitle(raw) : null });
        }
        break;
      }
      case "meta": {
        const key = (attrs.get("name") ?? attrs.get("property") ?? attrs.get("itemprop") ?? "").toLowerCase();
        const content = attrs.get("content");
        if (key !== "" && content !== undefined && !model.metaByName.has(key) && model.metaByName.size < MAX_META) {
          model.metaByName.set(key, content);
          if (key === "description" && model.metaDescription === null) model.metaDescription = content;
        }
        break;
      }
      case "link": {
        const rel = (attrs.get("rel") ?? "").toLowerCase();
        const href = attrs.get("href") ?? "";
        if (href !== "") {
          if (LOGO_LINK_RELS.test(rel) && model.iconLinks.length < MAX_ICON_LINKS) {
            model.iconLinks.push({ rel, href, sizes: (attrs.get("sizes") ?? "").toLowerCase() });
          }
          if (/fonts\.googleapis\.com/i.test(href)) model.googleFontHrefs.push(href);
        }
        break;
      }
      case "img": {
        const src = attrs.get("src") ?? attrs.get("data-src") ?? firstSrcset(attrs.get("srcset"));
        if (src !== undefined && src !== "" && model.images.length < MAX_IMAGES) {
          const signal = [
            attrs.get("class") ?? "",
            attrs.get("id") ?? "",
            attrs.get("role") ?? "",
            attrs.get("aria-label") ?? "",
          ]
            .join(" ")
            .toLowerCase();
          const widthAttr = Number(attrs.get("width") ?? "");
          const hero =
            HERO_HINT.test(signal) ||
            attrs.get("srcset") !== undefined ||
            (Number.isFinite(widthAttr) && widthAttr >= 600);
          model.images.push({
            src,
            alt: attrs.has("alt") ? (attrs.get("alt") ?? "") : null,
            signal,
            inHeader,
            inNav,
            inFooter,
            hero,
            order: imgOrder,
          });
          imgOrder += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return model;
}

/** First candidate URL from a `srcset` value ("a.jpg 1x, b.jpg 2x" → "a.jpg"). Never throws. */
function firstSrcset(srcset: string | undefined): string | undefined {
  if (srcset === undefined) return undefined;
  const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return first === "" ? undefined : first;
}
