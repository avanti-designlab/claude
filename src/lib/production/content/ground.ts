/**
 * M8 guardrail passes — anti-fabrication grounding + the compliance pre-screen
 * (doc 05 Part B; the same spammy-fabrication risk M10 gates for schema, applied
 * to prose). Pure — no network, no DB, no LLM, no logging (content must never
 * ride into a log line; the action owns the ONE redacted telemetry line).
 *
 * HONESTY OF SCOPE (stated like the compliance skill's own disclaimer): the
 * grounding pass is a DETERMINISTIC CANDIDATE surfacer, not a truth oracle. It
 * flags concrete factual assertions — statistics and absolute/superlative claims
 * — that are NOT traceable to the provided grounding facts, so the review gates
 * (Content Quality + Compliance + human) see exactly which claims to verify,
 * fix, or cut. It deliberately does NOT try to judge semantic truth (that is the
 * gates' + humans' job). The mirror of M10: M10 rejects schema whose claims the
 * PAGE does not show; M8 flags prose whose claims the INPUT does not support.
 */

import { checkCompliance, type ComplianceResult } from "@/lib/skills/compliance";
import type { Vertical } from "@/lib/types/playbook";
import { toComplianceContentType } from "./constrain";
import type { GeneratableContentType } from "./types";

/* ------------------------------------------------------------------ */
/* Anti-fabrication grounding pass                                     */
/* ------------------------------------------------------------------ */

/** One concrete assertion the body makes that the grounding facts do not support. */
export interface UngroundedClaim {
  /** "statistic" (a number/percentage/currency amount) or "superlative" (an absolute claim). */
  kind: "statistic" | "superlative";
  /** The exact matched text, e.g. "98%", "$1,200", "the best". */
  excerpt: string;
  /** Character offset in the body. */
  index: number;
}

/** Bound the scan + the number of flags so a pathological body can't blow up work. */
const MAX_SCAN_CHARS = 200_000;
const MAX_FLAGS = 50;

/**
 * Absolute / superlative markers. Each is a concrete, checkable claim of
 * standing that needs substantiation; if the same marker does not appear in the
 * grounding facts, the body is asserting a rank/superlative the input never gave
 * it. (Overlaps deliberately with some compliance patterns — belt and braces.)
 */
const SUPERLATIVE_MARKERS: readonly string[] = [
  "best",
  "#1",
  "number one",
  "no. 1",
  "no.1",
  "leading",
  "top-rated",
  "top rated",
  "world-class",
  "world class",
  "unmatched",
  "unrivaled",
  "unrivalled",
  "guaranteed",
  "the only",
  "award-winning",
  "award winning",
  "most trusted",
  "highest-rated",
  "highest rated",
];

/** Digits-only view of a string ("$1,200.00" → "120000", "98%" → "98") for numeric grounding. */
function digitsOf(text: string): string {
  return text.replace(/\D+/g, "");
}

/**
 * Extract statistic candidates: percentages, currency amounts, and "large"
 * numbers (>= 100, or grouped/decimal), which read as factual claims. Small
 * bare counts ("3 tips") are intentionally ignored as noise.
 */
function statisticMatches(body: string): Array<{ excerpt: string; index: number }> {
  const out: Array<{ excerpt: string; index: number }> = [];
  // percentages, currency, and grouped/decimal or >=3-digit numbers.
  const re = /\d[\d,]*(?:\.\d+)?\s?%|\$\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b|\b\d{3,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push({ excerpt: m[0].trim(), index: m.index });
    if (out.length >= MAX_FLAGS) break;
  }
  return out;
}

/**
 * Flag concrete assertions in `body` that the `groundingFacts` do not support.
 * A statistic is grounded when its digit sequence appears in some grounding
 * fact; a superlative is grounded when the same marker phrase appears in some
 * grounding fact. Everything else is a candidate the gates must resolve.
 */
export function findUngroundedClaims(body: string, groundingFacts: string[]): UngroundedClaim[] {
  const text = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  const factsLower = groundingFacts.map((f) => f.toLowerCase());
  const factDigits = groundingFacts.map(digitsOf).filter((d) => d.length > 0);
  const flags: UngroundedClaim[] = [];

  // Statistics.
  for (const stat of statisticMatches(text)) {
    const digits = digitsOf(stat.excerpt);
    if (digits.length === 0) continue;
    const grounded = factDigits.some((fd) => fd.includes(digits));
    if (!grounded) {
      flags.push({ kind: "statistic", excerpt: stat.excerpt, index: stat.index });
      if (flags.length >= MAX_FLAGS) return flags;
    }
  }

  // Superlatives / absolute claims.
  const lower = text.toLowerCase();
  for (const marker of SUPERLATIVE_MARKERS) {
    if (factsLower.some((f) => f.includes(marker))) continue; // substantiated by input
    let from = 0;
    for (;;) {
      const at = lower.indexOf(marker, from);
      if (at === -1) break;
      // word-ish boundary: don't match inside a longer alphanumeric run.
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + marker.length] ?? "";
      const isBoundary = (ch: string) => ch === "" || !/[a-z0-9]/.test(ch);
      if (isBoundary(before) && isBoundary(after)) {
        flags.push({ kind: "superlative", excerpt: text.slice(at, at + marker.length), index: at });
        if (flags.length >= MAX_FLAGS) return flags;
      }
      from = at + marker.length;
    }
  }

  flags.sort((a, b) => a.index - b.index);
  return flags;
}

/* ------------------------------------------------------------------ */
/* Compliance pre-screen (guardrail — NOT the gate)                    */
/* ------------------------------------------------------------------ */

/**
 * Run the deterministic compliance skill over the generated body as a
 * GENERATION-TIME guardrail. This is NOT the `compliance-review` verdict — it is
 * the same pre-screen whose block rules seeded the generation guardrails, run
 * back over the output to catch leakage. An unknown vertical fails closed inside
 * the skill (a block violation), so this never silently passes.
 */
export function screenCompliance(
  vertical: Vertical,
  contentType: GeneratableContentType,
  body: string,
): ComplianceResult {
  return checkCompliance({
    vertical,
    contentType: toComplianceContentType(contentType),
    content: { text: body },
  });
}
