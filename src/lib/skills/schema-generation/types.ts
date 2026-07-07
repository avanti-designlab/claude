/**
 * schema-generation skill — typed input models + the generation contract.
 *
 * Implements the isolation-tested library behind `.claude/skills/schema-generation/SKILL.md`
 * (build step 0.2). Hard rules encoded here as first-class contracts:
 *
 *  1. Schema must match the visible page text exactly (SKILL.md rule 1, doc 05 M10).
 *     The caller MUST pass `visiblePageText`; every user-visible claim encoded in the
 *     JSON-LD is verified against it, and `generateSchema` refuses to emit a
 *     ready-for-injection result while error-severity mismatches exist.
 *  2. Person.sameAs aggregates ALL provided press/profile URLs — deduplicated,
 *     order-stable (SKILL.md rule 2).
 *  3. Dates reflect real events only — this library never invents or defaults dates
 *     (SKILL.md rule 5, doc 05 M6).
 *
 * Pure TypeScript: no network, no database, no side effects.
 */

import type { SchemaTypeName } from "@/lib/types/playbook";

/* ------------------------------------------------------------------ */
/* JSON-LD                                                             */
/* ------------------------------------------------------------------ */

export type JsonLdPrimitive = string | number | boolean;
export type JsonLdValue = JsonLdPrimitive | JsonLdObject | JsonLdValue[];
export interface JsonLdObject {
  [key: string]: JsonLdValue | undefined;
}

/* ------------------------------------------------------------------ */
/* Validation issues                                                   */
/* ------------------------------------------------------------------ */

export type IssueCode =
  /** A required property (schema.org / Google rich-results) is missing or empty. */
  | "MISSING_REQUIRED"
  /** A recommended property is missing — never blocks, always a warning. */
  | "MISSING_RECOMMENDED"
  /** `visiblePageText` was empty — the match contract cannot be verified. */
  | "EMPTY_VISIBLE_TEXT"
  /** An encoded claim does not appear in the visible page text (manual-action risk). */
  | "TEXT_MISMATCH"
  | "INVALID_URL"
  | "INVALID_DATE"
  /** dateModified before datePublished / endDate before startDate. */
  | "DATE_ORDER"
  | "FUTURE_DATE"
  | "INVALID_DURATION"
  | "INVALID_TIME"
  | "INVALID_DAY_OF_WEEK"
  | "INVALID_GEO"
  | "INVALID_PRICE"
  | "INVALID_CURRENCY"
  | "INVALID_COUNT"
  | "RATING_OUT_OF_RANGE"
  | "HEADLINE_TOO_LONG"
  /** Person emitted without any sameAs URLs — weakest possible entity signal. */
  | "WEAK_ENTITY_SIGNAL"
  /** Type is nested-only (Offer/Menu/MenuItem/Brand) or unknown — cannot be a root node. */
  | "UNSUPPORTED_ROOT_TYPE";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  code: IssueCode;
  severity: IssueSeverity;
  /** Dot/bracket path into the JSON-LD draft, e.g. "mainEntity[2].acceptedAnswer.text". */
  path: string;
  message: string;
  /** For TEXT_MISMATCH: the visible-text claim that could not be found on the page. */
  claim?: string;
}

/* ------------------------------------------------------------------ */
/* Visible-text claims + correspondence report                         */
/* ------------------------------------------------------------------ */

/**
 * How a claim is matched against the visible page text:
 * - "text":   normalized substring match (case/whitespace/typographic-quote insensitive)
 * - "price":  numeric match with digit boundaries ("24.99" matches "$24.99", not "124.99";
 *             integer prices also match their ".00" rendering and vice versa)
 * - "number": same digit-boundary matching, used for visible rating values
 * - "phone":  digit-sequence match tolerant of separators/parentheses; falls back to the
 *             last 10 digits so "+1-619-555-0143" matches "(619) 555-0143"
 */
export type ClaimKind = "text" | "price" | "number" | "phone";

/** A user-visible claim encoded in the JSON-LD that must exist in the page text. */
export interface ClaimSpec {
  /** Where in the JSON-LD the claim lives. */
  path: string;
  /** Human-readable label, e.g. "FAQ question #2". */
  label: string;
  /** The claimed value as encoded. */
  value: string;
  kind: ClaimKind;
  /** "error" claims block emission on mismatch; "warning" claims only flag. */
  severity: IssueSeverity;
}

/** One line of the correspondence report handed to Code Review / Content Quality. */
export interface CorrespondenceEntry {
  path: string;
  label: string;
  claim: string;
  kind: ClaimKind;
  severity: IssueSeverity;
  matched: boolean;
  /** Normalized page-text excerpt around the match (present when matched). */
  evidence?: string;
}

/* ------------------------------------------------------------------ */
/* Shared value inputs                                                 */
/* ------------------------------------------------------------------ */

export interface PostalAddressInput {
  streetAddress: string;
  addressLocality: string;
  addressRegion?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 preferred (e.g. "US", "AE"). */
  addressCountry: string;
}

export interface GeoCoordinatesInput {
  latitude: number;
  longitude: number;
}

export const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export interface OpeningHoursInput {
  dayOfWeek: DayOfWeek[];
  /** "HH:MM" 24h. */
  opens: string;
  /** "HH:MM" 24h. */
  closes: string;
}

export type OfferAvailability =
  | "InStock"
  | "OutOfStock"
  | "PreOrder"
  | "BackOrder"
  | "SoldOut"
  | "OnlineOnly"
  | "InStoreOnly"
  | "LimitedAvailability"
  | "Discontinued";

export interface OfferInput {
  /** Numeric price. Strings must be plain decimals ("24.99") — no currency symbols. */
  price: number | string;
  /** ISO 4217, e.g. "USD", "AED". */
  priceCurrency: string;
  availability?: OfferAvailability;
  url?: string;
  priceValidUntil?: string;
}

export interface AggregateRatingValueInput {
  ratingValue: number;
  reviewCount?: number;
  ratingCount?: number;
  /** Defaults to 5 in the emitted node when omitted. */
  bestRating?: number;
  /** Defaults to 1 in the emitted node when omitted. */
  worstRating?: number;
}

export interface ReviewValueInput {
  author: string;
  reviewBody: string;
  ratingValue: number;
  bestRating?: number;
  worstRating?: number;
  datePublished?: string;
}

/* ------------------------------------------------------------------ */
/* Per-type entity inputs                                              */
/* ------------------------------------------------------------------ */

/** LocalBusiness — also used for `Store` (cannabis dispensaries, doc 02 §2.1). */
export interface LocalBusinessInput {
  name: string;
  address: PostalAddressInput;
  url?: string;
  telephone?: string;
  description?: string;
  geo?: GeoCoordinatesInput;
  openingHours?: OpeningHoursInput[];
  /** e.g. "$$" — not text-verified (rarely rendered literally). */
  priceRange?: string;
  image?: string[];
  sameAs?: string[];
}

export interface MenuItemInput {
  name: string;
  description?: string;
  price?: number | string;
  priceCurrency?: string;
  /**
   * schema.org RestrictedDiet tokens ("Vegan", "GlutenFree", "Vegetarian", "Halal",
   * "Kosher", ...) or full schema.org URLs.
   */
  suitableForDiet?: string[];
}

export interface MenuSectionInput {
  name: string;
  items: MenuItemInput[];
}

export interface MenuInput {
  url?: string;
  sections: MenuSectionInput[];
}

export interface RestaurantInput extends LocalBusinessInput {
  menu: MenuInput;
  servesCuisine?: string[];
  /** true/false, or a reservations URL. */
  acceptsReservations?: boolean | string;
  aggregateRating?: AggregateRatingValueInput;
}

export interface ProductInput {
  name: string;
  description?: string;
  image?: string[];
  sku?: string;
  gtin?: string;
  /** Falls back to the brand context's organizationName when omitted. */
  brandName?: string;
  url?: string;
  offer?: OfferInput;
  aggregateRating?: AggregateRatingValueInput;
  reviews?: ReviewValueInput[];
}

export interface FaqInput {
  question: string;
  answer: string;
}

export interface FaqPageInput {
  faqs: FaqInput[];
  url?: string;
}

export interface ArticleInput {
  headline: string;
  authorName: string;
  /** Real publication date — never invented by this library. */
  datePublished: string;
  /** Only when real edits were made (doc 05 M6). Never defaulted. */
  dateModified?: string;
  description?: string;
  authorUrl?: string;
  image?: string[];
  url?: string;
  /** Falls back to the brand context's organizationName when omitted. */
  publisherName?: string;
  /** Falls back to the brand context's logoUrl when omitted. */
  publisherLogoUrl?: string;
}

/**
 * Every category of press/profile URL that feeds Person.sameAs (SKILL.md rule 2).
 * Aggregation order is the field order below; duplicates are removed keeping the
 * first occurrence (protocol/"www."/trailing-slash insensitive).
 */
export interface SameAsSources {
  pressArticles?: string[];
  bylines?: string[];
  linkedin?: string[];
  youtube?: string[];
  podcast?: string[];
  /** RERA / NAR / CIPS (real estate), NPN / state-license lookups (insurance), etc. */
  credentialRegistries?: string[];
  other?: string[];
}

export interface PersonInput {
  name: string;
  jobTitle?: string;
  description?: string;
  url?: string;
  image?: string;
  worksFor?: { name: string; url?: string };
  sameAsSources?: SameAsSources;
  knowsAbout?: string[];
}

export interface RealEstateAgentInput {
  name: string;
  url?: string;
  telephone?: string;
  description?: string;
  address?: PostalAddressInput;
  areaServed?: string[];
  image?: string[];
  sameAs?: string[];
  /** The principal advisor as a Person node (emitted as `employee`, with full sameAs aggregation). */
  agent?: PersonInput;
}

/** Organization — also used for `InsuranceAgency` (doc 02 §2.4). */
export interface OrganizationInput {
  name: string;
  url: string;
  logo?: string;
  description?: string;
  telephone?: string;
  address?: PostalAddressInput;
  sameAs?: string[];
  contactPoint?: {
    telephone: string;
    contactType?: string;
    areaServed?: string[];
    availableLanguage?: string[];
  };
}

export interface VideoObjectInput {
  name: string;
  description: string;
  thumbnailUrl: string[];
  /** Real upload date — never invented. */
  uploadDate: string;
  /** ISO 8601 duration, e.g. "PT2M12S". */
  duration?: string;
  contentUrl?: string;
  embedUrl?: string;
  /** Full transcript — the resource-center page pattern (doc 02 §2.2) renders it on-page. */
  transcript?: string;
  url?: string;
}

export interface PodcastSeriesInput {
  name: string;
  url: string;
  description?: string;
  webFeed?: string;
  authorName?: string;
  image?: string;
  sameAs?: string[];
}

export interface PodcastEpisodeInput {
  name: string;
  url: string;
  description?: string;
  seriesName?: string;
  seriesUrl?: string;
  episodeNumber?: number;
  datePublished?: string;
  duration?: string;
  audioUrl?: string;
}

export interface BreadcrumbItemInput {
  name: string;
  /** Required for every item except the last (the current page). */
  url?: string;
}

export interface BreadcrumbListInput {
  items: BreadcrumbItemInput[];
}

export interface ServiceInput {
  name: string;
  providerName: string;
  serviceType?: string;
  description?: string;
  providerUrl?: string;
  areaServed?: string[];
  url?: string;
  offer?: OfferInput;
}

export interface ItemListEntryInput {
  name: string;
  url?: string;
  description?: string;
}

export interface ItemListInput {
  items: ItemListEntryInput[];
  name?: string;
  description?: string;
  itemListOrder?: "Ascending" | "Descending" | "Unordered";
}

export type EventAttendanceMode = "Offline" | "Online" | "Mixed";
export type EventStatus =
  | "Scheduled"
  | "Cancelled"
  | "MovedOnline"
  | "Postponed"
  | "Rescheduled";

export interface EventInput {
  name: string;
  startDate: string;
  endDate?: string;
  description?: string;
  image?: string[];
  eventAttendanceMode?: EventAttendanceMode;
  eventStatus?: EventStatus;
  /** Physical venue. Required unless the event is online-only with `onlineUrl`. */
  location?: { name: string; address?: PostalAddressInput };
  /** VirtualLocation URL for online/mixed events. */
  onlineUrl?: string;
  organizerName?: string;
  organizerUrl?: string;
  offer?: OfferInput;
  url?: string;
}

export interface ReviewedItemInput {
  type: "Product" | "LocalBusiness" | "Restaurant" | "Organization" | "Service";
  name: string;
  url?: string;
}

/** Standalone Review root (schema profiles list "Review/AggregateRating", doc 02). */
export interface ReviewInput {
  itemReviewed: ReviewedItemInput;
  author: string;
  reviewBody: string;
  ratingValue: number;
  bestRating?: number;
  worstRating?: number;
  datePublished?: string;
}

/** Standalone AggregateRating root — must reference the reviewed item. */
export interface AggregateRatingInput {
  itemReviewed: ReviewedItemInput;
  ratingValue: number;
  reviewCount?: number;
  ratingCount?: number;
  bestRating?: number;
  worstRating?: number;
}

/* ------------------------------------------------------------------ */
/* Brand context                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal brand identity from the client's locked brand kit, used for publisher /
 * brand defaults (Article.publisher, Product.brand).
 *
 * NOTE: the shared `BrandKit` type (src/lib/types/brand.ts) carries tokens/voice/
 * likeness but no organization identity (name/logo/site URL), so this skill defines
 * its own minimal context shape — flagged to the orchestrator in the 0.2 handoff.
 */
export interface SchemaBrandContext {
  organizationName: string;
  websiteUrl?: string;
  logoUrl?: string;
}

/* ------------------------------------------------------------------ */
/* Request / result                                                    */
/* ------------------------------------------------------------------ */

/**
 * Root-generatable schema types → their entity input models.
 * `Offer`, `Menu`, `MenuItem`, and `Brand` are nested-only: they are emitted inside
 * their parent entity (Product, Restaurant) and rejected as roots at runtime.
 */
export interface EntityInputMap {
  LocalBusiness: LocalBusinessInput;
  Store: LocalBusinessInput;
  Restaurant: RestaurantInput;
  Product: ProductInput;
  FAQPage: FaqPageInput;
  Article: ArticleInput;
  Person: PersonInput;
  RealEstateAgent: RealEstateAgentInput;
  Organization: OrganizationInput;
  InsuranceAgency: OrganizationInput;
  VideoObject: VideoObjectInput;
  PodcastSeries: PodcastSeriesInput;
  PodcastEpisode: PodcastEpisodeInput;
  BreadcrumbList: BreadcrumbListInput;
  Service: ServiceInput;
  ItemList: ItemListInput;
  Event: EventInput;
  Review: ReviewInput;
  AggregateRating: AggregateRatingInput;
}

export type GeneratableSchemaType = keyof EntityInputMap;

/** Compile-time guard: every generatable type is a valid playbook SchemaTypeName. */
type AssertSubtype<T extends U, U> = T;
export type GeneratableIsPlaybookSchemaType = AssertSubtype<
  GeneratableSchemaType,
  SchemaTypeName
>;

export type NestedOnlySchemaType = Exclude<SchemaTypeName, GeneratableSchemaType>;
export const NESTED_ONLY_SCHEMA_TYPES: readonly NestedOnlySchemaType[] = [
  "Offer",
  "Menu",
  "MenuItem",
  "Brand",
];

export interface SchemaGenerationRequest<
  T extends GeneratableSchemaType = GeneratableSchemaType,
> {
  schemaType: T;
  entity: EntityInputMap[T];
  /**
   * REQUIRED (hard rule 1): the rendered, user-visible text of the page the schema
   * will be injected into. Every encoded claim is verified against it. An empty
   * string is a rejection — the match contract cannot be waived.
   */
  visiblePageText: string;
  /** Client brand context from the locked brand kit (publisher/brand defaults). */
  brand?: SchemaBrandContext;
  /**
   * Optional ISO 8601 date/date-time used as "now" by the FUTURE_DATE check —
   * the library's only wall-clock read. Inject it for deterministic, replayable
   * results (tests, stored audit runs); when absent (or not a valid ISO date)
   * the wall clock is used, so default behavior is unchanged. Never emitted
   * into the JSON-LD.
   */
  referenceDate?: string;
}

export interface SchemaGenerationReady {
  status: "ready";
  schemaType: GeneratableSchemaType;
  /** The JSON-LD object (with @context). */
  jsonLd: JsonLdObject;
  /** `<script type="application/ld+json">` block, `</script>`-safe, ready for the auto-fix engine. */
  scriptBlock: string;
  /** Claim → visible-text mapping for Code Review / Content Quality verification. */
  correspondence: CorrespondenceEntry[];
  warnings: ValidationIssue[];
}

export interface SchemaGenerationRejected {
  status: "rejected";
  schemaType: SchemaTypeName;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  correspondence: CorrespondenceEntry[];
  /**
   * Draft node for debugging/review only. Deliberately NOT serialized to a script
   * block — a rejected result can never be injected.
   */
  draftJsonLd?: JsonLdObject;
}

export type SchemaGenerationResult = SchemaGenerationReady | SchemaGenerationRejected;
