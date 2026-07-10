/**
 * SVG sanitizer -- security-critical PURE module (Orchestrator ruling,
 * condition 6a). SVG is XML that a browser will execute if served into an
 * executing context; a client-supplied logo is untrusted input. This module is
 * the ingest gate: every SVG that reaches storage passes through here first
 * (the upload flow routes SVG bytes through a server action body, never a direct
 * signed PUT -- see actions.ts), and the SIZE CAP is enforced before we parse.
 *
 * POSTURE: allowlist + REFUSE-DOMINANT (throw-not-serve-dangerous). We do not
 * attempt to "clean" a hostile document and serve the remainder -- a document is
 * emitted ONLY when it conforms, end-to-end, to a strict element allowlist and
 * the attribute/URL/CSS rules below. Anything we cannot prove safe is REFUSED
 * with an honest reason (a brand logo should be a clean export; asking for one
 * is the right product behavior, and it means we never emit bytes we could not
 * fully vet). This closes every known SVG script-execution vector:
 *   - <script>, <foreignObject>, <iframe>/<embed>/<object>, SMIL animation
 *     (<animate>/<set>/<animateMotion>/...), <feImage> -- the element allowlist
 *     rejects them outright;
 *   - on* event-handler attributes -- ANY attribute whose name starts with "on"
 *     is rejected (the entire event-handler class);
 *   - javascript:/vbscript:/data:/external href|xlink:href -- URL-bearing
 *     attributes must be same-document ("#id");
 *   - style="expression(...)" / @import / external url() / -moz-binding -- the
 *     style attribute AND <style> element bodies are scanned;
 *   - DOCTYPE/ENTITY/CDATA/processing-instructions/external entities (XXE,
 *     billion-laughs) -- rejected structurally;
 *   - case + character-reference smuggling ("&#106;avascript:", "<SCRIPT",
 *     mixed case) -- matching is case-insensitive and URL/CSS values are decoded
 *     before inspection;
 *   - encoding tricks -- NUL/other C0 controls and non-UTF-8 encoding
 *     declarations are rejected (our byte-level scan assumes UTF-8/ASCII).
 *
 * ZERO dependencies (no DOM/jsdom): a bounded tokenizer over the source, sized
 * to the F1 "small pure validator, unit-tested in the default run" pattern
 * (src/lib/clients/validate.ts). Adversarial coverage: svg-sanitize.test.ts.
 *
 * The serve-side contract is DEFENSE IN DEPTH, not a substitute: the UI slice
 * MUST render brand-asset SVGs only via non-executing contexts (<img src>, CSS
 * background-image) from signed URLs -- never inline/inject the markup, never
 * dangerouslySetInnerHTML. Inline-SVG recolor is NOT authorized (ruling 6b).
 */

/** Why an SVG was refused -- interface/telemetry-safe (no attacker payload echoed). */
export type SvgRefusalReason =
  | "empty"
  | "too_large" // caller must enforce the byte cap; this is the parser's own guard
  | "not_svg" // no <svg> root element found
  | "control_chars" // NUL / C0 controls -- encoding smuggling surface
  | "bad_encoding" // XML encoding declaration is not UTF-8/ASCII
  | "doctype" // DOCTYPE / ENTITY / DTD internal subset (XXE / billion-laughs)
  | "cdata" // CDATA section -- a parser-confusion hiding place
  | "processing_instruction" // a processing instruction other than a leading xml prolog
  | "malformed" // a "<" that starts no well-formed construct (e.g. "< script")
  | "disallowed_element" // element not in the allowlist (script/foreignObject/...)
  | "event_handler" // an on* attribute
  | "external_reference" // href/xlink:href/src to a non-same-document target
  | "dangerous_css" // expression()/@import/external url()/binding in style
  | "dangerous_attribute"; // a known-scriptable attribute value

export type SvgSanitizeResult =
  | { ok: true; svg: string }
  | { ok: false; reason: SvgRefusalReason };

/** The parser's own hard ceiling (chars). The action enforces the real product
 *  cap (BRAND_ASSET_MAX_BYTES) BEFORE calling; this guards the pure module
 *  against being handed something unbounded by a test/other caller. */
export const SVG_SANITIZE_MAX_CHARS = 5_000_000;

/**
 * Elements permitted in a brand-asset SVG. Presentation + structure only; every
 * scripting/animation/foreign-content element is deliberately ABSENT and thus
 * refused. Namespaced element names (containing ":") are never in this set, so
 * they are refused too (we do not resolve namespace prefixes).
 */
const ALLOWED_ELEMENTS = new Set<string>([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "style",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "tref",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "marker",
  "filter",
  "fegaussianblur",
  "fecolormatrix",
  "feoffset",
  "feblend",
  "femerge",
  "femergenode",
  "feflood",
  "fecomposite",
  "femorphology",
  "fedropshadow",
  "fetile",
  "image",
  "switch",
  "a",
  "view",
]);

/** Attribute names that carry a URL. Their value must be same-document only. */
const URL_ATTRS = new Set<string>(["href", "xlink:href", "src"]);

/** The 5 predefined XML entities -- the only named refs we decode. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const SPACE = 0x20;

/** A C0 control that is NOT tab(09)/LF(0A)/CR(0D) -- an encoding-smuggling surface. */
function isForbiddenControl(code: number): boolean {
  return code < SPACE && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

function hasForbiddenControls(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (isForbiddenControl(s.charCodeAt(i))) return true;
  }
  return false;
}

/** Drop every char <= space (all whitespace + C0 controls). Defeats mid-token
 *  splitting like "java\tscript:". */
function stripWsAndControls(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > SPACE) out += s[i];
  }
  return out;
}

function refuse(reason: SvgRefusalReason): { ok: false; reason: SvgRefusalReason } {
  return { ok: false, reason };
}

/** Decode numeric (&#dd; / &#xhh;) and the 5 named char refs, for INSPECTION of
 *  URL/CSS values. Unknown named refs are left literal (never expanded -- there
 *  is no custom-entity expansion path). Bounded by input length. */
function decodeRefs(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith("#x")) {
      const code = Number.parseInt(b.slice(2), 16);
      return codeOk(code) ? safeFromCodePoint(code) : whole;
    }
    if (b.startsWith("#")) {
      const code = Number.parseInt(b.slice(1), 10);
      return codeOk(code) ? safeFromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, b)
      ? NAMED_ENTITIES[b]
      : whole;
  });
}

function codeOk(code: number): boolean {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff;
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Normalize a value for scheme/CSS inspection: decode refs, strip
 *  whitespace/control chars, lowercase. */
function normalizeForScan(value: string): string {
  return stripWsAndControls(decodeRefs(value)).toLowerCase();
}

/** True if a URL value points OUTSIDE the document. We allow ONLY a same-
 *  document fragment ("#id"); everything else -- absolute, protocol-relative,
 *  scheme (javascript:/data:/http:/...), or a bare relative path -- is refused
 *  for a brand asset (a logo has no reason to fetch). */
function isExternalUrl(rawValue: string): boolean {
  const value = normalizeForScan(rawValue);
  if (value === "") return false; // empty href -- inert
  if (value.startsWith("#")) return false; // same-document reference -- allowed
  return true; // scheme, //, or bare relative path -- all external for our purpose
}

// Strip CSS comments so an inline comment cannot split a dangerous token
// (a comment between "expr" and "ession(", or inside "@import"). CSS comments do
// not nest; a non-greedy strip matches browser parsing, and an UNTERMINATED
// comment-open runs to EOF (its trailing content is inert), so we drop that tail
// too. Run AFTER ref-decoding so a comment smuggled via char refs is removed.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\*[\s\S]*$/, "");
}

/** CSS (style attribute value or <style> body) that could execute or fetch. */
function hasDangerousCss(rawCss: string): boolean {
  const css = stripCssComments(normalizeForScan(rawCss));
  if (css.includes("expression(")) return true;
  if (css.includes("@import")) return true;
  if (css.includes("-moz-binding")) return true;
  if (css.includes("javascript:")) return true;
  if (css.includes("vbscript:")) return true;
  if (css.includes("behavior:")) return true;
  // url(...) is safe only when empty or a same-document fragment (#...); any
  // url() pointing at a scheme/host/path is a fetch and is refused.
  const urls = css.match(/url\(([^)]*)\)/g);
  if (urls) {
    for (const u of urls) {
      const inner = u.slice(4, -1).replace(/['"]/g, "");
      if (inner !== "" && !inner.startsWith("#")) return true;
    }
  }
  return false;
}

/**
 * Sanitize (validate-and-return) an SVG string. Returns the source (minus a
 * stripped leading xml prolog and XML comments) when it fully conforms, or a
 * typed refusal. NEVER returns dangerous bytes.
 */
export function sanitizeSvg(input: unknown): SvgSanitizeResult {
  if (typeof input !== "string") return refuse("empty");
  if (input.length === 0) return refuse("empty");
  if (input.length > SVG_SANITIZE_MAX_CHARS) return refuse("too_large");

  // Encoding-smuggling guard: reject NUL and other C0 controls (tab/LF/CR ok).
  // A UTF-16 payload shows up as embedded NULs here -- refused before parsing.
  if (hasForbiddenControls(input)) return refuse("control_chars");

  // XML encoding declaration must be UTF-8/ASCII (our scan is byte-level).
  const encDecl = input.match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
  if (encDecl) {
    const enc = encDecl[1].toLowerCase();
    if (enc !== "utf-8" && enc !== "utf8" && enc !== "us-ascii" && enc !== "ascii") {
      return refuse("bad_encoding");
    }
  }

  // Strip a leading BOM (U+FEFF), then well-formed XML comments (a hiding
  // place). Any "<!--"/"-->" remaining after the strip is unbalanced => refuse.
  let src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (src.includes("<!--") || src.includes("-->")) {
    src = src.replace(/<!--[\s\S]*?-->/g, "");
    if (src.includes("<!--") || src.includes("-->")) return refuse("malformed");
  }

  // Strip a single leading <?xml ... ?> prolog (safe). Any OTHER "<?" is a
  // processing instruction, and any "<!" is a declaration (DOCTYPE/ENTITY/...).
  src = src.replace(/^\s*<\?xml[^>]*\?>/i, "");

  if (/<!\s*doctype/i.test(src) || /<!\s*entity/i.test(src)) return refuse("doctype");
  if (/<!\[cdata\[/i.test(src)) return refuse("cdata");
  if (/<!/.test(src)) return refuse("doctype"); // any other declaration
  if (/<\?/.test(src)) return refuse("processing_instruction");

  return tokenizeAndValidate(src);
}

/** Walk every tag; enforce the element allowlist + attribute rules; scan the
 *  bodies of <style> elements. Text nodes cannot execute, so they are not
 *  inspected (only structural "<" validity is). */
function tokenizeAndValidate(src: string): SvgSanitizeResult {
  let sawSvgRoot = false;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break; // rest is text -- inert
    const next = src[lt + 1];

    // "<" must start a recognizable construct: name char or "/". Anything else
    // (whitespace, "<", digit, etc.) is not a valid tag start -- fail closed
    // (blocks "< script" and stray "<").
    if (next === undefined || !/[a-zA-Z/]/.test(next)) return refuse("malformed");

    const gt = findTagEnd(src, lt);
    if (gt === -1) return refuse("malformed"); // unterminated tag

    const rawTag = src.slice(lt + 1, gt); // between "<" and ">"
    i = gt + 1;

    // Closing tag: name only.
    if (rawTag.startsWith("/")) {
      const name = rawTag.slice(1).trim().toLowerCase();
      if (name === "" || !isName(name)) return refuse("malformed");
      if (!ALLOWED_ELEMENTS.has(name)) return refuse("disallowed_element");
      continue;
    }

    // Opening (or self-closing) tag.
    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const parsed = parseTag(body);
    if (!parsed.ok) return parsed;
    if (parsed.name === "svg") sawSvgRoot = true;

    // <style> body: scan the CSS up to </style> (case-insensitive), then skip
    // the CSS text so it is never mis-tokenized (CSS is not markup).
    if (parsed.name === "style" && !selfClosing) {
      const close = indexOfClose(src, "style", i);
      const cssEnd = close === -1 ? n : close;
      const css = src.slice(i, cssEnd);
      if (hasDangerousCss(css)) return refuse("dangerous_css");
      i = cssEnd; // the walker meets </style> next and accepts it.
    }
  }

  if (!sawSvgRoot) return refuse("not_svg");
  return { ok: true, svg: src };
}

/** Case-insensitive index of the closing tag "</name" at/after `from`. */
function indexOfClose(src: string, name: string, from: number): number {
  const re = new RegExp("</\\s*" + name + "\\b", "i");
  const rest = src.slice(from);
  const m = rest.match(re);
  return m && m.index !== undefined ? from + m.index : -1;
}

/** Find the ">" that ends the tag opened at `lt`, respecting quoted attribute
 *  values (a ">" inside quotes is not the terminator). */
function findTagEnd(src: string, lt: number): number {
  let quote: string | null = null;
  for (let j = lt + 1; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    } else if (c === "<") {
      return -1; // a "<" before the tag closed => malformed
    }
  }
  return -1;
}

function isName(name: string): boolean {
  return /^[a-z][a-z0-9]*$/i.test(name);
}

type ParseTagResult =
  | { ok: true; name: string }
  | { ok: false; reason: SvgRefusalReason };

/** Parse an opening-tag body ("name attr=... attr=...") and validate the element
 *  + every attribute. */
function parseTag(bodyRaw: string): ParseTagResult {
  const body = bodyRaw.trim();
  const nameMatch = body.match(/^([a-zA-Z][a-zA-Z0-9:_-]*)/);
  if (!nameMatch) return refuse("malformed");
  const rawName = nameMatch[0];
  const name = rawName.toLowerCase();

  // Namespaced element (prefix:local) is not in the allowlist => refuse.
  if (!ALLOWED_ELEMENTS.has(name)) return refuse("disallowed_element");

  const attrs = extractAttributes(body.slice(rawName.length));

  for (const { rawName: aRawName, value } of attrs) {
    const aName = aRawName.toLowerCase();

    // Event handlers -- the entire on* class.
    if (aName.startsWith("on")) return refuse("event_handler");

    // URL-bearing attributes must be same-document only.
    if (URL_ATTRS.has(aName) || aName.endsWith(":href")) {
      if (isExternalUrl(value)) return refuse("external_reference");
      continue;
    }

    // style="" -- CSS scan.
    if (aName === "style") {
      if (hasDangerousCss(value)) return refuse("dangerous_css");
      continue;
    }

    // Defensive catch-all: any other attribute value that, once decoded,
    // smuggles a scripting scheme is refused.
    const decoded = normalizeForScan(value);
    if (
      decoded.includes("javascript:") ||
      decoded.includes("vbscript:") ||
      decoded.includes("data:text/html")
    ) {
      return refuse("dangerous_attribute");
    }
  }

  return { ok: true, name };
}

/** Extract raw attribute name/value pairs from a tag body. Tolerant of the
 *  usual SVG spacing; values may be single- or double-quoted or unquoted. */
function extractAttributes(s: string): Array<{ rawName: string; value: string }> {
  const out: Array<{ rawName: string; value: string }> = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].trim() === "") {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    out.push({ rawName: m[1], value });
  }
  return out;
}

/**
 * Convenience wrapper for callers that prefer the throw-not-serve idiom. Throws
 * `SvgUnsafeError` on any refusal; returns the safe SVG string otherwise.
 */
export class SvgUnsafeError extends Error {
  constructor(readonly reason: SvgRefusalReason) {
    super("SVG refused (unsafe or unsanitizable): " + reason);
    this.name = "SvgUnsafeError";
  }
}

export function sanitizeSvgOrThrow(input: unknown): string {
  const res = sanitizeSvg(input);
  if (!res.ok) throw new SvgUnsafeError(res.reason);
  return res.svg;
}
