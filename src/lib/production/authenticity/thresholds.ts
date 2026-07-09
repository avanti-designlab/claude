/**
 * M9 authenticity thresholds — the DOC-SILENT engineering choices (doc 05 Part B
 * / doc 07 §1.5 name the authenticity gate but not its numbers). Pure constants +
 * the pure aggregation/quorum math. No I/O, no clock, no randomness — so the whole
 * humanize→detect→verdict path is DETERMINISTIC: the same candidate + the same
 * detector readings always yield the same verdict (pinned by a determinism test).
 *
 * ⚑ LAUNCH-THRESHOLD FLAGS (ratify with real client data at Gate 1a, exactly like
 * the M2/M3/M4/M6 threshold flags already on the BUILD-STATE ⚑ list). These are
 * reasonable launch defaults, NOT tuned numbers — an authenticity gate that is too
 * loose ships detectable AI; too strict force-flags good prose. They are made
 * loud + greppable here so the Orchestrator/documentation agent can add them to
 * the ratify list, and so no reviewer has to hunt for a magic number in a branch.
 */

/** Greppable flag payload (mirrors M6 DECAY_THRESHOLD_FLAGS / M4 flag strings). */
export const AUTHENTICITY_THRESHOLD_FLAGS =
  "M9 authenticity gate doc-silent defaults (ratify at Gate 1a with real client data): " +
  "DETECTION_PASS_AT=0.30 (per-detector AI-likelihood at/below which a detector reads the " +
  "candidate as human); MIN_DETECTORS=2 (doc 07 'pilot 2–3' — a verdict needs at least this " +
  "many AVAILABLE detectors, else the gate is honestly 'unavailable', never a silent pass); " +
  "REQUIRE_UNANIMOUS=true (ALL available detectors must independently be at/below PASS_AT for " +
  "the panel to pass — the anti-gaming default: you cannot pass by satisfying only the most " +
  "lenient detector). Aggregate detection_score = MAX across available detectors (the most " +
  "conservative single number). The alternative to unanimity is a numeric minAgreeing quorum.";

/**
 * Per-detector pass line. A detector reads the candidate as human when its
 * normalized AI-likelihood (in [0,1], higher = more machine-like) is AT OR BELOW
 * this value. Ratify per vertical/vendor once real detectors are piloted.
 */
export const DETECTION_PASS_AT = 0.3;

/**
 * doc 07 §1.5 "pilot 2–3 vendors". A verdict requires at least this many
 * AVAILABLE detectors — fewer and M9 reports `detectors_unavailable` rather than
 * pretending a one-detector reading is a panel. Never a silent pass.
 */
export const MIN_DETECTORS = 2;

/**
 * Anti-gaming quorum default: when true, EVERY available detector must be at/below
 * {@link DETECTION_PASS_AT} for the panel to pass. When false, the quorum falls
 * back to {@link MIN_DETECTORS} detectors agreeing. "How many detectors must agree"
 * is the doc-silent knob flagged above.
 */
export const REQUIRE_UNANIMOUS = true;

/** The resolved threshold set threaded through the pipeline (defaults from the constants). */
export interface AuthenticityThresholds {
  passAt: number;
  minDetectors: number;
  requireUnanimous: boolean;
}

export const DEFAULT_THRESHOLDS: AuthenticityThresholds = {
  passAt: DETECTION_PASS_AT,
  minDetectors: MIN_DETECTORS,
  requireUnanimous: REQUIRE_UNANIMOUS,
};

/**
 * Normalize a caller-supplied partial threshold override into a valid set. Guards
 * against NaN/out-of-range/negative overrides (a hostile or buggy override must
 * not loosen the gate silently): passAt is clamped to [0,1]; minDetectors floored
 * at 1 and integer-coerced. Absent fields fall back to the launch defaults.
 */
export function resolveThresholds(override?: Partial<AuthenticityThresholds>): AuthenticityThresholds {
  const passAtRaw = override?.passAt;
  const minRaw = override?.minDetectors;
  const passAt =
    typeof passAtRaw === "number" && Number.isFinite(passAtRaw)
      ? Math.min(1, Math.max(0, passAtRaw))
      : DEFAULT_THRESHOLDS.passAt;
  const minDetectors =
    typeof minRaw === "number" && Number.isFinite(minRaw) && minRaw >= 1
      ? Math.floor(minRaw)
      : DEFAULT_THRESHOLDS.minDetectors;
  const requireUnanimous =
    typeof override?.requireUnanimous === "boolean" ? override.requireUnanimous : DEFAULT_THRESHOLDS.requireUnanimous;
  return { passAt, minDetectors, requireUnanimous };
}

/** A single detector's measured, verbatim reading against the pass line. */
export interface ScoredDetector {
  /** True only when the detector produced a valid finite score in [0,1]. */
  available: boolean;
  /** The verbatim normalized score (never massaged); null when unavailable. */
  aiLikelihood: number | null;
}

/** The panel-level aggregation + quorum decision (pure). */
export interface PanelAggregate {
  /** MAX across available detectors — the most conservative single AI-likelihood; null if none available. */
  score: number | null;
  detectorsAvailable: number;
  detectorsBelow: number;
  quorumRequired: number;
  quorumMet: boolean;
  /** Whether the panel clears the gate (quorum met AND enough detectors available). */
  belowThreshold: boolean;
}

/**
 * Aggregate a panel's readings into the conservative score + quorum decision.
 * PURE + DETERMINISTIC. Unavailable detectors are excluded from the max and never
 * counted toward the quorum (a broken/garbage detector can never contribute a
 * "pass"). The panel clears only when enough detectors are available AND the
 * quorum of them is at/below the pass line.
 */
export function aggregatePanel(
  readings: readonly ScoredDetector[],
  thresholds: AuthenticityThresholds,
): PanelAggregate {
  const available = readings.filter(
    (r): r is ScoredDetector & { aiLikelihood: number } => r.available && typeof r.aiLikelihood === "number",
  );
  const detectorsAvailable = available.length;
  const score = detectorsAvailable === 0 ? null : Math.max(...available.map((r) => r.aiLikelihood));
  const detectorsBelow = available.filter((r) => r.aiLikelihood <= thresholds.passAt).length;
  const quorumRequired = thresholds.requireUnanimous ? detectorsAvailable : thresholds.minDetectors;
  const enoughAvailable = detectorsAvailable >= thresholds.minDetectors;
  const quorumMet = enoughAvailable && detectorsBelow >= quorumRequired && quorumRequired > 0;
  return {
    score,
    detectorsAvailable,
    detectorsBelow,
    quorumRequired,
    quorumMet,
    belowThreshold: quorumMet,
  };
}
