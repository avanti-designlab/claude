/**
 * M10 schema generation — the production wrapper around the FROZEN
 * schema-generation skill (doc 05 M10, doc 07 §1.5; SKILL.md rule 4).
 *
 * This module WRAPS the skill; it never re-derives schema logic. Everything of
 * substance — generating validated JSON-LD per type, the visible-text match
 * gate (hard rule 1), and `</script>`-safe serialization — lives in
 * `src/lib/skills/schema-generation` and is invoked verbatim here. M10 adds
 * exactly three things:
 *   1. the crawl → skill bridge (`buildVisibleCorpus`, ./corpus): which rendered
 *      surfaces of a crawled page are "visible text";
 *   2. named surfacing of WHY a schema was rejected (`namedUnmatchedClaims`):
 *      the specific overclaims, so a reviewer sees exactly which fabricated
 *      fact to fix or delete;
 *   3. redacted rejection telemetry (house contract) — codes only, never the
 *      claim VALUE or page text.
 *
 * THE M10 SPINE (doc 07 explicit): schema must not assert a visibly-checkable
 * fact that is absent from the page's rendered content. A mismatch REJECTS the
 * schema — a rejected result carries NO script block and can never reach the
 * change-management write path (enforced by the skill's discriminated result +
 * the ready-only `buildSchemaChange` seam in ./change).
 *
 * CHECKABLE vs PASS-THROUGH (defined by the FROZEN skill's per-generator claim
 * registry; M10 documents and surfaces it, does not decide it):
 *  - CHECKABLE, error-severity (mismatch BLOCKS emission): FAQ question + answer,
 *    Product name + Offer price, Menu item name + price, Review body, reviewed-item
 *    name, business/org/agency/restaurant name + phone, Person name, Article
 *    headline + author, breadcrumb/list-item names, Video/Service/Podcast/Event
 *    names, Event venue, aggregate RATING VALUE + reviewCount + ratingCount
 *    (error-gated by the 2026-07-09 frozen-skill tightening — see RESOLVED below).
 *  - CHECKABLE, warning-severity (mismatch FLAGS in correspondence, does NOT block):
 *    street + locality, all descriptions, job title, cuisine, menu-section name,
 *    review author, transcript.
 *  - PASS-THROUGH (NOT text-matched — no reliable visible-text equivalent):
 *    `sameAs` and every URL (contentUrl/embedUrl/thumbnail/image/logo/authorUrl);
 *    all dates (datePublished/dateModified/uploadDate/start/end — sanity-validated
 *    for order + future in the skill, but rendered date formats can't be matched to
 *    ISO deterministically); an INDIVIDUAL review's star rating (its body is already
 *    error-gated, and single-review ratings render as glyphs/words far more often
 *    than digits, so gating them would false-reject legit markup); durations, geo
 *    coordinates, currency/availability enums, priceRange, SKU/GTIN, opening hours,
 *    dietary tokens, rating bounds.
 *
 * RESOLVED DIVERGENCE (frozen-skill tightening 2026-07-09, Orchestrator-authorized
 * per CLAUDE.md rule 1; Code Review re-review + freeze-log follow): the aggregate
 * reviewCount / ratingCount / rating VALUE were previously PASS-THROUGH or
 * warning-only — so a page showing only a product/business name could emit
 * `AggregateRating{ratingValue:4.9, reviewCount:5123}` and return "ready".
 * Governing basis: doc 05 M10 ("schema must match visible page text exactly —
 * mismatch = manual-action risk") + fabricated-review FTC exposure. They are now
 * error-severity, digit-matched claims (thousands-separator tolerant, so "5123"
 * matches a page rendering "5,123"): a fabricated count or rating REJECTS with the
 * claim named; a genuinely-rendered one still passes.
 *
 * Pure: no network, no database, no side effects beyond one redacted log line on
 * rejection (same discipline as src/lib/intelligence/audit/persist.ts).
 */

import {
  generateSchema,
  type EntityInputMap,
  type GeneratableSchemaType,
  type SchemaBrandContext,
  type SchemaGenerationResult,
  type ValidationIssue,
} from "@/lib/skills/schema-generation";
import type { ExtractedDoc } from "@/lib/intelligence/crawl";
import { buildVisibleCorpus } from "./corpus";

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/**
 * A schema production request. Mirrors the skill's `SchemaGenerationRequest`
 * but replaces `visiblePageText` with `visible` — a crawl-layer `ExtractedDoc`
 * (the normal path) or raw rendered text — so callers hand M10 a page, not a
 * pre-flattened string. The match corpus is built here (./corpus).
 */
export interface SchemaProductionInput<
  T extends GeneratableSchemaType = GeneratableSchemaType,
> {
  schemaType: T;
  entity: EntityInputMap[T];
  /** The page whose rendered text the schema must match — crawl doc or raw text. */
  visible: ExtractedDoc | string;
  /** Client brand context from the locked brand kit (publisher/brand defaults). */
  brand?: SchemaBrandContext;
  /** Injected "now" for the skill's future-date sanity check (deterministic tests). */
  referenceDate?: string;
}

/* ------------------------------------------------------------------ */
/* Redacted rejection telemetry (house contract — audit/persist.ts)    */
/* ------------------------------------------------------------------ */

/**
 * A visible-text mismatch is the gate working as DESIGNED, not a fault — but the
 * CONTENT of the mismatch (the unmatched claim, the page text) is client data
 * and must never ride into a hosted log (secrets-in-logs rule is absolute,
 * docs/ops/environments.md §Secrets rules). Every rejection emits exactly ONE
 * redacted line carrying ONLY:
 *   - the stable marker below (greppable in hosted logs),
 *   - the schema type, sanitized to a bare identifier (closed set in practice),
 *   - the DISTINCT issue codes (closed `IssueCode` enum — never free text),
 *   - the error count.
 * NEVER the claim value, page text, entity data, path, or any tenant/client id.
 */
export const SCHEMA_REJECTION_MARKER = "[schema-production-rejected]";

/**
 * Reduce the schema type to a safe log token: schema type names are PascalCase
 * identifiers, so anything that is not a short alphanumeric token collapses to
 * "other" — no data can ride into the log line even through a smuggled type.
 */
function redactType(schemaType: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(schemaType) ? schemaType : "other";
}

function logSchemaRejection(schemaType: string, errors: ValidationIssue[]): void {
  const codes = [...new Set(errors.map((e) => e.code))].sort().join(",");
  console.error(
    `${SCHEMA_REJECTION_MARKER} type=${redactType(schemaType)} codes=${codes} count=${errors.length}`,
  );
}

/* ------------------------------------------------------------------ */
/* produceSchema                                                       */
/* ------------------------------------------------------------------ */

/**
 * Produce validated, injection-safe JSON-LD for a page, gated on the visible
 * text. Returns the skill's discriminated result UNCHANGED (source of truth —
 * no re-wrap, no drift):
 *   - `status: "ready"` — `jsonLd` (object) + `scriptBlock` (`</script>`-safe)
 *     + `correspondence` (claim → evidence) are ready for the change-management
 *     write path via {@link buildSchemaChange}.
 *   - `status: "rejected"` — NO script block; `errors` name the mismatches (see
 *     {@link namedUnmatchedClaims}). One redacted telemetry line is emitted.
 *
 * Does NOT publish, persist, or write anything — it produces the reviewed
 * artifact. Injection itself goes through the change-management layer (doc 04).
 */
export function produceSchema<T extends GeneratableSchemaType>(
  input: SchemaProductionInput<T>,
): SchemaGenerationResult {
  const visiblePageText = buildVisibleCorpus(input.visible);

  const result = generateSchema<T>({
    schemaType: input.schemaType,
    entity: input.entity,
    visiblePageText,
    brand: input.brand,
    referenceDate: input.referenceDate,
  });

  if (result.status === "rejected") {
    logSchemaRejection(result.schemaType, result.errors);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* namedUnmatchedClaims                                                */
/* ------------------------------------------------------------------ */

/** One overclaim the gate refused: a fact the schema asserts but the page does not show. */
export interface NamedUnmatchedClaim {
  /** JSON-LD path of the claim, e.g. "mainEntity[2].acceptedAnswer.text". */
  path: string;
  /** Human label, e.g. "FAQ answer #3", "Offer price". */
  label: string;
  /** The claimed value that could not be found in the visible text. */
  claim: string;
  /** How it was matched ("text" | "price" | "number" | "phone"). */
  kind: string;
}

/**
 * The specific claims that BLOCKED the schema — the named reasons for a
 * rejection (doc 07 M10: "reject with the specific unmatched claim named").
 * Derived from the correspondence report: error-severity claims that did not
 * match. Returns `[]` for a ready result (a ready result has no blocking
 * mismatch by definition). Warning-severity mismatches are visible in
 * `result.correspondence` for reviewers but never block, so they are excluded
 * here.
 */
export function namedUnmatchedClaims(
  result: SchemaGenerationResult,
): NamedUnmatchedClaim[] {
  return result.correspondence
    .filter((entry) => !entry.matched && entry.severity === "error")
    .map((entry) => ({
      path: entry.path,
      label: entry.label,
      claim: entry.claim,
      kind: entry.kind,
    }));
}
