/**
 * schema-generation skill library — public API.
 *
 * Isolation-tested implementation (build step 0.2) behind
 * `.claude/skills/schema-generation/SKILL.md`. Pure TypeScript: no network,
 * no database, no side effects.
 *
 * Usage:
 *   const result = generateSchema({
 *     schemaType: "FAQPage",
 *     entity: { faqs: [{ question, answer }] },
 *     visiblePageText: renderedPageText,   // hard rule 1 — required
 *     brand: { organizationName: "…" },    // optional, from the locked brand kit
 *   });
 *   if (result.status === "ready") inject(result.scriptBlock); // via auto-fix engine only
 *   else review(result.errors, result.correspondence);
 */

export { generateSchema, serializeToScriptBlock } from "./generate";
export { aggregateSameAs, sameAsDedupeKey, SAME_AS_SOURCE_ORDER } from "./same-as";
export { normalizeVisibleText, verifyClaims } from "./text-match";
export type { VerificationOutcome } from "./text-match";

export type {
  // request / result contract
  SchemaGenerationRequest,
  SchemaGenerationResult,
  SchemaGenerationReady,
  SchemaGenerationRejected,
  GeneratableSchemaType,
  NestedOnlySchemaType,
  EntityInputMap,
  SchemaBrandContext,
  // validation + correspondence
  ValidationIssue,
  IssueCode,
  IssueSeverity,
  ClaimKind,
  ClaimSpec,
  CorrespondenceEntry,
  // JSON-LD
  JsonLdObject,
  JsonLdValue,
  JsonLdPrimitive,
  // shared value inputs
  PostalAddressInput,
  GeoCoordinatesInput,
  OpeningHoursInput,
  DayOfWeek,
  OfferInput,
  OfferAvailability,
  AggregateRatingValueInput,
  ReviewValueInput,
  // per-type entity inputs
  LocalBusinessInput,
  RestaurantInput,
  MenuInput,
  MenuSectionInput,
  MenuItemInput,
  ProductInput,
  FaqPageInput,
  FaqInput,
  ArticleInput,
  PersonInput,
  SameAsSources,
  RealEstateAgentInput,
  OrganizationInput,
  VideoObjectInput,
  PodcastSeriesInput,
  PodcastEpisodeInput,
  BreadcrumbListInput,
  BreadcrumbItemInput,
  ServiceInput,
  ItemListInput,
  ItemListEntryInput,
  EventInput,
  EventAttendanceMode,
  EventStatus,
  ReviewInput,
  AggregateRatingInput,
  ReviewedItemInput,
} from "./types";

export { NESTED_ONLY_SCHEMA_TYPES, DAYS_OF_WEEK } from "./types";
