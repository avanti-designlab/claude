/**
 * aeo-audit — playbook-driven weighting (SKILL.md "Weighting").
 *
 * - Base check weights encode general AEO importance (library-defined; the
 *   playbook schema carries no per-check weights — see final report note).
 * - `local_intensity` GATES checks 8–10: national / disabled local module →
 *   local checks are excluded from the score entirely, not scored as failures.
 *   hyper-local amplifies them; semi-local runs them at reduced (MEDIUM) weight.
 * - `channel_weighting` does NOT change check weights — per the skill spec it
 *   shifts FIX PRIORITY toward channels where the vertical builds authority
 *   (applied as a boost during fix prioritization).
 */

import type { Playbook } from "@/lib/types/playbook";
import type { CheckId, ImpactLevel } from "./types";

export const CHECK_CANONICAL_ORDER: readonly CheckId[] = [
  "schema_presence_validity",
  "faq_direct_answer",
  "video_transcript_schema",
  "llms_txt",
  "ai_crawler_access",
  "internal_linking",
  "entity_consistency",
  "gbp_completeness",
  "nap_consistency",
  "review_velocity",
  "core_web_vitals",
  "freshness",
  "onpage_basics",
];

export const CHECK_NAMES: Record<CheckId, string> = {
  schema_presence_validity: "Schema presence + validity",
  faq_direct_answer: "Direct-answer FAQ formatting",
  video_transcript_schema: "Transcript + VideoObject on video pages",
  llms_txt: "llms.txt",
  ai_crawler_access: "AI-crawler access",
  internal_linking: "Internal-linking density",
  entity_consistency: "Entity consistency",
  gbp_completeness: "GBP completeness",
  nap_consistency: "NAP consistency",
  review_velocity: "Review velocity",
  core_web_vitals: "Core Web Vitals",
  freshness: "Freshness / staleness",
  onpage_basics: "Title / meta / H1 / alt coverage",
};

/** Base rubric weights (relative units; normalized over applicable checks). */
export const BASE_CHECK_WEIGHTS: Record<CheckId, number> = {
  schema_presence_validity: 12,
  faq_direct_answer: 9,
  video_transcript_schema: 6,
  llms_txt: 4,
  ai_crawler_access: 12, // a blocked crawler makes everything else moot
  internal_linking: 7,
  entity_consistency: 8,
  gbp_completeness: 8,
  nap_consistency: 7,
  review_velocity: 6,
  core_web_vitals: 6,
  freshness: 7,
  onpage_basics: 8,
};

export const LOCAL_CHECK_IDS: readonly CheckId[] = [
  "gbp_completeness",
  "nap_consistency",
  "review_velocity",
];

export function isLocalCheck(checkId: CheckId): boolean {
  return LOCAL_CHECK_IDS.includes(checkId);
}

/**
 * Local-intensity multiplier for local checks
 * (doc 02: hyper-local → CRITICAL/HIGH, semi-local → MEDIUM, national → OFF).
 */
const LOCAL_INTENSITY_MULTIPLIER: Record<Playbook["local_intensity"], number> = {
  "hyper-local": 1.5,
  "semi-local": 0.75,
  national: 0,
};

/** GBP-priority multiplier applied to the GBP check only. */
const GBP_PRIORITY_MULTIPLIER: Record<Playbook["local_module_config"]["gbp_priority"], number> = {
  critical: 1.25,
  high: 1,
  medium: 0.75,
  off: 0,
};

/** True when local checks (8–10) are in scope for this playbook. */
export function localChecksApplicable(playbook: Playbook): boolean {
  return playbook.local_intensity !== "national" && playbook.local_module_config.enabled;
}

/**
 * Effective rubric weight of a check under this playbook.
 * 0 = gated off entirely (excluded from the score, not failed).
 */
export function effectiveCheckWeight(checkId: CheckId, playbook: Playbook): number {
  const base = BASE_CHECK_WEIGHTS[checkId];
  if (!isLocalCheck(checkId)) return base;
  if (!localChecksApplicable(playbook)) return 0;
  const intensity = LOCAL_INTENSITY_MULTIPLIER[playbook.local_intensity];
  const gbp =
    checkId === "gbp_completeness"
      ? GBP_PRIORITY_MULTIPLIER[playbook.local_module_config.gbp_priority]
      : 1;
  return base * intensity * gbp;
}

// ---------------------------------------------------------------------------
// channel_weighting → fix-priority boost
// ---------------------------------------------------------------------------

/**
 * Channel-name keywords per check. Playbook channel names are free-form
 * strings ("Google Business Profile + local", "On-site resource center
 * (pillars + FAQ + video)"), so fixes are matched to channels by keyword.
 */
const CHECK_CHANNEL_KEYWORDS: Record<CheckId, RegExp[]> = {
  schema_presence_validity: [/schema/i, /product/i, /menu/i, /content/i, /resource/i],
  faq_direct_answer: [/faq/i, /content/i, /resource/i, /education/i, /pillar/i, /guide/i],
  video_transcript_schema: [/video/i, /resource/i, /content/i],
  llms_txt: [/on-?site/i, /content/i, /resource/i],
  ai_crawler_access: [/on-?site/i, /content/i, /resource/i, /schema/i],
  internal_linking: [/on-?site/i, /content/i, /resource/i, /pillar/i],
  entity_consistency: [/entity/i, /\bpr\b/i, /press/i, /person/i, /linkedin/i, /podcast/i],
  gbp_completeness: [/local/i, /gbp/i, /google business/i],
  nap_consistency: [/local/i, /gbp/i, /google business/i, /director/i],
  review_velocity: [/review/i],
  core_web_vitals: [],
  freshness: [/refresh/i, /evergreen/i, /content/i, /resource/i],
  onpage_basics: [/on-?site/i, /content/i, /local/i],
};

/**
 * 1.0–2.0 multiplier: 1 + (max weight among matching channels)/100.
 * Shifts fix priority toward where the vertical actually builds authority.
 */
export function channelBoost(checkId: CheckId, playbook: Playbook): number {
  const keywords = CHECK_CHANNEL_KEYWORDS[checkId];
  let maxWeight = 0;
  for (const [channel, weight] of Object.entries(playbook.channel_weighting)) {
    // Number.isFinite rejects non-numbers, NaN, and ±Infinity. NaN in
    // particular MUST be excluded here: `NaN <= 0` is false, so a plain
    // `weight <= 0` guard lets NaN through, Math.min/Math.max propagate it,
    // and the resulting priorityScore: NaN corrupts the roadmap sort
    // (0.2 gate finding). Bad playbook data degrades to "no boost", never
    // to a poisoned fix list.
    if (!Number.isFinite(weight) || weight <= 0) continue;
    if (keywords.some((re) => re.test(channel))) {
      maxWeight = Math.max(maxWeight, Math.min(weight, 100));
    }
  }
  return 1 + maxWeight / 100;
}

export const IMPACT_FACTOR: Record<ImpactLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const IMPACT_RANK: Record<ImpactLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
