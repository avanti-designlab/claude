/**
 * Pure M9 ⇄ `content_items` mapping (FROZEN schema, migration 0005). No server
 * imports, no Supabase client — unit-tested in the default run; ./persist feeds
 * these to PostgREST and shapes reads back through them. Mirrors M8's rows.ts split.
 *
 * THE STRUCTURAL "M9 CANNOT APPROVE/PUBLISH" GUARANTEE (CLAUDE.md rule 5; doc 05
 * pipeline). {@link humanizationUpdatePayload} is the ONLY object M9 ever writes to
 * `content_items`, and it HARD-PINS what M9 may touch:
 *   - status = 'in_review'  → the pinned {@link M9_ADVANCED_STATUS}. M9 "advances
 *     the pipeline to the next stage" (the review queue) and NOTHING further. It is
 *     NOT a parameter — no caller can raise it to approved/published through here.
 *   - humanization = the M9 record (the ONLY verdict column M9 owns).
 *   - body = the humanized text, and ONLY when supplied (drift → omitted → original kept).
 * It NEVER sets `quality_review` / `compliance_review` (those are the independent
 * gates' verdicts — M9 writing them would be self-approval) nor `automation_level`.
 * Belt + braces with the DB CHECK `content_items_reviewed_before_approval`: even a
 * bug that tried status='approved' here would be rejected by Postgres (no verdicts).
 *
 * WHY M9 WRITES `body` (a deliberate, loud, review-flagged decision — see
 * AUTHENTICITY_ORIGINAL_BODY_GAP): "Humanize" is a TRANSFORM stage. If the
 * humanized text were not persisted, the downstream Quality/Compliance gates +
 * publish would read the ORIGINAL un-humanized M8 body and the entire M9 stage
 * would be a no-op. So the humanized text becomes the body that proceeds — but
 * ONLY when meaning + voice were preserved (never persist drifted text).
 */

import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  Json,
} from "@/lib/types/db";
import type { DriftExcerpt } from "./drift";
import type {
  AuthenticityVerdictView,
  CompliancePrescreenView,
  ComplianceRegression,
  DetectorVerdictView,
  FlagReason,
  HumanizationRecord,
  HumanizationVerdict,
} from "./types";

/**
 * The ONLY status M9 ever writes — the "advance to the review stage" transition
 * (draft → in_review). Exported so tests assert the constant directly. Allowed
 * without review verdicts by the DB CHECK; approved/published stay structurally
 * unreachable from M9.
 */
export const M9_ADVANCED_STATUS = "in_review" as const satisfies ContentItemStatus;

/** Greppable schema-gap flag (M8/M10 precedent: CONTENT_GENERATION_REPORT_GAP). */
export const AUTHENTICITY_ORIGINAL_BODY_GAP =
  "content_items has ONE body column and NO pre-humanization history (migration 0005). M9 " +
  "overwrites body with the humanized text (only when meaning/voice preserved), so the original " +
  "M8 draft is not retained. Keeping both would need a data-model change (e.g. content_items." +
  "original_body or a revisions table) — post-freeze Orchestrator + Code Review path.";

/** The exact update M9 applies to a `content_items` row. Only the columns M9 owns. */
export interface HumanizationUpdatePayload {
  humanization: HumanizationRecord;
  status: typeof M9_ADVANCED_STATUS;
  /** Present ONLY when the humanized text is applied (omitted ⇒ original body kept). */
  body?: string;
}

/**
 * Build the `content_items` update for one authenticity result. `status` is
 * hard-pinned to {@link M9_ADVANCED_STATUS}; `body` is included only when
 * `bodyToPersist` is non-null. Nothing the caller passes can add a review column,
 * change the status target, or touch automation_level.
 */
export function humanizationUpdatePayload(
  record: HumanizationRecord,
  bodyToPersist: string | null,
): HumanizationUpdatePayload {
  const payload: HumanizationUpdatePayload = { humanization: record, status: M9_ADVANCED_STATUS };
  if (bodyToPersist !== null) payload.body = bodyToPersist;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Read-side verdict view — defensive parse of content_items.humanization */
/* ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const FLAG_REASONS: readonly FlagReason[] = [
  "meaning_drift",
  "voice_drift",
  "detection_above_threshold",
  "compliance_regression",
];
const DRIFT_KINDS: readonly DriftExcerpt["kind"][] = ["statistic", "superlative", "banned_phrase"];

function toDriftExcerpts(value: unknown): DriftExcerpt[] {
  if (!Array.isArray(value)) return [];
  const out: DriftExcerpt[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const kind = item.kind;
    const excerpt = item.excerpt;
    if (typeof excerpt !== "string") continue;
    if (!(DRIFT_KINDS as readonly unknown[]).includes(kind)) continue;
    out.push({ kind: kind as DriftExcerpt["kind"], excerpt });
  }
  return out;
}

function toDetectorViews(value: unknown): DetectorVerdictView[] {
  if (!Array.isArray(value)) return [];
  const out: DetectorVerdictView[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    out.push({
      vendor: typeof item.vendor === "string" ? item.vendor : "unknown",
      available: item.available === true,
      aiLikelihood: numOrNull(item.aiLikelihood),
      belowThreshold: boolOrNull(item.belowThreshold),
    });
  }
  return out;
}

/** String-only members of a (possibly hostile) array; anything else dropped. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** The FRESH post-humanization compliance prescreen (or null when absent/malformed). */
function toCompliancePrescreenView(value: unknown): CompliancePrescreenView | null {
  if (!isObject(value)) return null;
  return {
    pass: boolOrNull(value.pass),
    blockCount: numOrNull(value.blockCount),
    warnCount: numOrNull(value.warnCount),
    blockedRuleIds: toStringArray(value.blockedRuleIds),
    disclaimer: strOrNull(value.disclaimer),
  };
}

/** The original-vs-humanized compliance delta (safe defaults when absent/malformed). */
function toComplianceRegression(value: unknown): ComplianceRegression {
  const v = isObject(value) ? value : {};
  return {
    regressed: v.regressed === true,
    newBlockRuleIds: toStringArray(v.newBlockRuleIds),
    droppedRequiredRuleIds: toStringArray(v.droppedRequiredRuleIds),
  };
}

/**
 * Shape a raw `content_items.humanization` jsonb into an {@link AuthenticityVerdictView},
 * or null when M9 has not run (humanization null/absent/not-an-object). Tolerant of
 * the rich M9 record, a legacy minimal `HumanizationResult`, AND hostile/malformed
 * jsonb — it reads defensively and NEVER throws (a malformed detectors array becomes
 * [], a bad number becomes null). Also the seam that turns an in-memory
 * {@link HumanizationRecord} into the returned view (record IS the stored shape).
 */
export function authenticityVerdictView(humanization: unknown): AuthenticityVerdictView | null {
  if (!isObject(humanization)) return null;
  const h = humanization;

  const rawVerdict = h.verdict;
  const verdict: HumanizationVerdict | "unknown" =
    rawVerdict === "passed" || rawVerdict === "flagged_for_human" ? rawVerdict : "unknown";

  const flaggedReasons = Array.isArray(h.flaggedReasons)
    ? h.flaggedReasons.filter((r): r is FlagReason => (FLAG_REASONS as readonly unknown[]).includes(r))
    : [];

  const aggregate = isObject(h.aggregate) ? h.aggregate : {};
  const quorum = isObject(h.quorum) ? h.quorum : {};
  const thresholds = isObject(h.thresholds) ? h.thresholds : {};
  const drift = isObject(h.drift) ? h.drift : {};
  const humanizer = isObject(h.humanizer) ? h.humanizer : {};

  return {
    verdict,
    // `passes` is the honest cleared signal; default to false (fail-closed) if absent/malformed.
    passes: h.passes === true,
    flaggedReasons,
    humanized: h.humanized === true,
    humanizerVendor: strOrNull(humanizer.vendor),
    detectionScore: numOrNull(h.detection_score),
    detectors: toDetectorViews(h.detectors),
    aggregate: {
      score: numOrNull(aggregate.score),
      detectorsAvailable: numOrNull(aggregate.detectorsAvailable),
      detectorsBelow: numOrNull(aggregate.detectorsBelow),
      belowThreshold: boolOrNull(aggregate.belowThreshold),
    },
    quorum: { required: numOrNull(quorum.required), met: boolOrNull(quorum.met) },
    thresholds: {
      passAt: numOrNull(thresholds.passAt),
      minDetectors: numOrNull(thresholds.minDetectors),
      requireUnanimous: boolOrNull(thresholds.requireUnanimous),
    },
    drift: {
      meaning: toDriftExcerpts(drift.meaning),
      voice: toDriftExcerpts(drift.voice),
      detected: drift.detected === true,
    },
    compliancePrescreen: toCompliancePrescreenView(h.compliancePrescreen),
    complianceRegression: toComplianceRegression(h.complianceRegression),
  };
}

/** The `content_items` columns M9's read selects (client_id/type feed the voice re-read). */
export interface AuthenticityDraftRow {
  id: string;
  client_id: string;
  brand_kit_id: string;
  type: ContentItemType;
  automation_level: AutomationLevel;
  body: string;
  status: ContentItemStatus;
  humanization: Json;
}
