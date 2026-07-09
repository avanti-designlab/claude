/**
 * M15 Review management — public API (doc 05 Part C M15, doc 07 §1.6).
 *
 * The reputation half of the platform: MONITOR reviews (deferred vendor
 * connector), compute deterministic SENTIMENT + VELOCITY, and DRAFT on-brand
 * responses through the SAME content pipeline as M8. It generates + measures; it
 * NEVER approves and NEVER auto-sends. Joins `src/lib/reviews/`, importing M7's
 * locked-kit read, M8's grounding/voice/compliance passes + generation port, and
 * the compliance skill READ-ONLY — it modifies none of them.
 *
 * THE PIPELINE (doc 05: "draft on-brand responses (through the content pipeline)"):
 *   Draft (M15, brand voice + grounding + compliance pre-screen) → content-quality
 *   → compliance-review → human approve → (a separate, human-approved reply write).
 * A producing agent never approves — or sends — its own output (CLAUDE.md rule 5).
 *
 * WHY IT CANNOT AUTO-SEND (structural, not merely policy):
 *  - The monitor port ({@link ReviewPlatformProvider}) is READ-ONLY — no reply/
 *    post/send method exists anywhere in this module.
 *  - A drafted reply is a {@link ReviewResponseDraft} with a PINNED pre-approval
 *    status ({@link REVIEW_RESPONSE_DRAFT_STATUS}); there is no exported transition
 *    to a "sent" state. Publishing a reply is a separate human-approved connector
 *    write (integrations, 1.7), never fired from here.
 *
 * PERSISTENCE HONESTY (against the FROZEN 0005/0006 schema — three greppable gaps):
 *  - REVIEWS_TABLE_GAP — no `reviews` table, so individual reviews are not
 *    persisted (input material only; M4 precedent). The normalized review SIGNAL
 *    persists to `metrics` (source='reviews') — the honest home (M3 precedent).
 *  - REVIEW_RESPONSE_CONTENT_TYPE_GAP — content_items has no 'review_response'
 *    type, so a drafted reply is NOT persisted (forcing a wrong type is refused);
 *    the draft rides back in the action result for the gates.
 *  - REVIEW_RESPONSE_GENERATION_TYPE_GAP — M8's generation taxonomy has no
 *    'review_response'; the generation spec uses 'faq' as the nearest analog with
 *    the authoritative type carried alongside.
 */

/** Shared types + the honest metric source + the ⚑ ratify threshold flags. */
export {
  KNOWN_REVIEW_PLATFORMS,
  REVIEW_METRIC_SOURCE,
  REVIEW_SIGNAL_THRESHOLD_FLAGS,
  type IngestedReview,
  type KnownReviewPlatform,
  type ReviewSentiment,
  type SentimentBasis,
  type SentimentClassification,
  type SentimentDistribution,
  type VelocityTrend,
  type ReviewVelocity,
  type ReviewSignal,
} from "./types";

/** The MONITOR port (read-only — the structural no-send pin) + its scriptable fake. */
export {
  type ReviewPlatformProvider,
  type ReviewFetchRequest,
  type ReviewFetchResult,
  type ReviewScript,
  ScriptedReviewPlatformProvider,
} from "./provider";

/** Monitor orchestration (provider injected) — unavailable platforms excluded, never zeroed. */
export {
  ingestReviews,
  type MonitorRequest,
  type MonitorResult,
  type ExcludedPlatform,
} from "./monitor";

/** Deterministic sentiment + velocity + the persisted signal builder (pure). */
export { classifyReviewSentiment, aggregateSentiment } from "./sentiment";
export { computeReviewVelocity, type VelocityInput } from "./velocity";
export { buildReviewSignal, type BuildReviewSignalInput } from "./signal";

/** The draft-response flow (pure; content-generation port injected) + the pinned pre-approval status. */
export {
  draftReviewResponse as draftReviewResponseCore,
  buildReviewResponseSpec,
  responseGroundingFacts,
  REVIEW_RESPONSE_DRAFT_STATUS,
  RESPONSE_GENERATION_CONTENT_TYPE,
  type ReviewResponseRequest,
  type ReviewResponseReport,
  type ReviewResponseDraft,
  type DraftReviewResponseInput,
  type DraftReviewResponseOutcome,
} from "./respond";

/** Row mapping (the metrics honest home) + the three greppable schema-gap flags. */
export {
  reviewSignalMetricRow,
  reviewSignalEntry,
  REVIEWS_TABLE_GAP,
  REVIEW_RESPONSE_CONTENT_TYPE_GAP,
  REVIEW_RESPONSE_GENERATION_TYPE_GAP,
  type ReviewSignalMetricData,
  type ReviewMetricInsertRow,
  type ReviewSignalEntry,
} from "./rows";

/** Server actions — capture the signal, draft a reply, read the signal queue. */
export {
  captureReviewSignal,
  draftReviewResponse,
  listReviewSignals,
  type CaptureReviewSignalInput,
  type CaptureReviewSignalResult,
  type DraftReviewResponseActionInput,
  type DraftReviewResponseResult,
  type ListReviewSignalsResult,
} from "./actions";
