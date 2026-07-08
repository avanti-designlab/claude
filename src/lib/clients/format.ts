/**
 * Pure, side-effect-free client-record formatting helpers. No React, no server
 * imports — shared by the onboarding save panel (client) and the clients list
 * (server), and unit-tested in the default `npm test` run.
 */

import type { ClientLocation } from "@/lib/types/db";

/**
 * Map raw onboarding location strings to the `clients.locations` shape
 * ([{name, address, geo}]). Blank entries are dropped; `geo` is deferred to the
 * local module (M14), so only name + address are set (both the entered value —
 * onboarding collects a service-area name, not a structured address yet).
 */
export function toClientLocations(values: string[]): ClientLocation[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => ({ name: value, address: value }));
}

/**
 * A friendly default client name: the first property's bare hostname
 * (www-stripped), else the first non-empty location, else "".
 */
export function suggestClientName(
  locationValues: string[],
  propertyUrls: string[]
): string {
  const firstUrl = propertyUrls
    .map((u) => u.trim())
    .find((u) => u.length > 0);
  if (firstUrl) {
    try {
      const withScheme = /^https?:\/\//i.test(firstUrl)
        ? firstUrl
        : `https://${firstUrl}`;
      const host = new URL(withScheme).hostname.replace(/^www\./, "");
      if (host) return host;
    } catch {
      // malformed URL — fall through to a location-based suggestion
    }
  }
  return (
    locationValues.map((v) => v.trim()).find((v) => v.length > 0) ?? ""
  );
}

/** Turn a vertical slug ("real-estate") into a human label ("Real estate"). */
export function verticalLabel(vertical: string): string {
  const spaced = vertical.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : vertical;
}
