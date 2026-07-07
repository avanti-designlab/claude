/**
 * Text-matching utilities for the compliance engine.
 *
 * Design notes (false-positive avoidance):
 * - Phrases compile with word boundaries — "treats" never matches
 *   "treatsury" or "retreats".
 * - Normalization is strictly 1:1 per character (curly quotes → straight,
 *   en/em dash → hyphen, NBSP → space), so match indices are valid offsets
 *   into the ORIGINAL text and excerpts can be sliced from it verbatim.
 * - All matching is case-insensitive ("CURES CANCER" is still caught).
 */

import type { PatternMatcher } from "./types";

export interface TextSpan {
  start: number;
  end: number;
  excerpt: string;
}

/** 1:1 character normalization — indices into the result map to the original. */
export function normalizeForMatching(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a phrase to a word-bounded, whitespace/hyphen-flexible regex:
 * "risk free" matches "risk free", "risk-free", "risk  free".
 */
function compilePhrase(phrase: string): RegExp {
  const trimmed = phrase.trim();
  const tokens = trimmed.split(/\s+/).map(escapeRegExp);
  const lead = /^[\w]/.test(trimmed) ? "\\b" : "";
  const tail = /[\w]$/.test(trimmed) ? "\\b" : "";
  return new RegExp(`${lead}${tokens.join("[\\s-]+")}${tail}`, "gi");
}

const regexCache = new Map<string, RegExp>();

export function compileMatcher(matcher: PatternMatcher): RegExp {
  const key = "phrase" in matcher ? `p:${matcher.phrase}` : `r:${matcher.regex}`;
  let re = regexCache.get(key);
  if (!re) {
    re = "phrase" in matcher ? compilePhrase(matcher.phrase) : new RegExp(matcher.regex, "gi");
    regexCache.set(key, re);
  }
  return re;
}

/** All matches for all matchers, sorted by position. */
export function findMatches(text: string, matchers: readonly PatternMatcher[]): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const matcher of matchers) {
    const re = compileMatcher(matcher);
    re.lastIndex = 0;
    for (const hit of text.matchAll(re)) {
      const start = hit.index ?? 0;
      spans.push({ start, end: start + hit[0].length, excerpt: hit[0] });
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** True when `other` overlaps `span` expanded by `window` chars on both sides. */
export function withinWindow(span: TextSpan, other: TextSpan, window: number): boolean {
  return other.end > span.start - window && other.start < span.end + window;
}

// ---------------------------------------------------------------------------
// Jurisdiction normalization (US states + DC) — prevents a false block when
// the caller passes "California" but licensedStates holds "CA".
// ---------------------------------------------------------------------------

const US_STATE_CODES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy", "district of columbia": "dc", "washington dc": "dc",
  "washington, d.c.": "dc",
};

/**
 * Normalize a jurisdiction string for comparison: lowercased/trimmed; known
 * US state names collapse to their two-letter code. Unknown values compare
 * as lowercase-trimmed strings (non-US markets still work by exact match).
 */
export function normalizeJurisdiction(value: string): string {
  const lower = value.trim().toLowerCase();
  return US_STATE_CODES[lower] ?? lower;
}
