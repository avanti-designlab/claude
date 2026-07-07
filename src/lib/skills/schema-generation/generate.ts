/**
 * generateSchema — the public entry point of the schema-generation skill library.
 *
 * Pipeline (all pure, no I/O):
 *   1. dispatch to the type generator → draft JSON-LD node + registered claims
 *      + structural issues (required properties, URLs, dates, ratings, prices)
 *   2. verify every user-visible claim against `visiblePageText` (hard rule 1)
 *   3. errors present → status "rejected" (draft only, NO script block — a
 *      rejected result can never reach the auto-fix engine)
 *      no errors → status "ready" with the serialized
 *      `<script type="application/ld+json">` block + correspondence report
 *
 * Injection itself is out of scope here: ready blocks go through the auto-fix
 * engine's change-management layer (doc 04), never hand-pasted.
 */

import type {
  CorrespondenceEntry,
  EntityInputMap,
  GeneratableSchemaType,
  JsonLdObject,
  SchemaBrandContext,
  SchemaGenerationRequest,
  SchemaGenerationResult,
  ValidationIssue,
} from "./types";
import { NESTED_ONLY_SCHEMA_TYPES } from "./types";
import { issue } from "./validate";
import { verifyClaims } from "./text-match";
import type { GeneratorOutput } from "./internal";
import {
  generateLocalBusiness,
  generateOrganization,
  generateRealEstateAgent,
  generateRestaurant,
} from "./generators-business";
import {
  generateArticle,
  generateFaqPage,
  generatePerson,
  generatePodcastEpisode,
  generatePodcastSeries,
  generateVideoObject,
} from "./generators-content";
import {
  generateAggregateRating,
  generateBreadcrumbList,
  generateEvent,
  generateItemList,
  generateProduct,
  generateReview,
  generateService,
} from "./generators-commerce";

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

type GeneratorFn<T extends GeneratableSchemaType> = (
  entity: EntityInputMap[T],
  brand?: SchemaBrandContext,
) => GeneratorOutput;

const GENERATORS: { [T in GeneratableSchemaType]: GeneratorFn<T> } = {
  LocalBusiness: (entity) => generateLocalBusiness(entity, "LocalBusiness"),
  Store: (entity) => generateLocalBusiness(entity, "Store"),
  Restaurant: (entity) => generateRestaurant(entity),
  Product: (entity, brand) => generateProduct(entity, brand),
  FAQPage: (entity) => generateFaqPage(entity),
  Article: (entity, brand) => generateArticle(entity, brand),
  Person: (entity) => generatePerson(entity),
  RealEstateAgent: (entity) => generateRealEstateAgent(entity),
  Organization: (entity) => generateOrganization(entity, "Organization"),
  InsuranceAgency: (entity) => generateOrganization(entity, "InsuranceAgency"),
  VideoObject: (entity) => generateVideoObject(entity),
  PodcastSeries: (entity) => generatePodcastSeries(entity),
  PodcastEpisode: (entity) => generatePodcastEpisode(entity),
  BreadcrumbList: (entity) => generateBreadcrumbList(entity),
  Service: (entity) => generateService(entity),
  ItemList: (entity) => generateItemList(entity),
  Event: (entity) => generateEvent(entity),
  Review: (entity) => generateReview(entity),
  AggregateRating: (entity) => generateAggregateRating(entity),
};

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Serializes to a single `<script type="application/ld+json">` block
 * (SKILL.md rule 3). Every "<" is escaped to its \\u003c JSON form so embedded
 * content can never close the script tag early.
 */
export function serializeToScriptBlock(jsonLd: JsonLdObject): string {
  const json = JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function generateSchema<T extends GeneratableSchemaType>(
  request: SchemaGenerationRequest<T>,
): SchemaGenerationResult {
  const { schemaType, visiblePageText } = request;

  // Runtime guard for nested-only or unknown types smuggled past the compiler.
  const generator = (GENERATORS as Record<string, GeneratorFn<T> | undefined>)[schemaType];
  if (generator === undefined) {
    const isNestedOnly = (NESTED_ONLY_SCHEMA_TYPES as readonly string[]).includes(schemaType);
    return {
      status: "rejected",
      schemaType,
      errors: [
        issue(
          "UNSUPPORTED_ROOT_TYPE",
          "error",
          "@type",
          isNestedOnly
            ? `"${schemaType}" is nested-only — it is emitted inside its parent entity (e.g. Product for Offer/Brand, Restaurant for Menu/MenuItem), never as a root node.`
            : `"${schemaType}" is not a schema type this skill can generate.`,
        ),
      ],
      warnings: [],
      correspondence: [],
    };
  }

  const { node, claims, issues } = generator(request.entity, request.brand);
  const jsonLd: JsonLdObject = { "@context": "https://schema.org", ...node };

  let correspondence: CorrespondenceEntry[] = [];
  if (visiblePageText === undefined || visiblePageText.trim() === "") {
    issues.push(
      issue(
        "EMPTY_VISIBLE_TEXT",
        "error",
        "",
        "visiblePageText is required: schema must match the visible page text exactly (hard rule 1), so generation cannot proceed without the rendered page text to verify against.",
      ),
    );
  } else {
    const verified = verifyClaims(claims, visiblePageText);
    correspondence = verified.correspondence;
    issues.push(...verified.issues);
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const item of issues) {
    (item.severity === "error" ? errors : warnings).push(item);
  }

  if (errors.length > 0) {
    return {
      status: "rejected",
      schemaType,
      errors,
      warnings,
      correspondence,
      draftJsonLd: jsonLd,
    };
  }

  return {
    status: "ready",
    schemaType,
    jsonLd,
    scriptBlock: serializeToScriptBlock(jsonLd),
    correspondence,
    warnings,
  };
}
