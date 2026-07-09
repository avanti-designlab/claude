/**
 * M9 Humanization + AI-detection authenticity gate — public API (doc 05 Part B,
 * doc 07 §1.5). A pipeline STAGE, not an approver.
 *
 * THE PIPELINE, AND M9's TWO STEPS (doc 05):
 *   Generate (M8) → Humanize (M9) → Detect (M9) → Content Quality → Compliance
 *   → Schema (M10) → Publish (1.2/1.3 change-management + human approve).
 * M9 owns Humanize + Detect. It records the result into `content_items.humanization`
 * and ADVANCES the pipeline to the review queue (status → 'in_review'); it writes
 * NO review verdict and can NEVER reach approved/published — the frozen DB CHECK
 * (`content_items_reviewed_before_approval`, migration 0005) + rows.ts's pinned
 * status make that structurally impossible. A producing agent never approves its
 * own output (CLAUDE.md rule 5).
 *
 * VENDORS DEFERRED (pilot-2-3, pluggable — doc 07). Real humanizer + AI-detection
 * adapters read operator secrets and land in ./live-providers behind the two
 * ports; until then M9 fails closed with honest unavailable outcomes. No vendor
 * SDK, no network in any tested path.
 *
 * Layout — joins production/ beside M7 (brand-kit/), M8 (content/), M10 (schema/):
 *   thresholds.ts    doc-silent pass-line + quorum (⚑ ratify) + pure aggregation
 *   humanizer.ts     HumanizerProvider PORT + scriptable fake
 *   detector.ts      AIDetectionProvider PORT + multi-detector PANEL runner + fake
 *   drift.ts         meaning (reuses M8 findUngroundedClaims) + voice drift recheck
 *   authenticate.ts  the pure humanize→detect→flag core
 *   rows.ts          record ⇄ content_items mapping + pinned advance-status + view
 *   persist.ts       UPDATE humanization + status (+ body); reads; redacted telemetry
 *   live-providers.ts deferred vendor resolution (fails closed)
 *   actions.ts       runAuthenticityGate + readAuthenticityVerdict
 */

/** Stable greppable flags (Orchestrator/docs agent — M8/M10 precedent). */
export { AUTHENTICITY_ORIGINAL_BODY_GAP, M9_ADVANCED_STATUS } from "./rows";
export { AUTHENTICITY_THRESHOLD_FLAGS } from "./thresholds";

// The two vendor PORTS + their scriptable fakes (the pilot-2-3 deferred seam).
export {
  type HumanizerProvider,
  type HumanizeRequest,
  type HumanizeResult,
  ScriptedHumanizerProvider,
} from "./humanizer";
export {
  type AIDetectionProvider,
  type DetectionReading,
  type DetectorReading,
  runDetectorPanel,
  ScriptedDetectionProvider,
} from "./detector";

// Threshold constants + pure aggregation/quorum (⚑ launch-threshold ratify list).
export {
  DETECTION_PASS_AT,
  MIN_DETECTORS,
  REQUIRE_UNANIMOUS,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  aggregatePanel,
  type AuthenticityThresholds,
  type PanelAggregate,
  type ScoredDetector,
} from "./thresholds";

// The meaning/voice-drift recheck (reuses M8's grounding pass read-only).
export { recheckDrift, type DriftExcerpt, type DriftFinding } from "./drift";

// The pure core flow (provider-injected).
export { authenticate, type AuthenticateInput, type AuthenticateOutcome } from "./authenticate";

// Record ⇄ row mapping + the read-side verdict view.
export {
  authenticityVerdictView,
  humanizationUpdatePayload,
  type AuthenticityDraftRow,
  type HumanizationUpdatePayload,
} from "./rows";

// Persisted record + read-side view types.
export {
  type HumanizationRecord,
  type HumanizationVerdict,
  type FlagReason,
  type AuthenticityVerdictView,
  type DetectorVerdictView,
} from "./types";

// Server actions (the run gate + the verdict read).
export {
  runAuthenticityGate,
  readAuthenticityVerdict,
  type RunAuthenticityGateResult,
  type ReadAuthenticityVerdictResult,
} from "./actions";
