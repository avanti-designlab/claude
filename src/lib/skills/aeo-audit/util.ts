/**
 * aeo-audit — pure helpers (normalization, text, dates, JSON-LD walking).
 * No I/O, no wall-clock reads — determinism is a hard requirement.
 */

export function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Count + correctly pluralized noun: pluralize(1, "page") → "1 page"; pluralize(3, "page") → "3 pages". */
export function pluralize(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

export function wordCount(s: string): number {
  const trimmed = s.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** First sentence of a text (up to . ! or ?), or the whole text if unpunctuated. */
export function firstSentence(s: string): string {
  const match = /^[\s\S]*?[.!?](?=["')\]]?(\s|$))/.exec(s.trim());
  return (match ? match[0] : s).trim();
}

/** Lowercase + collapse whitespace — for substring matching against visible text. */
export function normalizeWhitespace(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const LEGAL_SUFFIXES = /\b(llc|inc|incorporated|ltd|limited|corp|corporation|co|company|pllc|lp|llp)\b\.?$/;

/** Normalize a business/person name for consistency comparison. */
export function normalizeName(s: string): string {
  let out = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  out = out.replace(LEGAL_SUFFIXES, "").trim();
  return out;
}

/** Normalize a phone number — digits only; compare on the last 10 digits. */
export function normalizePhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  drive: "dr",
  road: "rd",
  lane: "ln",
  court: "ct",
  place: "pl",
  suite: "ste",
  apartment: "apt",
  floor: "fl",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  highway: "hwy",
};

/** Normalize a postal address for consistency comparison. */
export function normalizeAddress(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => ADDRESS_ABBREVIATIONS[token] ?? token)
    .join(" ");
}

/**
 * Normalize a URL for identity matching (orphan detection etc.):
 * resolve relative hrefs against the base, lowercase origin, drop hash +
 * query, strip trailing slash (root stays "/"). Returns null when unparsable.
 */
export function normalizeUrlForIdentity(href: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(href, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return null;
  }
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${url.origin.toLowerCase()}${path}`;
}

/** Pathname of a URL (for robots.txt matching); "/" when unparsable. */
export function pathOf(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).pathname || "/";
  } catch {
    return "/";
  }
}

export function parseIsoMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = parseIsoMs(fromIso);
  const to = parseIsoMs(toIso);
  if (from === null || to === null) return null;
  return (to - from) / 86_400_000;
}

// ---------------------------------------------------------------------------
// JSON-LD walking
// ---------------------------------------------------------------------------

export type JsonLdNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** All nodes carrying an `@type` anywhere in a parsed JSON-LD document. */
export function collectJsonLdNodes(root: unknown): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
    } else if (isPlainObject(current)) {
      if ("@type" in current) nodes.push(current);
      queue.push(...Object.values(current));
    }
  }
  return nodes;
}

/** `@type` values of a node, always as a string array. */
export function nodeTypes(node: JsonLdNode): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((v): v is string => typeof v === "string");
  return [];
}

/** True when the document root (object, or any item of a root array) declares @context. */
export function rootHasContext(root: unknown): boolean {
  if (isPlainObject(root)) return "@context" in root;
  if (Array.isArray(root)) return root.some((item) => isPlainObject(item) && "@context" in item);
  return false;
}

/** Read a string property off a JSON-LD node. */
export function stringProp(node: JsonLdNode, key: string): string | null {
  const v = node[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Compose a comparable address string from a string or PostalAddress node. */
export function jsonLdAddressText(node: JsonLdNode): string | null {
  const v = node["address"];
  if (typeof v === "string" && v.trim() !== "") return v;
  if (isPlainObject(v)) {
    const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode"]
      .map((key) => stringProp(v, key))
      .filter((p): p is string => p !== null);
    if (parts.length > 0) return parts.join(" ");
  }
  return null;
}
