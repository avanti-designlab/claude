/**
 * M14 Local SEO — per-location assessment orchestrator (doc 05 M14; doc 07 §1.6).
 *
 * Ties the pure pieces together for a client:
 *   1. intensity gate — an OFF playbook returns an explicit empty report (never
 *      a fabricated score);
 *   2. ONE crawl of the site via `crawlSite` — REUSING the shared SSRF egress
 *      guard (this module NEVER bypasses crawlSite to reach a client URL);
 *   3. per canonical location (`clients.locations`): on-site NAP consistency,
 *      GBP completeness via the injected GBP data provider port, local schema
 *      via M10 (visible-text gated), and local-pack readiness by ZIP;
 *   4. multi-location honesty — N locations → N assessments; an uncrawlable
 *      site OR an unconnected GBP OR an unusable record is SAID SO, never
 *      scored.
 *
 * Determinism: given the same FetchPort responses, the same GBP provider
 * answers, and the same `crawledAt`, the whole report is byte-identical (the
 * only impure inputs are the two injected ports). Production wires the live
 * FetchPort + DNS resolver behind the same seam the audit engine uses; tests
 * pass a ScriptedFetch + a fake resolver + the in-memory GBP provider.
 */

import type { ConnectorScope } from "@/lib/connectors";
import { crawlSite, type CrawlBounds, type ResolvePort } from "@/lib/intelligence/crawl";
import type { CrawledSite } from "@/lib/skills/aeo-audit";
import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { SchemaBrandContext } from "@/lib/production/schema";
import type { PostalAddressInput } from "@/lib/skills/schema-generation";
import type { Playbook } from "@/lib/types/playbook";
import type { ClientLocation } from "@/lib/types/db";
import type { FetchPort } from "@/lib/write-methods/shared";
import { assessGbp, assessLocalPack } from "./completeness";
import { localPackFixes, napFixes, schemaFixes } from "./fixes";
import { GBP_NOT_CONNECTED, type GbpDataProvider, type GbpLocationResult } from "./gbp-provider";
import { localIntensity } from "./intensity";
import { parseClientLocations, type CanonicalLocation } from "./locations";
import { assessOnSiteNap, buildSiteNapSurface, type SiteNapSurface } from "./nap";
import { produceLocationSchema } from "./schema";
import type { LocalReport, LocationAssessment, NapAssessment } from "./types";

export interface AssessClientLocalInput {
  fetchPort: FetchPort;
  /** Injected DNS resolver for the crawler's SSRF egress guard — REQUIRED. */
  resolvePort: ResolvePort;
  /** Absolute http(s) URL of the client's website property (caller-validated). */
  startUrl: string;
  playbook: Playbook;
  /** `clients.locations` (RLS-scoped read upstream). */
  locations: ClientLocation[];
  /** GBP data provider port — NotConnectedGbpProvider when no connection exists. */
  gbpProvider: GbpDataProvider;
  /** ISO timestamp for the crawl + report (determinism). */
  crawledAt: string;
  /** Tenant/client scope for the GBP port (never client-supplied). */
  scope?: ConnectorScope;
  brand?: SchemaBrandContext;
  /** Structured addresses per location index (from a richer capture) — never fabricated. */
  structuredAddresses?: Record<number, PostalAddressInput>;
  bounds?: Partial<CrawlBounds>;
  referenceDate?: string;
}

/** Never throw from a provider call — a provider fault degrades to honest not-connected. */
async function fetchGbpSafe(
  provider: GbpDataProvider,
  location: CanonicalLocation,
  scope: ConnectorScope | undefined,
): Promise<{ result: GbpLocationResult; failed: boolean }> {
  try {
    const result = await provider.fetchLocation(
      { name: location.name, address: location.address },
      scope,
    );
    return { result, failed: false };
  } catch {
    // Absence via fault is still absence — reported as not-connected, never invented.
    return { result: GBP_NOT_CONNECTED, failed: true };
  }
}

/** Build the raw visible-text corpus M10's gate checks the schema NAP against. */
function siteVisibleCorpus(site: CrawledSite): string {
  const parts: string[] = [];
  for (const page of site.pages) {
    if (page.title !== null && page.title !== "") parts.push(page.title);
    for (const h1 of page.h1s) parts.push(h1);
    if (page.visibleText !== "") parts.push(page.visibleText);
  }
  return parts.join("\n");
}

function assessOneLocation(args: {
  location: CanonicalLocation;
  playbook: Playbook;
  surface: SiteNapSurface;
  corpus: string;
  startUrl: string;
  gbp: GbpLocationResult;
  gbpFailed: boolean;
  brand?: SchemaBrandContext;
  structuredAddress?: PostalAddressInput;
  referenceDate?: string;
}): { assessment: LocationAssessment; fixes: FixDraft[] } {
  const { location, playbook, surface, gbp } = args;
  const intensity = localIntensity(playbook);
  const notes: string[] = [];

  // Unusable record → nothing to assess (honest, never scored).
  if (!location.usable) {
    return {
      assessment: {
        locationIndex: location.index,
        locationName: location.name,
        status: "insufficient_canonical",
        nap: emptyNap(),
        gbp: { status: "not_connected", completenessScore: null, gaps: [] },
        localPack: { readiness: "not_assessable", zip: null, signals: [] },
        schemaReady: false,
        notes: ["This location record has no usable name or address — nothing to assess."],
      },
      fixes: [],
    };
  }

  const nap = assessOnSiteNap(
    { name: location.name, address: location.address, phone: location.phone },
    surface,
  );
  if (!nap.assessable) notes.push("Site had no crawlable pages — on-site NAP was not assessed.");

  const gbpResult = assessGbp(gbp, playbook);
  if (args.gbpFailed) notes.push("GBP lookup failed — reported as not connected (not fabricated).");
  else if (gbp.connected === false) notes.push("No GBP connection for this location — completeness is unknown, not zero.");

  const schemaOutcome = produceLocationSchema({
    location,
    playbook,
    websiteUrl: args.startUrl,
    visible: args.corpus,
    ...(args.structuredAddress !== undefined ? { structuredAddress: args.structuredAddress } : {}),
    ...(args.brand !== undefined ? { brand: args.brand } : {}),
    ...(args.referenceDate !== undefined ? { referenceDate: args.referenceDate } : {}),
  });
  const schemaReady = schemaOutcome.result?.status === "ready";

  const localPack = assessLocalPack(location, nap, gbpResult.assessment, schemaReady);

  // no_data: neither the site nor GBP produced any signal for this location.
  const anySignal = nap.assessable || gbp.connected === true;
  const status = anySignal ? "assessed" : "no_data";
  if (!anySignal) {
    notes.push("Neither the site nor GBP produced any signal for this location — not scored.");
  }

  const fixes: FixDraft[] =
    status === "no_data"
      ? // Don't emit on-page fixes we can't ground; the honest ask is to connect a source.
        gbpResult.fixes
      : [
          ...napFixes(location, nap, intensity),
          ...gbpResult.fixes,
          ...schemaFixes(schemaOutcome, location, intensity),
          ...localPackFixes(location, localPack, intensity),
        ];

  return {
    assessment: {
      locationIndex: location.index,
      locationName: location.name,
      status,
      nap,
      gbp: gbpResult.assessment,
      localPack,
      schemaReady,
      notes,
    },
    fixes,
  };
}

function emptyNap(): NapAssessment {
  return {
    fields: (["name", "address", "phone"] as const).map((field) => ({
      field,
      status: "not_assessable" as const,
      canonical: null,
      foundOnSite: null,
      message: "Location record is not usable — no canonical value to assess.",
    })),
    consistent: false,
    assessable: false,
  };
}

/**
 * Assess a client's local presence across ALL its locations. OFF playbooks
 * return an explicit empty report. Otherwise crawls once, then produces one
 * honesty-first assessment per `clients.locations` entry.
 */
export async function assessClientLocal(input: AssessClientLocalInput): Promise<LocalReport> {
  const intensity = localIntensity(input.playbook);
  if (intensity === "off") {
    return {
      vertical: input.playbook.vertical,
      intensity,
      active: false,
      crawledAt: input.crawledAt,
      locations: [],
      coverage: null,
      fixes: [],
    };
  }

  const canonical = parseClientLocations(input.locations);

  // ONE crawl, reusing the shared egress guard — never a bespoke fetch.
  const { site, coverage } = await crawlSite({
    fetchPort: input.fetchPort,
    resolvePort: input.resolvePort,
    startUrl: input.startUrl,
    crawledAt: input.crawledAt,
    bounds: input.bounds,
  });

  const surface = buildSiteNapSurface(site);
  const corpus = siteVisibleCorpus(site);

  const assessments: LocationAssessment[] = [];
  const allFixes: FixDraft[] = [];
  for (const location of canonical) {
    const { result: gbp, failed: gbpFailed } = location.usable
      ? await fetchGbpSafe(input.gbpProvider, location, input.scope)
      : { result: GBP_NOT_CONNECTED, failed: false };

    const { assessment, fixes } = assessOneLocation({
      location,
      playbook: input.playbook,
      surface,
      corpus,
      startUrl: input.startUrl,
      gbp,
      gbpFailed,
      ...(input.brand !== undefined ? { brand: input.brand } : {}),
      ...(input.structuredAddresses?.[location.index] !== undefined
        ? { structuredAddress: input.structuredAddresses[location.index] }
        : {}),
      ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
    });
    assessments.push(assessment);
    allFixes.push(...fixes);
  }

  return {
    vertical: input.playbook.vertical,
    intensity,
    active: true,
    crawledAt: input.crawledAt,
    locations: assessments,
    coverage,
    fixes: allFixes,
  };
}
