/**
 * Meaning/voice DRIFT recheck after humanization (doc 05 Part B; task point 3 — "a
 * humanizer that changes MEANING must be caught"). A humanizer rewrites prose; if
 * it fabricates or alters facts, or slips in an off-voice phrase, the rewrite is
 * NOT a safe substitute for the original and must never be silently accepted.
 *
 * MEANING drift REUSES M8's grounding pass READ-ONLY (`findUngroundedClaims`,
 * src/lib/production/content) — exactly as the task directs ("reuse M8's
 * grounding/voice checks if importable"). The trick: the ORIGINAL M8 body is the
 * meaning ground-truth for the humanize step, so we ground the HUMANIZED text
 * against the original. Any statistic/superlative the humanized text asserts that
 * the original did NOT is a claim the humanizer INTRODUCED — meaning drift. (This
 * catches the fabrication/alteration direction; a humanizer that DROPS a fact is a
 * softer failure that the Content Quality gate owns — stated like ground.ts's own
 * scope disclaimer.)
 *
 * VOICE drift has no importable M8 runtime checker (M8 constrains voice at
 * generation but ships no voice-similarity function), so — per the task's "else
 * flag" — M9 runs a deterministic, bounded guardrail: a banned `voice.dont` phrase
 * that appears in the humanized text but NOT the original was INTRODUCED by the
 * humanizer. Full brand-voice fidelity remains the Content Quality gate's verdict;
 * this is a candidate surfacer, not a voice-quality judgment.
 *
 * Pure — no network, no DB, no LLM, no logging (content must never ride a log line).
 */

import { findUngroundedClaims } from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";

/** One concrete way the humanized text drifted from the original. */
export interface DriftExcerpt {
  kind: "statistic" | "superlative" | "banned_phrase";
  /** The exact matched text (e.g. "98%", "the best", a banned phrase). */
  excerpt: string;
}

/** The drift verdict for one humanization. `detected` ⇒ the rewrite is NOT a safe substitute. */
export interface DriftFinding {
  /** Factual claims the humanized text introduced beyond the original (fabrication/alteration). */
  meaning: DriftExcerpt[];
  /** Banned `voice.dont` phrases the humanized text introduced. */
  voice: DriftExcerpt[];
  detected: boolean;
}

/** Bound the number of surfaced drift excerpts (a pathological rewrite can't blow up work). */
const MAX_DRIFT = 50;

/** Word-ish boundary check (mirrors ground.ts) so a marker doesn't match inside a longer run. */
function isBoundary(ch: string): boolean {
  return ch === "" || !/[a-z0-9]/.test(ch);
}

/** Whether `marker` appears as a bounded token in `lowerText`. */
function containsMarker(lowerText: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(marker, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : lowerText[at - 1];
    const after = lowerText[at + marker.length] ?? "";
    if (isBoundary(before) && isBoundary(after)) return true;
    from = at + marker.length;
  }
}

/**
 * Compare the humanized text against the original + the locked voice and surface
 * any drift. MEANING: ground the humanized text against the ORIGINAL (the original
 * is the single grounding fact) via M8's `findUngroundedClaims` — new
 * statistics/superlatives = introduced claims. VOICE: banned `voice.dont` phrases
 * present in the humanized text but absent from the original = introduced off-voice
 * phrasing. Deterministic.
 */
export function recheckDrift(args: {
  original: string;
  humanized: string;
  voice: VoiceProfile;
}): DriftFinding {
  const { original, humanized, voice } = args;

  // MEANING — reuse M8's grounding pass with the original body as the ground-truth fact set.
  const meaning: DriftExcerpt[] = findUngroundedClaims(humanized, [original])
    .slice(0, MAX_DRIFT)
    .map((c) => ({ kind: c.kind, excerpt: c.excerpt }));

  // VOICE — banned phrases the humanizer INTRODUCED (present in humanized, absent from original).
  const lowerHumanized = humanized.toLowerCase();
  const lowerOriginal = original.toLowerCase();
  const voiceSeen = new Set<string>();
  const voiceDrift: DriftExcerpt[] = [];
  for (const raw of voice.dont ?? []) {
    if (typeof raw !== "string") continue;
    const marker = raw.trim().toLowerCase();
    if (marker === "" || voiceSeen.has(marker)) continue;
    voiceSeen.add(marker);
    if (containsMarker(lowerHumanized, marker) && !containsMarker(lowerOriginal, marker)) {
      voiceDrift.push({ kind: "banned_phrase", excerpt: raw.trim() });
      if (voiceDrift.length >= MAX_DRIFT) break;
    }
  }

  return { meaning, voice: voiceDrift, detected: meaning.length > 0 || voiceDrift.length > 0 };
}
