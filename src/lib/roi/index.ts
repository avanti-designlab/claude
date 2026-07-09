/**
 * M16 ROI / attribution (doc 05 §M16; doc 07 §1.8) — public PURE surface.
 *
 * The pipeline: resolve the outcome-source ports (provider.ts) → collect
 * measured outcomes over a period (collect.ts) → normalize homed captures into
 * the frozen `metrics` shape (normalize.ts) → recompute correlational
 * attribution/ROI from stored captures (attribution.ts, reads.ts).
 *
 * DEFERRED CONNECTORS (doc 04 §3/§7): GA4, Search Console, call-tracking,
 * form-fills and a CRM handoff are all RENTED behind the RoiSource port —
 * modules call the port, never a vendor SDK. No real adapter has landed; the
 * ports + fakes ship here and resolution returns null (unavailable → honest
 * ABSENT, never invented zeros).
 *
 * Server-side layers are NOT re-exported (this barrel stays importable anywhere,
 * e.g. for types in UI code): import them by path —
 *   ./actions  — "use server" collect action (collectRoiSnapshot)
 *   ./persist  — server-only capture persistence into `metrics`
 *   ./reads    — server-only dashboard reads (latest / series / attribution)
 *   ./provider — server-only vendor-resolution seam
 */

export {
  ROI_SOURCE_IDS,
  ROI_SOURCE_METRICS,
  ROI_SOURCE_API_HOSTS,
  resolvePinnedApiHost,
  assertPinnedApiHost,
  isRoiSourceError,
  RoiSourceError,
  InMemoryRoiSource,
  type RoiSourceId,
  type OutcomePeriod,
  type OutcomeSample,
  type RoiSource,
  type RoiSourceRequest,
  type RoiSourceResult,
  type RoiSourceErrorCode,
  type RoiSourceAdapterConfig,
} from "./sources";

export {
  summarizeOutcomes,
  attributeOutcomes,
  type MetricTotal,
  type SourceCoverage,
  type OutcomeSummary,
  type WorkEvent,
  type MetricAttribution,
  type MetricValuation,
  type RoiEstimate,
  type AttributionResult,
} from "./attribution";

export {
  collectOutcomes,
  type RoiCollection,
  type CollectionCoverage,
  type SourceOutcome,
  type SourceFailureKind,
  type ResolvedSources,
} from "./collect";

export {
  ROI_SOURCE_TO_METRIC_SOURCE,
  HOMED_ROI_SOURCES,
  UNHOMED_ROI_SOURCES,
  toMetricCaptureInsert,
  outcomeSamplesFromCapture,
  metricSourceToRoiSource,
  type MetricCaptureData,
  type MetricCaptureInsert,
  type NormalizeCaptureOutcome,
} from "./normalize";
