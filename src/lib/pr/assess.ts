/**
 * M12 PR entity-leverage — entity-authority assessment orchestrator
 * (doc 05 M12, doc 07 §1.7).
 *
 * Ties the pure pieces together for a client:
 *   1. ONE crawl of the site via `crawlSite` — REUSING the shared SSRF egress
 *      guard (this module NEVER bypasses crawlSite to reach a client URL);
 *   2. detect the on-page person surface (name in visible text, existing Person
 *      JSON-LD + sameAs) and the Press / "As Featured In" surface;
 *   3. corroborate each supplied press item against the page's own visible text;
 *   4. produce the Person (+sameAs) and Organization entity schema via M10 (the
 *      visible-text gate — a name the page doesn't show is rejected), with the
 *      sameAs-genuineness honesty annotations attached;
 *   5. project prioritized-later entity-authority fixes.
 *
 * HONESTY: an uncrawlable site yields `assessable: false` with every on-site
 * verdict withheld — never a fabricated "no authority" score.
 *
 * Determinism: given the same FetchPort responses and the same `crawledAt`, the
 * whole report is byte-identical (the only impure inputs are the injected
 * FetchPort + DNS resolver ports). Production wires the live ports behind the
 * same seam the audit + local engines use; tests pass a ScriptedFetch + a fake
 * resolver.
 */

import { crawlSite, type CrawlBounds, type ResolvePort } from "@/lib/intelligence/crawl";
import type { SchemaBrandContext } from "@/lib/production/schema";
import type { OrganizationInput, PersonInput } from "@/lib/skills/schema-generation";
import type { Playbook } from "@/lib/types/playbook";
import type { FetchPort } from "@/lib/write-methods/shared";
import { produceEntitySchema, type EntitySchemaOutcome } from "./entity-schema";
import { personFixes, pressFixes } from "./fixes";
import {
  assessPersonEntity,
  assessPressSurface,
  buildEntityCorpus,
  detectPressSection,
  personSchemaSignals,
  type ClaimedPressItem,
} from "./press";
import type { EntityAuthorityReport, EntityFixDraft } from "./types";

export interface AssessEntityAuthorityInput {
  fetchPort: FetchPort;
  /** Injected DNS resolver for the crawler's SSRF egress guard — REQUIRED. */
  resolvePort: ResolvePort;
  /** Absolute http(s) URL of the client's website property (caller-validated). */
  startUrl: string;
  playbook: Playbook;
  /**
   * The key person (founder/principal) as a Person schema input — carries
   * `sameAsSources` (press/profiles/credential registries). Null when no key
   * person is on record (the person surface is then reported `no_key_person`).
   */
  keyPerson?: PersonInput | null;
  /** The client organization as an Organization schema input. Null when not supplied. */
  organization?: OrganizationInput | null;
  /**
   * Claimed press items (publication + article URL) — corroborated against the
   * page's own visible text for the press surface. Operator-entered, never a secret.
   */
  claimedPress?: ClaimedPressItem[];
  /** ISO timestamp for the crawl + report (determinism). */
  crawledAt: string;
  brand?: SchemaBrandContext;
  bounds?: Partial<CrawlBounds>;
  referenceDate?: string;
}

export interface AssessEntityAuthorityResult {
  report: EntityAuthorityReport;
  /** The produced entity schema artifacts (ready → feed buildSchemaChange; rejected → named overclaims). */
  schema: {
    person: EntitySchemaOutcome | null;
    organization: EntitySchemaOutcome | null;
  };
}

export async function assessEntityAuthority(
  input: AssessEntityAuthorityInput,
): Promise<AssessEntityAuthorityResult> {
  // ONE crawl, reusing the shared egress guard — never a bespoke fetch.
  const { site, coverage } = await crawlSite({
    fetchPort: input.fetchPort,
    resolvePort: input.resolvePort,
    startUrl: input.startUrl,
    crawledAt: input.crawledAt,
    bounds: input.bounds,
  });

  const corpusAssessable = site.pages.length > 0;
  const corpus = buildEntityCorpus(site);
  const personSchema = personSchemaSignals(site);
  const claimedPress = input.claimedPress ?? [];

  const person = assessPersonEntity({
    keyPersonName: input.keyPerson?.name ?? null,
    corpus,
    corpusAssessable,
    personSchema,
  });
  const press = assessPressSurface({
    claimedPress,
    corpus,
    corpusAssessable,
    pressSectionPresent: corpusAssessable ? detectPressSection(site) : false,
  });

  // Produce the entity schema through M10's visible-text gate (only when a
  // crawlable corpus exists to gate against — otherwise no honest schema attempt).
  const personSchemaOutcome: EntitySchemaOutcome | null =
    corpusAssessable && input.keyPerson != null
      ? produceEntitySchema({
          entity: { entityType: "Person", person: input.keyPerson },
          visible: corpus,
          corroborationCorpus: corpus,
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
        })
      : null;

  const orgSchemaOutcome: EntitySchemaOutcome | null =
    corpusAssessable && input.organization != null
      ? produceEntitySchema({
          entity: { entityType: "Organization", organization: input.organization },
          visible: corpus,
          corroborationCorpus: corpus,
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
        })
      : null;

  const fixes: EntityFixDraft[] = [
    ...personFixes(person, personSchemaOutcome),
    ...pressFixes(press),
  ];

  const report: EntityAuthorityReport = {
    vertical: input.playbook.vertical,
    crawledAt: input.crawledAt,
    assessable: corpusAssessable,
    person,
    press,
    coverage,
    fixes,
  };

  return { report, schema: { person: personSchemaOutcome, organization: orgSchemaOutcome } };
}
