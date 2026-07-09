/**
 * M10 Schema generation — public API (doc 05 M10, doc 07 §1.5).
 *
 * The production wrapper around the FROZEN `schema-generation` skill. It WRAPS
 * the skill (never reimplements it): generation, the visible-text match gate,
 * and `</script>`-safe serialization are the skill's; M10 adds the crawl → skill
 * visible-text bridge, named rejection reasons, redacted telemetry, and the
 * change-management feed. Joins M7 under `src/lib/production/` (brand-kit is the
 * sibling — M10 imports its read API only if it needs org identity, which schema
 * from structured entity data does not).
 *
 * PERSISTENCE DECISION (honest, against the FROZEN schema 0005):
 *   Generated JSON-LD has NO M10-owned table, and correctly so.
 *   - `content_items` is PROSE (body TEXT NOT NULL, humanization, brand_kit_id
 *     NOT NULL, type ∈ blog/faq/caption/pillar/schema_copy). An assembled JSON-LD
 *     block is a mechanical serialization of already-on-page facts — not
 *     humanized, not brand-voiced. (`schema_copy` is human-readable COPY that
 *     FEEDS schema and goes through humanization + quality + compliance — the M8
 *     path — not the assembled block.) Forcing JSON-LD into `body` with a
 *     stand-in brand_kit_id would be a misfit.
 *   - The block's natural home is a `site_changes` row (change_type='schema'),
 *     created by the change-management pipeline at PREVIEW — NOT by M10 (which is
 *     explicitly barred from wiring the publish). M10 produces the artifact
 *     on-demand and shapes it into a `DesiredChange` (./change); the pipeline
 *     persists the previewed row.
 *   FLAGGED GAP (M3 precedent, no build): there is no first-class store for
 *   "generated schema, reviewed, not yet staged as a write" — content_items is
 *   prose-shaped, site_changes only exists at PREVIEW. This is correct for the
 *   current flow (schema is produced right before the preview, not cached); a
 *   future schema BACKLOG would need a data-model decision. Also inherited: the
 *   `SchemaBrandContext` gap the skill flagged (src/lib/types/brand.ts carries no
 *   org identity — name/logo/site URL).
 */

// GATING NOTE (frozen-skill tightening 2026-07-09, Orchestrator-authorized per
// CLAUDE.md rule 1): the aggregate reviewCount, ratingCount, and rating VALUE are
// now ERROR-gated visible-text claims — a fabricated review count/rating REJECTS
// (claim named), a genuinely-rendered one passes (matcher tolerates the "5,123"
// thousands comma). An individual review's star rating stays pass-through (its
// body is already error-gated). Basis: doc 05 M10 + fabricated-review FTC
// exposure. See ./produce's CHECKABLE / RESOLVED DIVERGENCE note.

// Produce — the skill wrapper + the crawl → skill bridge + rejection surfacing.
export {
  produceSchema,
  namedUnmatchedClaims,
  SCHEMA_REJECTION_MARKER,
  type SchemaProductionInput,
  type NamedUnmatchedClaim,
} from "./produce";

// The crawl → skill visible-text bridge (which surfaces count as "visible").
export { buildVisibleCorpus } from "./corpus";

// The change-management feed — ready-only DesiredChange shaping.
export { buildSchemaChange, type SchemaChangeSpec } from "./change";

// Re-export the skill's result contract + its ONE safe serializer, so callers
// consume schema through M10 without reaching past it into the skill — and never
// hand-roll JSON-LD serialization (breakout-proofing lives in the skill).
export {
  serializeToScriptBlock,
  type SchemaGenerationResult,
  type SchemaGenerationReady,
  type SchemaGenerationRejected,
  type GeneratableSchemaType,
  type EntityInputMap,
  type SchemaBrandContext,
  type CorrespondenceEntry,
  type ValidationIssue,
} from "@/lib/skills/schema-generation";
