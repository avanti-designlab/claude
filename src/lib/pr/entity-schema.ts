/**
 * M12 PR entity-leverage — entity SCHEMA production via M10 (doc 05 M12, doc 07
 * §1.7; task deliverable 1).
 *
 * M12 NEVER reimplements schema. It WRAPS M10's `produceSchema`
 * (src/lib/production/schema), which wraps the frozen schema-generation skill —
 * so the visible-text match gate applies UNCHANGED: a Person whose NAME the page
 * does not show, or an Organization whose NAME/phone the page does not show,
 * makes `produceSchema` return `rejected`, and a rejected result carries no
 * script block and can never reach the change-management write path. Feeding
 * that path is M10's `buildSchemaChange` (ready-only), re-exported so M12 adds
 * no bespoke write seam.
 *
 * `sameAs` GENUINENESS — THE HONEST BOUNDARY (task deliverable 1 + 4):
 * the skill treats every `sameAs`/press/profile URL as PASS-THROUGH — it is
 * validated as a real, resolvable http(s) URL, but it is NOT matched against the
 * page's visible text and, critically, on-page-match cannot verify that the
 * linked profile GENUINELY belongs to this entity (the same class of residual
 * as M10's per-review "genuineness" precondition — freeze-log 2026-07-09
 * precondition iii). So M12:
 *   - produces the Person/Organization schema with the caller-supplied
 *     `sameAs`/`sameAsSources` (the skill's documented contract), AND
 *   - attaches {@link SAME_AS_GENUINENESS_CAVEAT} to every ready result so the
 *     human approver knows each `sameAs` URL is ASSERTED, not verified, AND
 *   - surfaces which `sameAs` entries have NO on-page corroboration (the
 *     publication is not mentioned in the crawled visible text) via
 *     `uncorroboratedSameAs`, so an uncorroborated press link is flagged, never
 *     silently presented as established authority.
 * M12 never SYNTHESIZES a `sameAs` — it only aggregates URLs the client
 * genuinely supplied; press.ts corroborates them against the client's own page.
 *
 * Pure: no network, no database, no side effects (produceSchema emits at most
 * one redacted rejection log line — the M10 house contract).
 */

import type { ExtractedDoc } from "@/lib/intelligence/crawl";
import {
  buildSchemaChange,
  produceSchema,
  type SchemaBrandContext,
  type SchemaChangeSpec,
  type SchemaGenerationResult,
} from "@/lib/production/schema";
import type { OrganizationInput, PersonInput } from "@/lib/skills/schema-generation";
import { aggregateSameAs } from "@/lib/skills/schema-generation";
import { publicationLabel } from "./press";

// Re-export M10's ready-only change feed so callers shape a DesiredChange
// through the ONE authoritative seam — never a bespoke serializer.
export { buildSchemaChange, type SchemaChangeSpec };

/**
 * The load-bearing honesty flag on every entity-schema artifact carrying a
 * `sameAs`. It rides to the human approver + the content-quality/compliance
 * gates — the visible-text gate does NOT prove these profiles are genuinely this
 * entity's, so a human must confirm each before the schema publishes.
 */
export const SAME_AS_GENUINENESS_CAVEAT =
  "Each sameAs URL is asserted from the client's supplied press/profile list — it is validated as a " +
  "real URL and (where possible) corroborated against the page's visible text, but on-page matching " +
  "cannot verify the linked profile genuinely belongs to this entity. A human must confirm every " +
  "sameAs entry (and its ownership) before this schema is published.";

/** The entity types M12 produces (the two entity-resolution roots). */
export type EntitySchemaType = "Person" | "Organization";

export interface PersonSchemaInput {
  entityType: "Person";
  person: PersonInput;
}

export interface OrganizationSchemaInput {
  entityType: "Organization";
  organization: OrganizationInput;
}

export type EntityInput = PersonSchemaInput | OrganizationSchemaInput;

/**
 * The result of producing one entity schema: M10's discriminated result
 * UNCHANGED (source of truth), plus M12's honesty annotations.
 */
export interface EntitySchemaOutcome {
  entityType: EntitySchemaType;
  /** M10's result — `ready` (with scriptBlock + correspondence) or `rejected`. */
  result: SchemaGenerationResult;
  /** Deduped `sameAs` URLs this schema would assert (before the ready/rejected gate). */
  sameAs: string[];
  /** The always-attached genuineness caveat (see {@link SAME_AS_GENUINENESS_CAVEAT}). */
  sameAsGenuinenessCaveat: string;
  /**
   * `sameAs` URLs whose publication label does NOT appear in the crawled visible
   * text — flagged so an uncorroborated press link is never presented as
   * established on-page authority. `[]` when a corpus was supplied and all match,
   * or when no corpus was supplied to corroborate against.
   */
  uncorroboratedSameAs: string[];
}

/** Resolve the sameAs array a Person/Organization input would emit (skill's aggregation). */
function resolveSameAs(input: EntityInput): string[] {
  return input.entityType === "Person"
    ? aggregateSameAs(input.person.sameAsSources)
    : [...(input.organization.sameAs ?? [])];
}

/**
 * Which of the resolved `sameAs` URLs are NOT corroborated by the page's visible
 * text (their publication/domain label is absent). Corroboration is by TEXT
 * mention — the audit crawl drops off-origin hrefs, so link-level corroboration
 * is not available here (documented boundary in press.ts). With no corpus we
 * cannot corroborate, so nothing is flagged as uncorroborated (absence of a
 * corpus is not evidence against a link).
 */
function uncorroboratedSameAs(sameAs: string[], corpus: string | null): string[] {
  if (corpus === null) return [];
  const haystack = corpus.toLowerCase();
  return sameAs.filter((url) => {
    const label = publicationLabel(url);
    return label === null || !haystack.includes(label.toLowerCase());
  });
}

export interface ProduceEntitySchemaInput {
  entity: EntityInput;
  /** The page (or corpus) the schema will be injected on — gates the entity name/facts. */
  visible: ExtractedDoc | string;
  /**
   * The crawled visible-text corpus used ONLY to corroborate `sameAs` press
   * links (which the skill does not text-gate). Null = no corroboration signal.
   * Typically the same corpus as `visible` when that is a string.
   */
  corroborationCorpus?: string | null;
  brand?: SchemaBrandContext;
  referenceDate?: string;
}

/**
 * Produce (via M10) a Person or Organization entity schema, visible-text gated,
 * with the `sameAs`-genuineness honesty annotations attached. A `ready` result
 * carries a `scriptBlock` + `correspondence` and can be shaped into a
 * DesiredChange with {@link buildSchemaChange}; a `rejected` result names the
 * overclaims (an entity name the page doesn't show) and never reaches a write.
 */
export function produceEntitySchema(input: ProduceEntitySchemaInput): EntitySchemaOutcome {
  const sameAs = resolveSameAs(input.entity);
  const corpus = input.corroborationCorpus ?? (typeof input.visible === "string" ? input.visible : null);

  const result =
    input.entity.entityType === "Person"
      ? produceSchema({
          schemaType: "Person",
          entity: input.entity.person,
          visible: input.visible,
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
        })
      : produceSchema({
          schemaType: "Organization",
          entity: input.entity.organization,
          visible: input.visible,
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
        });

  return {
    entityType: input.entity.entityType,
    result,
    sameAs,
    sameAsGenuinenessCaveat: SAME_AS_GENUINENESS_CAVEAT,
    uncorroboratedSameAs: uncorroboratedSameAs(sameAs, corpus),
  };
}
