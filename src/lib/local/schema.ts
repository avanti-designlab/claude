/**
 * M14 Local SEO — local schema production (doc 05 M14; task deliverable 2).
 *
 * M14 NEVER reimplements schema. It WRAPS M10's `produceSchema`
 * (src/lib/production/schema), which wraps the frozen schema-generation skill —
 * so the visible-text match gate applies unchanged: a fabricated NAP (a name or
 * phone the page doesn't show) makes `produceSchema` return `rejected`, and a
 * rejected result cannot reach the change-management write path. Feeding the
 * change-management path is M10's `buildSchemaChange` (ready-only), re-exported
 * so M14 adds no bespoke write seam.
 *
 * DATA-HONESTY BOUNDARIES (why some types skip):
 *  - LocalBusiness / Store REQUIRE a structured `PostalAddressInput` (street +
 *    locality + country). `clients.locations` carries only a free address
 *    STRING; parsing a country out of it would be fabrication, so M14 emits
 *    these ONLY when a structured address is supplied (from GBP / a richer
 *    capture) — otherwise it skips honestly and raises a "capture structured
 *    address" fix.
 *  - Restaurant needs a menu (M8's content domain), so the restaurant vertical
 *    falls back to the LocalBusiness NAP base (still valid + useful on a
 *    restaurant page); full Restaurant+Menu schema is produced by the content
 *    pipeline, not from NAP data.
 *  - RealEstateAgent (address optional) and InsuranceAgency (needs the site URL,
 *    which we have) are producible from NAP data alone — the live real-estate
 *    vertical (GG client zero) works end-to-end here.
 */

import type { ExtractedDoc } from "@/lib/intelligence/crawl";
import {
  buildSchemaChange,
  produceSchema,
  type GeneratableSchemaType,
  type SchemaBrandContext,
  type SchemaChangeSpec,
  type SchemaGenerationResult,
} from "@/lib/production/schema";
import type {
  LocalBusinessInput,
  OpeningHoursInput,
  OrganizationInput,
  PostalAddressInput,
  RealEstateAgentInput,
} from "@/lib/skills/schema-generation";
import type { Playbook } from "@/lib/types/playbook";
import type { CanonicalLocation } from "./locations";

// Re-export M10's ready-only change feed so callers shape a DesiredChange
// through the ONE authoritative seam — never a bespoke serializer.
export { buildSchemaChange, type SchemaChangeSpec };

/** LocalBusiness-CLASS types M14 recognizes in a playbook's schema_profile. */
const LOCAL_CLASS = new Set<GeneratableSchemaType>([
  "LocalBusiness",
  "Store",
  "RealEstateAgent",
  "InsuranceAgency",
  "Restaurant",
]);

/** The local schema types M14 can emit (Restaurant maps to the LocalBusiness base). */
export type LocalSchemaType = "LocalBusiness" | "Store" | "RealEstateAgent" | "InsuranceAgency";

/**
 * The local schema type M14 produces for a playbook — the FIRST
 * LocalBusiness-class entry in `schema_profile` (priority order, playbook-
 * driven, never invented). Restaurant maps to the LocalBusiness NAP base
 * (menu is M8's domain). Null when the playbook lists no local schema type
 * (e.g. e-commerce — but that playbook is OFF anyway).
 */
export function localSchemaTypeFor(playbook: Playbook): LocalSchemaType | null {
  for (const t of playbook.schema_profile) {
    if (!LOCAL_CLASS.has(t as GeneratableSchemaType)) continue;
    if (t === "Restaurant") return "LocalBusiness";
    return t as LocalSchemaType;
  }
  return null;
}

export interface LocationSchemaInput {
  location: CanonicalLocation;
  playbook: Playbook;
  /** The site URL — required for the InsuranceAgency (Organization) `url` field. */
  websiteUrl: string;
  /** The page (or corpus) the schema will be injected on — gates the NAP claims. */
  visible: ExtractedDoc | string;
  /**
   * A structured address, ONLY when a real one is available (GBP / richer
   * capture). Never parsed out of the free `clients.locations` string.
   */
  structuredAddress?: PostalAddressInput;
  /** Opening hours from GBP (pass-through — not text-gated by the skill). */
  openingHours?: OpeningHoursInput[];
  brand?: SchemaBrandContext;
  referenceDate?: string;
}

export type LocationSchemaOutcome =
  | { schemaType: LocalSchemaType; result: SchemaGenerationResult }
  /** Skipped BEFORE calling the skill — no local type, no name, or a required structured address is absent. */
  | { schemaType: LocalSchemaType | null; result: null; skipped: true; reason: string };

/**
 * Produce (or honestly skip) the location's local JSON-LD via M10. A `ready`
 * result carries a `scriptBlock` + `correspondence` and can be shaped into a
 * DesiredChange with {@link buildSchemaChange}; a `rejected` result names the
 * overclaims (a NAP the page doesn't show) and never reaches a write.
 */
export function produceLocationSchema(input: LocationSchemaInput): LocationSchemaOutcome {
  const schemaType = localSchemaTypeFor(input.playbook);
  if (schemaType === null) {
    return { schemaType: null, result: null, skipped: true, reason: "playbook lists no local schema type" };
  }
  const name = input.location.name;
  if (name === null) {
    return { schemaType, result: null, skipped: true, reason: "location has no canonical name to assert" };
  }

  const telephone = input.location.phone ?? undefined;

  switch (schemaType) {
    case "RealEstateAgent": {
      const entity: RealEstateAgentInput = {
        name,
        url: input.websiteUrl,
        ...(telephone !== undefined ? { telephone } : {}),
        ...(input.structuredAddress !== undefined ? { address: input.structuredAddress } : {}),
      };
      return {
        schemaType,
        result: produceSchema({
          schemaType: "RealEstateAgent",
          entity,
          visible: input.visible,
          brand: input.brand,
          referenceDate: input.referenceDate,
        }),
      };
    }
    case "InsuranceAgency": {
      const entity: OrganizationInput = {
        name,
        url: input.websiteUrl,
        ...(telephone !== undefined ? { telephone } : {}),
        ...(input.structuredAddress !== undefined ? { address: input.structuredAddress } : {}),
      };
      return {
        schemaType,
        result: produceSchema({
          schemaType: "InsuranceAgency",
          entity,
          visible: input.visible,
          brand: input.brand,
          referenceDate: input.referenceDate,
        }),
      };
    }
    case "LocalBusiness":
    case "Store": {
      if (input.structuredAddress === undefined) {
        return {
          schemaType,
          result: null,
          skipped: true,
          reason: `${schemaType} schema requires a structured address (street + locality + country) — capture one before emitting`,
        };
      }
      const entity: LocalBusinessInput = {
        name,
        address: input.structuredAddress,
        url: input.websiteUrl,
        ...(telephone !== undefined ? { telephone } : {}),
        ...(input.location.geo !== null ? { geo: input.location.geo } : {}),
        ...(input.openingHours !== undefined ? { openingHours: input.openingHours } : {}),
      };
      return {
        schemaType,
        result: produceSchema({
          schemaType,
          entity,
          visible: input.visible,
          brand: input.brand,
          referenceDate: input.referenceDate,
        }),
      };
    }
  }
}
