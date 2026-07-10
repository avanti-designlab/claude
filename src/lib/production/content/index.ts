/**
 * M8 Content Production — public API (doc 05 Part B, doc 07 §1.5).
 *
 * The GENERATE step of the brand-consistent production pipeline. Joins M7
 * (brand-kit) and M10 (schema) under `src/lib/production/`. M8 imports M7's
 * locked-kit read API and the playbooks + compliance-ruleset skills READ-ONLY;
 * it stays out of brand-kit/ (M7) and schema/ (M10).
 *
 * THE PIPELINE, AND M8's ONE STEP (doc 05):
 *   Generate (M8) → Humanize (M9) → Detect (M9) → Content Quality → Compliance
 *   → Schema (M10) → Publish (via 1.2/1.3 change-management + human approve).
 * M8 owns Generate ONLY. A produced draft lands at a PRE-APPROVAL status and
 * cannot self-approve (CLAUDE.md rule 5): it carries no review verdict, so the
 * DB CHECK `content_items_reviewed_before_approval` (migration 0005) makes
 * approved/published structurally unreachable until BOTH independent gates —
 * content-quality AND compliance-review — record their verdicts.
 *
 * GATES NOW vs AT WIRING TIME (flagged like the write-methods live-connect
 * canaries): Code Review reviews this build now. The HARD gates (Content Quality
 * + Compliance Review) review the guardrails/pipeline now, and the actual
 * generated OUTPUT once the Anthropic adapter is wired with a real
 * ANTHROPIC_API_KEY (DEFERRED — see ./live-provider). Until then generation
 * fails closed with `generation_unavailable`.
 *
 * PERSISTENCE HONESTY (against the FROZEN 0005 schema):
 *  - `content_items` is CLIENT-scoped (no `property_id` column). A property can
 *    be part of the generation *input material*, but it is NOT a persisted or
 *    filterable dimension on this table — the read API is client-scoped. Adding
 *    per-property content scoping would be a data-model decision (post-freeze
 *    Orchestrator + Code Review path), flagged by `CONTENT_PROPERTY_SCOPE_GAP`.
 *  - There is no first-class column for M8's generation-time guardrail
 *    annotations (the grounding + compliance-pre-screen flags). They ride in the
 *    `GenerationReport` RETURNED by `createContentDraft` (consumed by the
 *    immediate orchestration + the review gates); the reviewer-time re-derivable
 *    part (compliance pre-screen) is recomputable from the stored body. A
 *    dedicated `content_items.generation_report` jsonb is the cleaner long-term
 *    home — post-freeze path, flagged by `CONTENT_GENERATION_REPORT_GAP`.
 */

/** Stable schema-gap flags (greppable by the Orchestrator/docs agent — M3/M10 precedent). */
export const CONTENT_PROPERTY_SCOPE_GAP =
  "content_items has no property_id column (migration 0005); M8 content is client-scoped. " +
  "Per-property content scoping would need a data-model change — post-freeze Orchestrator + Code Review path.";

export const CONTENT_GENERATION_REPORT_GAP =
  "content_items has no column for M8's generation-time guardrail report (grounding + compliance " +
  "pre-screen flags); it rides in the GenerationReport returned by createContentDraft. A dedicated " +
  "content_items.generation_report jsonb is the proposed post-freeze home.";

// The LLM PORT + scriptable fake (the vendor-deferred seam). The real Anthropic
// adapter lands in ./live-provider at wiring time, behind this port.
export {
  type ContentGenerationProvider,
  ScriptedContentProvider,
  type ContentScript,
} from "./provider";

// Core generator (pure; provider injected) + its report/outcome contracts.
export {
  generateContentDraft,
  type GenerateContentInput,
  type GenerateContentOutcome,
  type GenerationReport,
} from "./generate";

// The constrain seam (voice + playbook + compliance → spec) — reused by tests/callers.
export {
  buildGenerationSpec,
  deriveComplianceGuardrails,
  pickTargetPrompt,
  toComplianceContentType,
  type DraftRequest,
} from "./constrain";

// The anti-fabrication grounding pass + voice.dont screen + AEO-formatting check
// + the compliance pre-screen (its summary shape + summarizer shared with M9).
export {
  findUngroundedClaims,
  findBannedVoicePhrases,
  evaluateAeoFormatting,
  screenCompliance,
  summarizeCompliancePrescreen,
  type UngroundedClaim,
  type BannedVoicePhrase,
  type AeoFormattingFinding,
  type CompliancePrescreen,
} from "./ground";

// Row mapping + read shapes (the pre-approval insert-row builder + the pinned literals).
export {
  contentDraftInsertRow,
  contentDraftSummary,
  contentDraftDetail,
  M8_INITIAL_STATUS,
  M8_AUTOMATION_LEVEL,
  CONTENT_PREVIEW_CHARS,
  type ContentItemInsertRow,
  type ContentDraftSummary,
  type ContentDraftDetail,
  type DraftPipelineState,
} from "./rows";

// Content types M8 generates + the server-authoritative input clamps.
export {
  GENERATABLE_CONTENT_TYPES,
  GROUNDING_FACT_MAX,
  GROUNDING_FACTS_MAX,
  isGeneratableContentType,
  TOPIC_MAX,
  type GeneratableContentType,
  type ContentGenerationSpec,
  type ContentGenerationResult,
  type VoiceConstraint,
  type PlaybookContentMapping,
} from "./types";
