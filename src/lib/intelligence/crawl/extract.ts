/**
 * M2 crawl layer — HTML extraction (doc 05 M2).
 *
 * One bounded, forward-only pass over server HTML → the signals the aeo-audit
 * skill's `CrawledPage` reads (title, meta description, H1s, visible text,
 * JSON-LD blocks, images, links, video/transcript markers). The crawler maps
 * `ExtractedDoc` + response headers onto the skill's page shape.
 *
 * HOSTILE-INPUT DISCIPLINE (client sites are untrusted input):
 *  - no regex ever runs across the whole document — scanning is index-based
 *    (`indexOf`) and every loop iteration advances the cursor, so pathological
 *    markup (unclosed quotes/tags/comments, `<<<<<` floods, attribute bombs)
 *    terminates in linear time instead of hanging the audit;
 *  - everything collected is CAPPED (counts and lengths below) so a hostile
 *    page cannot balloon memory through the extraction into the stored audit;
 *  - the extractor never throws on any input — a garbage page extracts to an
 *    (honestly) empty document, and the rubric scores what is actually there.
 *
 * Fidelity boundaries (documented, not hidden): this parses SERVER HTML only —
 * no JS execution, no CSS visibility. `Extraction is what an AI crawler that
 * does not run JS would see`, which is exactly the surface the rubric audits.
 */

/* ------------------------------------------------------------------ */
/* Caps (single source of truth — tests import these)                  */
/* ------------------------------------------------------------------ */

export const MAX_HREFS = 2_000;
export const MAX_IMAGES = 1_000;
export const MAX_H1S = 50;
export const MAX_JSONLD_BLOCKS = 100;
export const MAX_JSONLD_BLOCK_CHARS = 100_000;
export const MAX_VISIBLE_TEXT_CHARS = 250_000;
export const MAX_TITLE_CHARS = 1_000;
/** Cap on any stored attribute value (href/src/content/…). */
export const MAX_ATTR_CHARS = 2_000;
/** Attributes examined per tag before skipping to the tag's end. */
const MAX_ATTRS_PER_TAG = 100;

/* ------------------------------------------------------------------ */
/* Output shape                                                        */
/* ------------------------------------------------------------------ */

export interface ExtractedImage {
  src: string;
  /** null = no alt attribute; "" = empty alt (decorative — counts as covered). */
  alt: string | null;
}

export interface ExtractedDoc {
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  /** Text outside script/style/noscript/template/title, entity-decoded, whitespace-collapsed. */
  visibleText: string;
  /** Raw contents of each `script[type*="ld+json"]` block, document order. */
  jsonLdBlocks: string[];
  images: ExtractedImage[];
  /** Raw `a[href]` values, document order, deduplicated — NOT resolved or origin-filtered (the crawler owns that). */
  hrefs: string[];
  /** `<video>`, or an iframe/embed pointing at a known video host. */
  hasVideo: boolean;
  /**
   * Transcript MARKER heuristic (documented, deliberately narrow): an element
   * whose id/class contains "transcript", or a heading whose text does. A
   * page merely mentioning the word in prose does NOT count — a false "has
   * transcript" would hand out unearned rubric credit.
   */
  hasTranscriptMarker: boolean;
  /** True when any executable script tag is present (feeds the JS-render heuristic). */
  hasScripts: boolean;
  /** Newest parseable `dateModified` across JSON-LD blocks (original string), or null. */
  jsonLdDateModified: string | null;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
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
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Raw-text elements: content is skipped as a block, never tokenized as tags. */
const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "textarea", "title"]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const VIDEO_HOST_HINT = /youtube\.com|youtu\.be|vimeo\.com|wistia\.(?:com|net)|loom\.com/i;

function isTagNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-";
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

interface ParsedTag {
  name: string;
  /** Lowercased attr name → value ("" for valueless attrs — `<img alt>` is empty alt, absent is null). */
  attrs: Map<string, string>;
  /** Index just past the tag's closing ">" (or the recovery point on malformed markup). */
  end: number;
}

/**
 * Parse one opening tag starting at `lt` (which must point at "<"). Returns
 * null when what follows is not a tag (stray "<") — the caller emits the "<"
 * as text and advances one char, guaranteeing progress on "<<<<<" floods.
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
    // Skip whitespace and the self-closing "/".
    while (i < n && (isWhitespace(html[i]) || html[i] === "/")) i += 1;
    if (i >= n) break;
    const ch = html[i];
    if (ch === ">") {
      i += 1;
      return { name, attrs, end: i };
    }
    if (ch === "<") {
      // Malformed markup ("<a<a"): end this tag here; the next pass re-scans from "<".
      return { name, attrs, end: i };
    }
    if (attrCount >= MAX_ATTRS_PER_TAG) {
      // Attribute bomb: stop examining, skip straight to the tag's end.
      const gt = html.indexOf(">", i);
      return { name, attrs, end: gt === -1 ? n : gt + 1 };
    }
    // Attribute name.
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
        // Unclosed quote: the value runs to end of input — bounded, no hang.
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

/** Walk parsed JSON collecting `dateModified` strings; return the newest parseable one. */
function newestDateModified(blocks: string[]): string | null {
  let best: { iso: string; ms: number } | null = null;
  for (const raw of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // invalid JSON-LD is check 1's finding, not a crawl concern
    }
    const queue: unknown[] = [parsed];
    // Bounded walk: JSON.parse output is acyclic; node count is bounded by block size.
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
      } else if (typeof node === "object" && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === "dateModified" && typeof value === "string") {
            const ms = Date.parse(value);
            if (!Number.isNaN(ms) && (best === null || ms > best.ms)) best = { iso: value, ms };
          } else {
            queue.push(value);
          }
        }
      }
    }
  }
  return best?.iso ?? null;
}

/* ------------------------------------------------------------------ */
/* The extractor                                                       */
/* ------------------------------------------------------------------ */

export function extractDoc(html: string): ExtractedDoc {
  const n = html.length;
  const htmlLower = html.toLowerCase();

  let title: string | null = null;
  let metaDescription: string | null = null;
  const h1s: string[] = [];
  const jsonLdBlocks: string[] = [];
  const images: ExtractedImage[] = [];
  const hrefs: string[] = [];
  const hrefSeen = new Set<string>();
  let hasVideo = false;
  let hasTranscriptMarker = false;
  let hasScripts = false;

  const textParts: string[] = [];
  let visibleChars = 0;
  /** Open heading being collected ("h1" | … | "h6"), with its text buffer. */
  let heading: { tag: string; parts: string[] } | null = null;

  const pushText = (raw: string): void => {
    const decoded = collapseWhitespace(decodeEntities(raw));
    if (decoded === "") return;
    if (heading !== null) heading.parts.push(decoded);
    if (visibleChars < MAX_VISIBLE_TEXT_CHARS) {
      const room = MAX_VISIBLE_TEXT_CHARS - visibleChars;
      const clipped = decoded.length > room ? decoded.slice(0, room) : decoded;
      textParts.push(clipped);
      visibleChars += clipped.length;
    }
  };

  const closeHeading = (): void => {
    if (heading === null) return;
    const text = collapseWhitespace(heading.parts.join(" "));
    if (heading.tag === "h1" && h1s.length < MAX_H1S) h1s.push(text);
    if (text.toLowerCase().includes("transcript")) hasTranscriptMarker = true;
    heading = null;
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // Comments and declarations — skipped whole; unclosed ones run to end.
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
    // Closing tag.
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt + 2);
      let nameEnd = lt + 2;
      while (nameEnd < n && isTagNameChar(html[nameEnd])) nameEnd += 1;
      const name = html.slice(lt + 2, nameEnd).toLowerCase();
      if (HEADING_TAGS.has(name)) closeHeading();
      i = end === -1 ? n : end + 1;
      continue;
    }

    const tag = parseTag(html, lt);
    if (tag === null) {
      // Stray "<": text, advance one — guaranteed progress.
      pushText("<");
      i = lt + 1;
      continue;
    }
    i = tag.end;

    // id/class transcript marker (any element).
    const idClass = `${tag.attrs.get("id") ?? ""} ${tag.attrs.get("class") ?? ""}`.toLowerCase();
    if (idClass.includes("transcript")) hasTranscriptMarker = true;

    if (RAW_TEXT_TAGS.has(tag.name)) {
      // Raw-text element: take the inner block verbatim to the matching close
      // tag (case-insensitive), or to end of input when unclosed — never
      // tokenized, never hangs.
      const close = htmlLower.indexOf(`</${tag.name}`, tag.end);
      const inner = html.slice(tag.end, close === -1 ? n : close);
      if (close === -1) {
        i = n;
      } else {
        const closeGt = html.indexOf(">", close);
        i = closeGt === -1 ? n : closeGt + 1;
      }
      if (tag.name === "title") {
        if (title === null) {
          const text = collapseWhitespace(decodeEntities(inner)).slice(0, MAX_TITLE_CHARS);
          title = text === "" ? null : text;
        }
      } else if (tag.name === "script") {
        const type = (tag.attrs.get("type") ?? "").toLowerCase();
        if (type.includes("ld+json")) {
          if (jsonLdBlocks.length < MAX_JSONLD_BLOCKS) {
            jsonLdBlocks.push(inner.trim().slice(0, MAX_JSONLD_BLOCK_CHARS));
          }
        } else if (type === "" || type.includes("javascript") || type.includes("module")) {
          // Executable script (data blocks like application/json are not JS).
          hasScripts = true;
        }
      }
      continue;
    }

    switch (tag.name) {
      case "meta": {
        const metaName = (tag.attrs.get("name") ?? tag.attrs.get("property") ?? "").toLowerCase();
        if (metaName === "description" && metaDescription === null) {
          metaDescription = tag.attrs.get("content") ?? null;
        }
        break;
      }
      case "a": {
        const href = tag.attrs.get("href");
        if (href !== undefined && href !== "" && hrefs.length < MAX_HREFS && !hrefSeen.has(href)) {
          hrefSeen.add(href);
          hrefs.push(href);
        }
        break;
      }
      case "img": {
        const src = tag.attrs.get("src");
        if (src !== undefined && src !== "" && images.length < MAX_IMAGES) {
          images.push({ src, alt: tag.attrs.has("alt") ? (tag.attrs.get("alt") ?? "") : null });
        }
        break;
      }
      case "video":
        hasVideo = true;
        break;
      case "iframe":
      case "embed": {
        const src = tag.attrs.get("src") ?? "";
        if (VIDEO_HOST_HINT.test(src)) hasVideo = true;
        break;
      }
      default:
        if (HEADING_TAGS.has(tag.name)) {
          // A new heading while one is open closes the open one (malformed nesting).
          closeHeading();
          heading = { tag: tag.name, parts: [] };
        }
        break;
    }
  }
  closeHeading(); // flush an unclosed trailing heading — its text exists

  return {
    title,
    metaDescription,
    h1s,
    visibleText: textParts.join(" "),
    jsonLdBlocks,
    images,
    hrefs,
    hasVideo,
    hasTranscriptMarker,
    hasScripts,
    jsonLdDateModified: newestDateModified(jsonLdBlocks),
  };
}
