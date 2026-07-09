/**
 * M12 PR entity-leverage — public API (doc 05 M12, doc 07 §1.7).
 *
 * Turns a client's EXISTING press into entity signals: Person (+sameAs) +
 * Organization schema via M10's visible-text gate, an on-page entity/Press
 * surface assessment, prioritized entity-authority fixes into plans via the
 * audit-merge shape, and a HUMAN-ASSISTED outreach DRAFTER (no send path).
 * Honesty-first: absent/uncrawlable/uncorroborated is stated, never fabricated.
 *
 * Reuse boundaries (this module invents no core logic):
 *  - crawl + SSRF egress guard: src/lib/intelligence/crawl (`crawlSite`);
 *  - schema generation + visible-text gate + change-management feed: M10
 *    (src/lib/production/schema) — Person + Organization + sameAs aggregation;
 *  - the LLM generation port + grounding/voice/compliance guardrails: M8
 *    (src/lib/production/content) — the SAME deferred Anthropic seam;
 *  - plan-merge seam: src/lib/plan (audit-merge reads only `.fixes`).
 */

// The M12 fix + report contracts (module code "M12" — a valid roadmap ModuleRef).
export {
  M12_MODULE,
  type EntityFixDraft,
  type EntityAuthorityReport,
  type PersonEntityAssessment,
  type PersonAssessmentStatus,
  type PressSurfaceAssessment,
  type PressAssessmentStatus,
  type PressItemAssessment,
} from "./types";

// Entity schema production via M10 (visible-text gated) + the change-management feed
// + the sameAs-genuineness honesty caveat.
export {
  buildSchemaChange,
  produceEntitySchema,
  SAME_AS_GENUINENESS_CAVEAT,
  type EntityInput,
  type EntitySchemaOutcome,
  type EntitySchemaType,
  type OrganizationSchemaInput,
  type PersonSchemaInput,
  type ProduceEntitySchemaInput,
  type SchemaChangeSpec,
} from "./entity-schema";

// On-page entity mention + Press-section assessment (pure detection).
export {
  assessPersonEntity,
  assessPressSurface,
  buildEntityCorpus,
  detectPressSection,
  personSchemaSignals,
  publicationLabel,
  type AssessPersonInput,
  type AssessPressInput,
  type ClaimedPressItem,
} from "./press";

// M12-owned entity-authority fix builders.
export { personFixes, pressFixes } from "./fixes";

// The whole-client assessment orchestrator (crawl + person/press + entity schema).
export {
  assessEntityAuthority,
  type AssessEntityAuthorityInput,
  type AssessEntityAuthorityResult,
} from "./assess";

// Plan-merge seam — { fixes } into generatePlan, like M6/M4/M14.
export { entityFixes, entityPlanInput } from "./plan-input";

// New-PR outreach — human-assisted DRAFTER (pinned pre-approval, NO send path).
export {
  draftOutreachPitch,
  buildOutreachSpec,
  outreachGroundingFacts,
  OUTREACH_DRAFT_STATUS,
  OUTREACH_GENERATION_CONTENT_TYPE,
  OUTREACH_GENERATION_TYPE_GAP,
  type DraftOutreachInput,
  type DraftOutreachOutcome,
  type OutreachDraft,
  type OutreachDraftRequest,
  type OutreachReport,
} from "./outreach";

// Persistence (audits row w/ entity-authority discriminator) + history reads.
export {
  entityAuthorityHistoryEntry,
  entityAuthorityInsertRow,
  entityAuthorityScoreCapture,
  isEntityAuthorityScore,
  ENTITY_AUTHORITY_KIND,
  type EntityAuthorityHistoryEntry,
  type EntityAuthorityInsertRow,
  type EntityAuthorityScoreCapture,
} from "./rows";
export {
  logEntityFailure,
  persistEntityAuthority,
  readEntityAuthorityHistory,
  ENTITY_FAILURE_MARKER,
  ENTITY_HISTORY_MAX,
  ENTITY_SAVE_WARNING,
  type EntityFailureStage,
} from "./persist";
