/**
 * GbpDataProvider — the provider-agnostic Google Business Profile data port
 * (doc 04 §7 connector pattern; doc 05 M14).
 *
 * GBP is a DEFERRED VENDOR CONNECTOR, exactly like `CitationDataProvider`
 * (src/lib/connectors): M14 calls THIS interface, never the GBP API / a vendor
 * SDK directly. A vendor SDK import outside its adapter is a Code Review
 * rejection (doc 04 §7). Real adapters (GbpApiAdapter, …) land when the GBP
 * connection is wired; this module ships the interface, an honest
 * "not connected" default, and a scriptable in-memory fake so M14 can be built
 * and tested with NO SDK and NO network in any tested path.
 *
 * HONESTY CONTRACT (the reason the port exists): the absence of a GBP
 * connection is reported as `{ connected: false }` — NEVER an invented profile
 * or a fabricated completeness score. Downstream, `not_connected` means
 * "unknown", not "zero".
 *
 * Credentials, when a real adapter needs them, resolve at CALL TIME via the
 * shared `SecretsResolver` (src/lib/connectors) — they are never constructor-
 * visible state on this interface and never logged.
 */

import type { ConnectorScope } from "@/lib/connectors";
import type { GbpProfileInput } from "@/lib/skills/aeo-audit";

/** What we ask GBP about — a single location, by name/address (and Place ID when known). */
export interface GbpLocationQuery {
  name: string | null;
  address: string | null;
  /** Google Place ID when a prior connection resolved one. */
  placeId?: string;
}

/**
 * The vendor-independent result. `profile` reuses the aeo-audit skill's
 * `GbpProfileInput` shape verbatim, so a connected result flows straight into
 * the skill's `checkGbpCompleteness` with no re-mapping (and the completeness
 * scoring stays the skill's, never re-derived here).
 */
export type GbpLocationResult =
  | { connected: false }
  | { connected: true; profile: GbpProfileInput; placeId?: string; raw?: unknown };

/** The provider-agnostic port. Implementations resolve credentials internally. */
export interface GbpDataProvider {
  /** Stable vendor id for provenance, e.g. "gbp-api", "not-connected", "in-memory". */
  readonly vendor: string;
  fetchLocation(query: GbpLocationQuery, scope?: ConnectorScope): Promise<GbpLocationResult>;
}

/** Shared honest sentinel — a location with no GBP connection or no match. */
export const GBP_NOT_CONNECTED: GbpLocationResult = { connected: false };

/**
 * The default provider when the client has no GBP connection: every location is
 * honestly `not connected`. This is what an assess call uses until a real GBP
 * connection is wired — so a missing connection can never masquerade as a
 * complete or empty profile.
 */
export class NotConnectedGbpProvider implements GbpDataProvider {
  readonly vendor = "not-connected";
  // Zero-param body (still satisfies the interface) — every location is honestly
  // not connected regardless of the query.
  async fetchLocation(): Promise<GbpLocationResult> {
    return GBP_NOT_CONNECTED;
  }
}

/**
 * Scriptable, journaling test double — behaves like a vendor adapter with zero
 * network. Script per location name, then assert on `calls`. `failNext`
 * exercises the provider-unavailable path (the assessor must degrade to an
 * honest not-connected, never throw).
 */
export class InMemoryGbpDataProvider implements GbpDataProvider {
  readonly vendor = "in-memory";
  readonly calls: GbpLocationQuery[] = [];
  private readonly byName = new Map<string, GbpLocationResult>();
  private nextError: Error | null = null;

  /** Script a result for a location name (case-insensitive match). */
  script(name: string, result: GbpLocationResult): this {
    this.byName.set(name.trim().toLowerCase(), result);
    return this;
  }

  /** The next fetchLocation() call rejects with `error`. */
  failNext(error: Error = new Error("gbp provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  async fetchLocation(query: GbpLocationQuery): Promise<GbpLocationResult> {
    this.calls.push(query);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const key = (query.name ?? "").trim().toLowerCase();
    return this.byName.get(key) ?? GBP_NOT_CONNECTED;
  }
}
