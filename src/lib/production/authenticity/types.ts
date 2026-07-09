/**
 * M9 authenticity — the persisted record + the read-side verdict view (doc 05
 * Part B; doc 07 §1.5). M9 records the humanize→detect result into
 * `content_items.humanization` (FROZEN schema, migration 0005) and advances the
 * pipeline; it NEVER approves/publishes.
 *
 * THE FROZEN-SHAPE CONTRACT. The frozen column shape is `HumanizationResult`
 * (`{humanized, detection_score, passes}`, src/lib/types/db.ts) — minimal, and
 * what M8's row reader (production/content/rows.ts) reads (`humanized`, `passes`).
 * M9 needs to record MORE (each detector's verbatim score + an aggregate verdict +
 * the drift recheck). So {@link HumanizationRecord} `extends HumanizationResult`:
 * it is a strict SUPERSET — the frozen triple is present with the frozen meanings,
 * so M8's reads + the frozen type stay valid, and the extra fields carry M9's
 * detail. The column is jsonb with only an is-object CHECK, so the richer object
 * stores cleanly. (No migration, no db.ts change — those are out of bounds; this
 * rides inside the existing jsonb.)
 */

import type { CompliancePrescreen } from "@/lib/production/content";
import type { HumanizationResult } from "@/lib/types/db";
import type { DetectorReading } from "./detector";
import type { DriftExcerpt } from "./drift";

/** The M9 gate outcome. `flagged_for_human` = a human must resolve before it can proceed to approval. */
export type HumanizationVerdict = "passed" | "flagged_for_human";

/**
 * Why an item was flagged (empty when passed). Reported, never hidden.
 * `compliance_regression` = the humanizer's rewrite introduced a NEW block
 * violation, or DROPPED a required element the original satisfied — the humanized
 * text is never applied in that case (the compliant original is kept).
 */
export type FlagReason =
  | "meaning_drift"
  | "voice_drift"
  | "detection_above_threshold"
  | "compliance_regression";

/**
 * How the HUMANIZED body's compliance screen compares to the ORIGINAL's — the
 * signal behind `compliance_regression`. M9 flags + refuses to apply the humanized
 * text on a regression; it NEVER writes the compliance_review verdict (that stays
 * the independent Compliance gate's — M9 flags, it does not self-clear).
 */
export interface ComplianceRegression {
  /** True when the humanizer introduced a new block or dropped a required element. */
  regressed: boolean;
  /** Block rule ids present on the humanized body but NOT on the original. */
  newBlockRuleIds: string[];
  /** Required-element rule ids satisfied on the original but MISSING on the humanized body. */
  droppedRequiredRuleIds: string[];
}

/**
 * The record persisted to `content_items.humanization`. A strict SUPERSET of the
 * frozen `HumanizationResult`:
 *  - `humanized`        = the humanized text was APPLIED to content_items.body
 *                         (true only when meaning/voice were preserved).
 *  - `detection_score`  = the AGGREGATE AI-likelihood (MAX across available
 *                         detectors) of the HUMANIZED CANDIDATE M9 evaluated.
 *                         When `humanized` is false (drift → original kept), this
 *                         still describes the evaluated-then-rejected candidate —
 *                         see `humanizer.applied` + `verdict`.
 *  - `passes`           = the FULL M9 gate: `verdict === "passed"` (detection
 *                         quorum met AND no drift AND providers available). The
 *                         honest "cleared" signal — a machine-flagged item has
 *                         passes=false and can never reach the publish queue.
 */
export interface HumanizationRecord extends HumanizationResult {
  /** Record shape version (forward-compat for the read mapper). */
  schemaVersion: 1;
  verdict: HumanizationVerdict;
  /** Distinct, sorted flag reasons; [] when passed. */
  flaggedReasons: FlagReason[];
  humanizer: {
    vendor: string;
    /** Whether the humanized text was applied to the body (false ⇒ original kept, e.g. on drift). */
    applied: boolean;
  };
  /** Every detector's VERBATIM reading — the multi-detector panel, reported in full. */
  detectors: DetectorReading[];
  aggregate: {
    /** MAX across available detectors; null if none available. Mirrors `detection_score`. */
    score: number | null;
    detectorsAvailable: number;
    detectorsBelow: number;
    belowThreshold: boolean;
  };
  quorum: {
    required: number;
    met: boolean;
  };
  /** The engineering thresholds this verdict used (so a verdict is self-describing / re-derivable). */
  thresholds: {
    passAt: number;
    minDetectors: number;
    requireUnanimous: boolean;
  };
  drift: {
    meaning: DriftExcerpt[];
    voice: DriftExcerpt[];
    detected: boolean;
  };
  /**
   * FRESH compliance pre-screen computed on the SHIPPING body (the humanized text
   * when applied, else the kept original). Attached so the downstream Compliance
   * gate assists on the actual shipping text, not M8's stale pre-humanization
   * screen. It is a guardrail summary, NOT the compliance_review verdict.
   */
  compliancePrescreen: CompliancePrescreen;
  /** Original-vs-humanized compliance delta driving `compliance_regression`. */
  complianceRegression: ComplianceRegression;
}

/* ------------------------------------------------------------------ */
/* Read-side verdict view (for the Quality/Compliance gates + work-log) */
/* ------------------------------------------------------------------ */

/** One detector as surfaced to a reader. */
export interface DetectorVerdictView {
  vendor: string;
  available: boolean;
  aiLikelihood: number | null;
  belowThreshold: boolean | null;
}

/**
 * The shaped, defensively-parsed view of `content_items.humanization` for the
 * review gates + the dashboard work-log. Tolerant of BOTH the rich M9 record and
 * a legacy/minimal `HumanizationResult`, and of hostile/malformed jsonb (safe
 * nulls, never a throw). `verdict: "unknown"` means the row carries a minimal
 * humanization with no rich verdict (or a malformed one).
 */
export interface AuthenticityVerdictView {
  verdict: HumanizationVerdict | "unknown";
  /** The honest "cleared" signal — true only when the full gate passed. */
  passes: boolean;
  flaggedReasons: string[];
  /** Humanized text was applied to the body. */
  humanized: boolean;
  humanizerVendor: string | null;
  /** Aggregate AI-likelihood of the evaluated candidate; null if unknown. */
  detectionScore: number | null;
  detectors: DetectorVerdictView[];
  aggregate: {
    score: number | null;
    detectorsAvailable: number | null;
    detectorsBelow: number | null;
    belowThreshold: boolean | null;
  };
  quorum: { required: number | null; met: boolean | null };
  thresholds: { passAt: number | null; minDetectors: number | null; requireUnanimous: boolean | null };
  drift: { meaning: DriftExcerpt[]; voice: DriftExcerpt[]; detected: boolean };
  /**
   * FRESH compliance pre-screen of the shipping body (null when M9 has not run or
   * the row is a legacy/minimal record). The Compliance gate assists on THIS, not
   * M8's stale pre-humanization screen.
   */
  compliancePrescreen: CompliancePrescreenView | null;
  /** Original-vs-humanized compliance delta (safe defaults when absent/malformed). */
  complianceRegression: ComplianceRegression;
}

/** Defensively-parsed compliance pre-screen for the read-side view. */
export interface CompliancePrescreenView {
  pass: boolean | null;
  blockCount: number | null;
  warnCount: number | null;
  blockedRuleIds: string[];
  disclaimer: string | null;
}
