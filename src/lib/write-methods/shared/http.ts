/**
 * Injected HTTP port for write-method adapters (doc 04 §1).
 *
 * Adapters NEVER call global `fetch` directly — they receive a {@link FetchPort}
 * at construction, so every adapter test runs with zero live network (the same
 * injection discipline as the change-management layer's Clock/Store ports).
 * Production wiring passes the platform's `fetch` itself: the global function
 * satisfies this port structurally, so there is no wrapper to maintain.
 *
 * Deliberately narrow: exactly what a REST write method needs (method, headers,
 * string body in; status, headers, text out) — nothing that would tempt an
 * adapter into streaming or other per-vendor cleverness that the fakes
 * couldn't faithfully reproduce. The one transport policy the port DOES carry
 * is pinned, not configurable: `redirect: "error"` (see {@link FetchPortInit}).
 */

/** The request shape an adapter is allowed to send. */
export interface FetchPortInit {
  /** PATCH exists for partial-update APIs (Webflow/Wix-style); nothing wider. */
  method: "GET" | "POST" | "PATCH";
  headers: Record<string, string>;
  body?: string;
  /**
   * Redirect policy — REQUIRED, and the only legal value is `"error"`: the
   * port must NOT follow redirects; a redirect response makes the call
   * REJECT (WHATWG `redirect: "error"` semantics, which global `fetch`
   * implements natively). Write methods state this on every request because
   * a client-site write must land at exactly the URL it was sent to, and a
   * transparently-followed redirect could re-send the Authorization header
   * wherever the site points. (undici happens to strip Authorization on
   * cross-origin redirects, but this port refuses to DEPEND on that
   * implementation detail.) Adapters surface the resulting rejection as
   * their typed `network_failure` — an honest "the site did not answer at
   * the URL we wrote to", never a silently-followed hop.
   */
  redirect: "error";
}

/** The response surface an adapter is allowed to read (a subset of WHATWG Response). */
export interface FetchPortResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The injected HTTP function. Global `fetch` is a valid FetchPort. */
export type FetchPort = (
  url: string,
  init: FetchPortInit,
) => Promise<FetchPortResponse>;

/**
 * Build an HTTP Basic Authorization header value from a resolved credential
 * (e.g. a WordPress Application Password's `user:app-password` pair). Call
 * sites pass `credential.reveal()` straight in — the revealed string exists
 * only for this expression and lands only in the request header.
 */
export function basicAuthHeader(credential: string): string {
  return `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
}

/**
 * Build an HTTP Bearer Authorization header value from a resolved credential
 * (e.g. a Webflow API token). Same containment rule as {@link basicAuthHeader}:
 * call sites pass `credential.reveal()` straight in — the revealed string
 * exists only for this expression and lands only in the request header.
 */
export function bearerAuthHeader(credential: string): string {
  return `Bearer ${credential}`;
}

/** Result of an honesty-first JSON parse — no throw, no partial value. */
export type ParsedJson =
  | { ok: true; value: unknown }
  | { ok: false };

/**
 * Parse a response body as JSON without trusting it. Vendors "return JSON"
 * right up until they return a login page — the caller must branch on `ok`
 * and produce a typed `unexpected_response`, never a raw SyntaxError.
 */
export function tryParseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Does a non-JSON body look like an HTML page? Used to name the classic
 * failure honestly: a site redirecting REST calls to wp-login (or a security
 * plugin interstitial) answers 200 + HTML where JSON was promised.
 */
export function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(text);
}
