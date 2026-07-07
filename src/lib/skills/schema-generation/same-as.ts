/**
 * Person.sameAs aggregation — the hard-rule-2 contract (SKILL.md rule 2, doc 05 M10/M12).
 *
 * ALL provided press/profile URLs are aggregated into a single sameAs array:
 * press articles, bylines, LinkedIn, YouTube, podcast profiles, credential
 * registries (RERA/NAR/CIPS for real estate; NPN/state-license lookups for
 * insurance), plus anything else known.
 *
 * Deduplicated (protocol / "www." / trailing-slash insensitive, first occurrence
 * wins) and order-stable: the output order is the source-category order below,
 * then input order within each category — the same input always produces the
 * same array.
 */

import type { SameAsSources } from "./types";

/** Aggregation order — press first (highest-value entity signal), then profiles. */
export const SAME_AS_SOURCE_ORDER: readonly (keyof SameAsSources)[] = [
  "pressArticles",
  "bylines",
  "linkedin",
  "youtube",
  "podcast",
  "credentialRegistries",
  "other",
];

/**
 * Canonical dedupe key: lowercased host without "www.", path without trailing
 * slash, plus query/fragment. "https://www.forbes.com/profile/x/" and
 * "http://forbes.com/profile/x" collapse to the same key.
 */
export function sameAsDedupeKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim().toLowerCase();
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}${parsed.search}${parsed.hash}`;
}

/**
 * Aggregates every provided press/profile URL into one deduplicated,
 * order-stable sameAs array. The first occurrence's original string is kept.
 */
export function aggregateSameAs(sources?: SameAsSources): string[] {
  if (!sources) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const category of SAME_AS_SOURCE_ORDER) {
    for (const raw of sources[category] ?? []) {
      const url = raw.trim();
      if (url === "") continue;
      const key = sameAsDedupeKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}
