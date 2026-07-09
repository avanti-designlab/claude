/**
 * M14 Local SEO — canonical location parsing (doc 03 §3, doc 05 M14).
 *
 * `clients.locations` is `[{ name, address, geo }]` (migration 0003,
 * `ClientLocation`). The onboarding write clamps it, but it is jsonb read back
 * from the DB, so this parser is DEFENSIVE: any malformed entry degrades to
 * an honest "not usable" record rather than throwing or fabricating a value.
 *
 * NAP note: the frozen `ClientLocation` shape carries NO phone (name + address
 * only). Phone is therefore `null` (honest — "no canonical phone on record")
 * unless a future richer record supplies one; the parser reads a `phone` field
 * defensively if one is ever present, but never invents it.
 *
 * The geo shape was left doc-silent for M14 to refine (migration 0003 comment).
 * We read `{lat,lng}` / `{latitude,longitude}` numeric pairs and nothing else;
 * a shape we don't recognize is `null`, not a guess.
 */

import type { GeoCoordinatesInput } from "@/lib/skills/schema-generation";
import type { ClientLocation, Json } from "@/lib/types/db";

export interface CanonicalLocation {
  /** Index into `clients.locations` (stable multi-location identity). */
  index: number;
  name: string | null;
  address: string | null;
  /** Not in the frozen ClientLocation shape today → null (never fabricated). */
  phone: string | null;
  /** US ZIP extracted from the address (or geo.postalCode), best-effort; null when none. */
  zip: string | null;
  geo: GeoCoordinatesInput | null;
  /** True when there is enough (a name OR an address) to assess against. */
  usable: boolean;
}

/** US ZIP / ZIP+4, matched on a word boundary — best-effort, never invented. */
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function extractZip(address: string | null, geo: Record<string, unknown> | null): string | null {
  const fromGeo = geo ? cleanString(geo.postalCode) : null;
  if (fromGeo && ZIP_RE.test(fromGeo)) return ZIP_RE.exec(fromGeo)![1];
  if (address) {
    const match = ZIP_RE.exec(address);
    if (match) return match[1];
  }
  return null;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseGeo(geo: Record<string, unknown> | null): GeoCoordinatesInput | null {
  if (geo === null) return null;
  const lat = toNumber(geo.lat) ?? toNumber(geo.latitude);
  const lng = toNumber(geo.lng) ?? toNumber(geo.longitude) ?? toNumber(geo.lon);
  if (lat === null || lng === null) return null;
  // Sanity range — an out-of-range pair is not a real coordinate, so it is
  // dropped rather than emitted (a wrong geo is worse than none).
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOne(entry: unknown, index: number): CanonicalLocation {
  const record = asRecord(entry);
  if (record === null) {
    return { index, name: null, address: null, phone: null, zip: null, geo: null, usable: false };
  }
  const name = cleanString(record.name);
  const address = cleanString(record.address);
  const phone = cleanString(record.phone); // absent in ClientLocation today → null
  const geoRecord = asRecord(record.geo as Json | undefined);
  const geo = parseGeo(geoRecord);
  const zip = extractZip(address, geoRecord);
  return {
    index,
    name,
    address,
    phone,
    zip,
    geo,
    usable: name !== null || address !== null,
  };
}

/**
 * Parse a `clients.locations` value (or any untrusted jsonb) into canonical
 * per-location records. A non-array input yields `[]`; malformed entries become
 * `usable: false` records that the assessor reports as `insufficient_canonical`.
 */
export function parseClientLocations(
  locations: ClientLocation[] | unknown,
): CanonicalLocation[] {
  if (!Array.isArray(locations)) return [];
  return locations.map((entry, index) => parseOne(entry, index));
}
