/**
 * M3 Visibility Tracker (doc 05 §M3; doc 07 §1.4) — public PURE surface.
 *
 * The pipeline: derive the tracked query set from playbook + client facts
 * (derive.ts) → sample it over the CitationDataProvider port (sampler.ts) →
 * compute run metrics from measured samples only (scoring.ts).
 *
 * Server-side layers are NOT re-exported here (this barrel stays importable
 * anywhere, e.g. for types in UI code): import them by path —
 *   ./actions  — "use server" run action (runVisibilityTracking)
 *   ./persist  — server-only run persistence into visibility_results
 *   ./reads    — server-only dashboard-gauge reads (latest / series / SOV)
 *   ./provider — server-only vendor-resolution seam
 */

export {
  deriveQuerySet,
  ENTITY_TOKENS,
  MAX_TRACKED_QUERIES,
  type DerivedQuery,
  type DerivedQuerySet,
  type ExcludedTemplate,
  type TrackedClientFacts,
} from "./derive";

export {
  citationCredit,
  citedUrlInventory,
  computeRunMetrics,
  domainMatches,
  normalizeDomain,
  perEngineBreakdown,
  shareOfVoice,
  visibilityScore,
  type CitedUrlEntry,
  type CompetitorRef,
  type EngineBreakdown,
  type MeasuredSample,
  type ShareOfVoiceEntry,
  type ShareOfVoiceReport,
  type VisibilityRunMetrics,
} from "./scoring";

export {
  classifyProviderError,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  measuredSamples,
  runCoverage,
  sampleVisibility,
  type ProviderFailureKind,
  type RunCoverage,
  type SampleFailure,
  type SampleOptions,
  type SampleOutcome,
  type VisibilityRun,
} from "./sampler";
