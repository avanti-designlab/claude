/**
 * M8 guardrail passes — anti-fabrication grounding + voice.dont screen + the
 * compliance pre-screen + the AEO-formatting check (doc 05 Part B; the same
 * spammy-fabrication risk M10 gates for schema, applied to prose). Pure — no
 * network, no DB, no LLM, no logging (content must never ride into a log line;
 * the action owns the ONE redacted telemetry line).
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
import { evaluateFaqAnswer } from "@/lib/skills/aeo-audit";
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
/** Bound the fact-number set so a pathological grounding fact can't blow up work. */
const MAX_FACT_NUMBERS = 5_000;

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

/** Word-ish boundary: a string edge ("") or a non-alphanumeric char. */
function isBoundaryChar(ch: string): boolean {
  return ch === "" || !/[a-z0-9]/.test(ch);
}

/**
 * Canonicalize a numeric string to a value key: strip thousands separators, drop
 * insignificant leading/trailing zeros, so "1,200" / "1200.00" / "01200" all key
 * to "1200" and "3.50" keys to "3.5". Returns null for a non-numeric input.
 *
 * The fix that closes R1: applied IDENTICALLY to claimed numbers and to fact
 * numbers, equality is separator/format-insensitive but VALUE-EXACT. "98" can
 * never equal "1980" or "980" (the old digit-SUBSTRING test grounded "98%" on a
 * fact containing "1980" — "98" ⊂ "1980"). No parseFloat: strings are compared
 * so large ints and precise decimals never collide through float rounding.
 */
function canonicalNumber(raw: string): string | null {
  const cleaned = raw.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const dot = cleaned.indexOf(".");
  let intPart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  let fracPart = dot === -1 ? "" : cleaned.slice(dot + 1);
  intPart = intPart.replace(/^0+(?=\d)/, ""); // drop leading zeros, keep the last digit
  fracPart = fracPart.replace(/0+$/, ""); // drop trailing fraction zeros
  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

/** A numeric token inside free text: digits with optional thousands commas + decimal. */
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * The set of distinct numeric VALUES that appear in `texts` as bounded numeric
 * tokens, canonicalized. This is the ground-truth a claimed statistic must match
 * EXACTLY (by value) to be considered grounded — substring containment is
 * deliberately NOT used, so "98" is never grounded by "1980" and "20" is never
 * grounded by "2024". Bounded in scan length + token count.
 */
function numericTokenSet(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of texts) {
    const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
    let count = 0;
    for (const m of text.matchAll(NUMBER_TOKEN)) {
      const canon = canonicalNumber(m[0]);
      if (canon !== null) out.add(canon);
      if (++count >= MAX_FACT_NUMBERS) break;
    }
  }
  return out;
}

/** The canonical numeric value a statistic excerpt asserts (its first numeric token). */
function claimedNumber(excerpt: string): string | null {
  const m = excerpt.match(/\d[\d,]*(?:\.\d+)?/);
  return m ? canonicalNumber(m[0]) : null;
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
 * A statistic is grounded ONLY when its canonical numeric value equals a distinct
 * numeric token that actually appears in some grounding fact (token-boundary /
 * value-exact — NOT digit-substring); a superlative is grounded when the same
 * marker phrase appears in some grounding fact. Everything else is a candidate
 * the gates must resolve. Conservative in the correct direction: it errs toward
 * FLAGGING, never toward silently grounding.
 *
 * REUSED BY M9 drift (authenticity/drift.ts) with the ORIGINAL body as the single
 * grounding fact, so the value-exact fix protects meaning-drift too: an
 * introduced "20%" is no longer silently grounded by a "2024" in the original.
 */
export function findUngroundedClaims(body: string, groundingFacts: string[]): UngroundedClaim[] {
  const text = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  const factsLower = groundingFacts.map((f) => f.toLowerCase());
  const factNumbers = numericTokenSet(groundingFacts);
  const flags: UngroundedClaim[] = [];

  // Statistics — grounded only by VALUE-EXACT numeric-token equality.
  for (const stat of statisticMatches(text)) {
    const claimed = claimedNumber(stat.excerpt);
    if (claimed === null) continue;
    if (!factNumbers.has(claimed)) {
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
      if (isBoundaryChar(before) && isBoundaryChar(after)) {
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
/* Voice.dont screen on M8's OWN output (guardrail — NOT the gate)      */
/* ------------------------------------------------------------------ */

/** One banned `voice.dont` phrase found in the generated body. */
export interface BannedVoicePhrase {
  /** The exact matched text (as it appears in the body). */
  excerpt: string;
  /** Character offset in the body. */
  index: number;
}

/**
 * Flag banned `voice.dont` phrases present in M8's OWN generated draft (doc 05:
 * the locked voice is enforced from the START — this catches leakage where a
 * prohibited phrase survives generation). Word-boundary aware (mirrors the
 * superlative + M9 voice-drift matchers) so a marker doesn't hit inside a longer
 * word ("cheap" ⊄ "cheaply"). Deterministic, bounded, deduped by marker.
 *
 * This is a FLAG in the GenerationReport, not a gate — M8 flags, the hard gates
 * (Content Quality full brand-voice fidelity + human) decide. Distinct from M9's
 * drift.ts voice check, which flags phrases the HUMANIZER introduced; this flags
 * phrases in the generated draft itself.
 */
export function findBannedVoicePhrases(body: string, dont: readonly string[]): BannedVoicePhrase[] {
  const text = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  const lower = text.toLowerCase();
  const flags: BannedVoicePhrase[] = [];
  const seen = new Set<string>();
  for (const raw of dont ?? []) {
    if (typeof raw !== "string") continue;
    const marker = raw.trim().toLowerCase();
    if (marker === "" || seen.has(marker)) continue;
    seen.add(marker);
    let from = 0;
    for (;;) {
      const at = lower.indexOf(marker, from);
      if (at === -1) break;
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + marker.length] ?? "";
      if (isBoundaryChar(before) && isBoundaryChar(after)) {
        flags.push({ excerpt: text.slice(at, at + marker.length), index: at });
        if (flags.length >= MAX_FLAGS) {
          flags.sort((a, b) => a.index - b.index);
          return flags;
        }
      }
      from = at + marker.length;
    }
  }
  flags.sort((a, b) => a.index - b.index);
  return flags;
}

/* ------------------------------------------------------------------ */
/* AEO-formatting guardrail (direct-answer opening — NOT the gate)      */
/* ------------------------------------------------------------------ */

/** The AEO direct-answer-opening finding carried in the GenerationReport. */
export interface AeoFormattingFinding {
  /**
   * Which heuristic ran: the aeo-audit skill's own FAQ direct-answer check
   * (`faq_direct_answer`), or the light long-form analog for blog/pillar
   * (`opening_directness`) that reuses the same direct-answer spirit.
   */
  check: "faq_direct_answer" | "opening_directness";
  /** True when the opening leads with a direct answer (no preamble/hedging, not a question). */
  direct: boolean;
  /** Why it was flagged (null when direct). */
  reason: string | null;
  /** The opening sentence that was evaluated. */
  opening: string;
}

/**
 * Evaluate a generated body's AEO direct-answer opening (doc 05 — direct-answer
 * openings are the core AEO citation format). Reuses the gated aeo-audit skill's
 * `evaluateFaqAnswer` READ-ONLY over FAQ bodies; for blog/pillar it applies the
 * SAME direct-answer-opening heuristic as a light analog (the skill's own doc
 * marks `evaluateFaqAnswer` as reusable by content-quality for AEO-formatting
 * review of generated content). A FLAG in the report, never a hard block — M8
 * flags, the review gates decide.
 */
export function evaluateAeoFormatting(
  contentType: GeneratableContentType,
  body: string,
): AeoFormattingFinding {
  const verdict = evaluateFaqAnswer(body);
  const check = contentType === "faq" ? "faq_direct_answer" : "opening_directness";
  return { check, direct: verdict.direct, reason: verdict.reason ?? null, opening: verdict.opening };
}

/* ------------------------------------------------------------------ */
/* Compliance pre-screen (guardrail — NOT the gate)                    */
/* ------------------------------------------------------------------ */

/** Compact, serializable compliance pre-screen summary (the full verdict is the gate's job). */
export interface CompliancePrescreen {
  /** No known-bad pattern detected. NOT a certification — see the skill disclaimer. */
  pass: boolean;
  blockCount: number;
  warnCount: number;
  /** Distinct block-violation rule ids (e.g. "cannabis.health-claims"). */
  blockedRuleIds: string[];
  /** The compliance skill's honest-scope disclaimer, carried through. */
  disclaimer: string;
}

/**
 * Summarize a raw {@link ComplianceResult} into the compact, JSON-serializable
 * {@link CompliancePrescreen} the pipeline carries. Shared by M8's generation
 * report (./generate) and M9's post-humanization re-screen (authenticity/) so both
 * surface compliance to the downstream gates in one shape.
 */
export function summarizeCompliancePrescreen(result: ComplianceResult): CompliancePrescreen {
  return {
    pass: result.pass,
    blockCount: result.violations.length,
    warnCount: result.warnings.length,
    blockedRuleIds: [...new Set(result.violations.map((v) => v.ruleId))].sort(),
    disclaimer: result.disclaimer,
  };
}

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
