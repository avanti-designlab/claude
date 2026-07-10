/**
 * Client-side website-URL normalization + the persistability mirror — shared by
 * onboarding step 3 AND the workspace Properties panel so the two never fork
 * semantics (combined-remediation A1/B, 2026-07-10).
 *
 * The server seams (`validateWebsiteInput` / `validatePropertyCreateInput`)
 * accept only an absolute http(s) URL via `sanitizePropertyUrl`. The UI's
 * "this saves" promise must match that exactly, so:
 *
 *  - `normalizeWebsiteUrl` upgrades scheme-less input ("mysite.com") to
 *    "https://mysite.com" — IDEMPOTENT, so the value shown in the input (it
 *    normalizes on blur) and the value sent in the payload are byte-identical
 *    no matter how many times each side normalizes.
 *  - `websiteUrlProblem` runs the SAME `sanitizePropertyUrl` the server runs
 *    (imported, not re-implemented — a drift here would re-open the gate/save
 *    mismatch both reviewers rejected) and returns the interface-voice
 *    explanation when the address still can't be saved, else null.
 *
 * Pure module: no React, no server imports — unit-tested in the default
 * `npm test` run (website-url.test.ts).
 */

import { sanitizePropertyUrl } from "@/lib/properties/validate";

/** RFC 3986 scheme shape — "https:", "http:", but also "javascript:" etc. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Trim, and prefix scheme-less input with https:// (stripping any leading
 * slashes first so "//mysite.com" doesn't double up). Input that already
 * carries a scheme is returned as typed — `websiteUrlProblem` then decides
 * whether it's persistable. Idempotent by construction.
 */
export function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (HAS_SCHEME.test(trimmed)) return trimmed;
  const bare = trimmed.replace(/^\/+/, "");
  if (bare === "") return trimmed;
  return `https://${bare}`;
}

/**
 * Interface-voice explanation when a (normalized) address can't be saved
 * (doc 06 §6 — what happened + what to do; same voice as the workspace seam's
 * URL refusal). Normalization already supplies the https:// prefix, so by the
 * time this shows the address itself doesn't parse as a web address.
 */
export const WEBSITE_URL_PROBLEM =
  "This address can’t be saved as written — check it for typos or stray spaces (a full address looks like https://yoursite.com).";

/**
 * The client-side mirror of the server's persistability check: null when
 * `sanitizePropertyUrl` (the exact function the write seams run) accepts the
 * value, else the interface-voice problem. Callers pass the NORMALIZED value
 * and decide when to display (e.g. not on an empty field).
 */
export function websiteUrlProblem(url: string): string | null {
  return sanitizePropertyUrl(url) === null ? WEBSITE_URL_PROBLEM : null;
}
