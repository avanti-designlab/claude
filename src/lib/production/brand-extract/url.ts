/**
 * Brand-extract — URL resolution (pure, no network).
 *
 * A page's asset references (`<img src>`, `<link href>`, `og:image`, CSS
 * `url(...)`) are frequently RELATIVE. To hand a later gated fetch/UI layer an
 * addressable asset we resolve them against the page URL — using the WHATWG
 * `URL` constructor (a pure global, NOT the DOM and NOT a fetch). URLs are DATA
 * here: we parse and normalize them, we never dereference them.
 *
 * Only http(s) targets are addressable brand assets, so `javascript:`,
 * `mailto:`, `tel:`, `data:`, `blob:`, `about:` and any other scheme resolve to
 * `null` (honestly dropped, never coerced). A `data:`-URI logo is real content
 * but is not a resolvable URL — it would blow the ingest layer's 2 KB logo-url
 * cap — so it is dropped here and surfaced as "no addressable URL".
 */

const NON_ADDRESSABLE_SCHEME = /^(?:javascript|mailto|tel|data|blob|about|file):/i;

/**
 * Resolve `href` (possibly relative) against `base` (the page URL) to an
 * absolute http(s) URL string. Returns `null` when the input is empty, a
 * non-addressable scheme, or unparseable — the caller treats `null` as "no
 * addressable URL", never as a fabricated one.
 */
export function resolveUrl(href: unknown, base: string | null): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (trimmed === "") return null;
  if (NON_ADDRESSABLE_SCHEME.test(trimmed)) return null;
  let resolved: URL;
  try {
    resolved = base !== null ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  return resolved.toString();
}

/** Parse the page URL to a usable base string, or `null` when it is unusable (relative assets then cannot resolve). */
export function usableBase(pageUrl: unknown): string | null {
  if (typeof pageUrl !== "string" || pageUrl.trim() === "") return null;
  try {
    const u = new URL(pageUrl.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The last path segment of a URL/href, lowercased — the "filename" for logo-ish signal matching. Never throws. */
export function fileNameOf(href: string): string {
  const cut = href.split(/[?#]/)[0];
  const seg = cut.split("/").filter(Boolean).pop() ?? "";
  return seg.toLowerCase();
}
