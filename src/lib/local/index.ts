/**
 * M14 Local SEO — public API (doc 05 M14, doc 07 §1.6).
 *
 * Multi-location, playbook-intensity-scoped local assessment: per-location NAP
 * consistency (crawl vs the canonical record), local completeness (LocalBusiness-
 * class schema + GBP + local-pack readiness by ZIP), local schema production via
 * the M10 visible-text-gated path, and prioritized local fixes into plans via the
 * audit-merge shape. Honesty-first: absent/unconnected/uncrawlable is stated,
 * never a fabricated score.
 *
 * Reuse boundaries (this module invents no core logic):
 *  - crawl + SSRF egress guard: src/lib/intelligence/crawl (`crawlSite`);
 *  - NAP normalization + GBP field scoring: the aeo-audit skill;
 *  - schema generation + visible-text gate + change-management feed: M10
 *    (src/lib/production/schema);
 *  - connector-port pattern: src/lib/connectors (GBP is a deferred vendor port).
 */

// Intensity — read straight from the loaded playbook.
export {
  localIntensity,
  isLocalOff,
  impactForIntensity,
  type LocalIntensityLevel,
} from "./intensity";

// Canonical location parsing (clients.locations → per-location records).
export { parseClientLocations, type CanonicalLocation } from "./locations";

// GBP data provider port (deferred vendor connector; honest not-connected).
export {
  GBP_NOT_CONNECTED,
  InMemoryGbpDataProvider,
  NotConnectedGbpProvider,
  type GbpDataProvider,
  type GbpLocationQuery,
  type GbpLocationResult,
} from "./gbp-provider";

// On-site NAP consistency (pure).
export {
  assessOnSiteNap,
  buildSiteNapSurface,
  type CanonicalNap,
  type SiteNapSurface,
} from "./nap";

// Local completeness (GBP via skill reuse) + local-pack readiness.
export { assessGbp, assessLocalPack, GBP_READY_MIN_SCORE } from "./completeness";

// Local schema production via M10 (visible-text gated) + the change-management feed.
export {
  buildSchemaChange,
  localSchemaTypeFor,
  produceLocationSchema,
  type LocalSchemaType,
  type LocationSchemaInput,
  type LocationSchemaOutcome,
  type SchemaChangeSpec,
} from "./schema";

// The per-location assessment orchestrator (crawl + GBP port + per-location).
export { assessClientLocal, type AssessClientLocalInput } from "./assess";

// Plan-merge seam — { fixes } into generatePlan, like M6/M4.
export { localFixes, localPlanInput } from "./plan-input";

// Persistence (audits row w/ local-assessment discriminator) + history reads.
export {
  isLocalScore,
  localAssessmentInsertRow,
  localHistoryEntry,
  localScoreCapture,
  LOCAL_ASSESSMENT_KIND,
  type LocalAssessmentInsertRow,
  type LocalHistoryEntry,
  type LocalScoreCapture,
} from "./rows";
export {
  logLocalFailure,
  persistLocalAssessment,
  readLocalHistory,
  LOCAL_FAILURE_MARKER,
  LOCAL_HISTORY_MAX,
  LOCAL_SAVE_WARNING,
  type LocalFailureStage,
} from "./persist";

// Report contract.
export type {
  GbpAssessment,
  GbpConnectionStatus,
  LocalPackAssessment,
  LocalPackReadiness,
  LocalReport,
  LocationAssessment,
  LocationAssessmentStatus,
  NapAssessment,
  NapFieldAssessment,
  NapFieldStatus,
} from "./types";
