/**
 * M14 Local SEO — on-site NAP consistency (doc 05 M14; task deliverable 1).
 *
 * Distinct from the aeo-audit skill's `nap_consistency` check, which compares
 * the canonical entity against third-party DIRECTORY listings. This assesses
 * the client's OWN SITE (the crawl layer) against the canonical location
 * record: does the site show this location's name / address / phone, and
 * consistently?
 *
 * REUSE, NOT REIMPLEMENTATION: the field normalizers are the SKILL's exact
 * `normalizeName` / `normalizeAddress` / `normalizePhone`, imported read-only —
 * so an on-site NAP verdict and a directory NAP verdict use identical
 * normalization and can never silently disagree on what "consistent" means.
 * (The normalizers are not on the skill's public index; importing them from the
 * skill's `util` module is deliberate reuse — see the module header note.)
 *
 * Pure + deterministic: a function of (canonical location, crawled site). No
 * network, no clock, no randomness — pinned by test.
 */

import type { CrawledSite } from "@/lib/skills/aeo-audit";
import {
  collectJsonLdNodes,
  jsonLdAddressText,
  nodeTypes,
  normalizeAddress,
  normalizeName,
  normalizePhone,
  stringProp,
} from "@/lib/skills/aeo-audit/util";
import type { NapAssessment, NapFieldAssessment, NapFieldStatus } from "./types";

/** The canonical NAP we assess a site against (from a `CanonicalLocation`). */
export interface CanonicalNap {
  name: string | null;
  address: string | null;
  phone: string | null;
}

/**
 * schema.org LocalBusiness-CLASS @types whose name/address/telephone are the
 * structured NAP a site asserts. A conflicting value here is a real mismatch
 * (the page is telling engines something different from the canonical record).
 */
const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "Store",
  "Restaurant",
  "RealEstateAgent",
  "Organization",
  "InsuranceAgency",
  "ProfessionalService",
  "Dentist",
  "Physician",
  "MedicalBusiness",
  "FinancialService",
]);

/**
 * The site's NAP surface, extracted ONCE from the crawl and reused across every
 * location. Structured schema values are strongest; the normalized corpora back
 * a visible-text presence fallback when a page shows NAP as prose, not schema.
 */
export interface SiteNapSurface {
  hasPages: boolean;
  hasLocalSchema: boolean;
  /** Names asserted in LocalBusiness-class JSON-LD nodes (raw). */
  schemaNames: string[];
  /** Addresses composed from LocalBusiness-class JSON-LD nodes (raw). */
  schemaAddresses: string[];
  /** Telephones from LocalBusiness-class JSON-LD nodes, normalized to last-10. */
  schemaPhones: string[];
  /** All visible text, name-normalized — for prose presence of a business name. */
  nameCorpus: string;
  /** All visible text, address-normalized — for prose presence of an address. */
  addressCorpus: string;
  /** All visible text reduced to digits — for prose presence of a phone number. */
  phoneDigits: string;
}

export function buildSiteNapSurface(site: CrawledSite): SiteNapSurface {
  const textParts: string[] = [];
  const schemaNames: string[] = [];
  const schemaAddresses: string[] = [];
  const schemaPhones: string[] = [];
  let hasLocalSchema = false;

  for (const page of site.pages) {
    if (page.title !== null && page.title !== "") textParts.push(page.title);
    for (const h1 of page.h1s) textParts.push(h1);
    textParts.push(page.visibleText);

    for (const block of page.jsonLdBlocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        continue; // invalid JSON-LD is the audit's schema check's finding, not ours
      }
      for (const node of collectJsonLdNodes(parsed)) {
        if (!nodeTypes(node).some((t) => LOCAL_BUSINESS_TYPES.has(t))) continue;
        hasLocalSchema = true;
        const name = stringProp(node, "name");
        if (name !== null) schemaNames.push(name);
        const address = jsonLdAddressText(node);
        if (address !== null) schemaAddresses.push(address);
        const phone = stringProp(node, "telephone");
        if (phone !== null) schemaPhones.push(normalizePhone(phone));
      }
    }
  }

  const joined = textParts.join(" ");
  return {
    hasPages: site.pages.length > 0,
    hasLocalSchema,
    schemaNames,
    schemaAddresses,
    schemaPhones,
    nameCorpus: normalizeName(joined),
    addressCorpus: normalizeAddress(joined),
    phoneDigits: joined.replace(/\D/g, ""),
  };
}

/**
 * Assess one canonical field against the site. Order of evidence:
 *   1. structured LocalBusiness-class schema value (strongest) → match / mismatch;
 *   2. else visible-text (prose) presence → match / absent.
 * A field with nothing canonical to check is `no_canonical`, never a failure.
 */
function assessField(
  field: NapFieldAssessment["field"],
  canonicalRaw: string | null,
  schemaValues: string[],
  presenceCorpus: string,
  normalize: (s: string) => string,
): NapFieldAssessment {
  if (canonicalRaw === null) {
    return {
      field,
      status: "no_canonical",
      canonical: null,
      foundOnSite: null,
      message: `No canonical ${field} on record — nothing to check on the site.`,
    };
  }
  const canonical = normalize(canonicalRaw);
  if (canonical === "") {
    return {
      field,
      status: "no_canonical",
      canonical: canonicalRaw,
      foundOnSite: null,
      message: `Canonical ${field} normalizes to empty — nothing to check.`,
    };
  }

  const schemaNorms = schemaValues.map(normalize).filter((v) => v !== "");
  if (schemaNorms.length > 0) {
    if (schemaNorms.includes(canonical)) {
      return {
        field,
        status: "match",
        canonical: canonicalRaw,
        foundOnSite: null,
        message: `Site local schema ${field} matches the canonical record.`,
      };
    }
    // The page's own structured data disagrees with the canonical record.
    const conflicting = schemaValues.find((v) => normalize(v) !== "" && normalize(v) !== canonical) ?? null;
    return {
      field,
      status: "mismatch",
      canonical: canonicalRaw,
      foundOnSite: conflicting,
      message: `Site local schema ${field} "${conflicting ?? ""}" does not match canonical "${canonicalRaw}".`,
    };
  }

  // No structured schema value — fall back to prose presence in visible text.
  const present = presenceCorpus.includes(canonical);
  return present
    ? {
        field,
        status: "match",
        canonical: canonicalRaw,
        foundOnSite: null,
        message: `Canonical ${field} appears in the site's visible text.`,
      }
    : {
        field,
        status: "absent",
        canonical: canonicalRaw,
        foundOnSite: null,
        message: `Canonical ${field} appears nowhere on the crawled site.`,
      };
}

/**
 * Assess a location's canonical NAP against the crawled site. When the site had
 * NO crawlable pages, every field is `not_assessable` and `assessable` is false
 * — the on-site verdict is withheld, never fabricated.
 */
export function assessOnSiteNap(canonical: CanonicalNap, surface: SiteNapSurface): NapAssessment {
  if (!surface.hasPages) {
    const fields: NapFieldAssessment[] = (["name", "address", "phone"] as const).map((field) => ({
      field,
      status: "not_assessable" as NapFieldStatus,
      canonical: canonical[field],
      foundOnSite: null,
      message: "The site had no crawlable pages — on-site NAP can't be assessed.",
    }));
    return { fields, consistent: false, assessable: false };
  }

  const phoneDigits = canonical.phone === null ? null : normalizePhone(canonical.phone);
  const fields: NapFieldAssessment[] = [
    assessField("name", canonical.name, surface.schemaNames, surface.nameCorpus, normalizeName),
    assessField("address", canonical.address, surface.schemaAddresses, surface.addressCorpus, normalizeAddress),
    assessField(
      "phone",
      // Present the canonical phone raw, but presence/schema compare on last-10.
      phoneDigits === "" ? null : canonical.phone,
      surface.schemaPhones,
      surface.phoneDigits,
      normalizePhone,
    ),
  ];

  const checkable = fields.filter((f) => f.status !== "no_canonical");
  const consistent = checkable.length > 0 && checkable.every((f) => f.status === "match");
  return { fields, consistent, assessable: true };
}
