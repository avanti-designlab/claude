/**
 * M16 ROI / attribution — the deferred, provider-agnostic outcome-source ports
 * (doc 04 §3/§7; doc 05 §M16; doc 07 §1.8).
 *
 * M16 ties platform work to real outcomes across FIVE measurement sources:
 * GA4 (sessions/conversions), Google Search Console (clicks/impressions),
 * call-tracking (calls), form-fills (submissions) and a CRM handoff seam
 * (qualified leads / revenue). Every one is RENTED, exactly like the
 * citation-data + social-posting connectors (doc 04 §3: "official APIs …
 * integrate a call-tracking provider"): modules call THIS port, never a vendor
 * SDK — a vendor SDK import outside its adapter is a Code Review rejection
 * (doc 04 §7). Swapping GA4-vendor / call-tracking-vendor changes one adapter,
 * not the attribution model or the data model, because every vendor response
 * is normalized into {@link OutcomeSample} before it goes anywhere.
 *
 * DEFERRED-VENDOR NOTE: no real adapter has landed (same posture as M3's
 * `resolveCitationDataProvider` → null). This module ships the port, the fixed
 * per-source vendor-host pins, the typed failure family, and journaling
 * in-memory fakes so the attribution/persistence/read layers are built and
 * tested with zero network and zero vendor account. When a real adapter lands
 * it resolves its credential at CALL TIME from the secrets vault (doc 04 §5,
 * `VendorCredential` + `SecretsResolver`) and pins its API host per
 * {@link assertPinnedApiHost} — a credentialed read can never be steered to an
 * attacker host (SSRF-closed), mirroring the write methods' `redirect:"error"`
 * + origin-pin discipline.
 */

import type {
  CredentialedAdapterConfig,
  SecretsResolver,
} from "@/lib/connectors";
// Read-only reuse of the write-methods HTTP port: an ROI adapter drives the
// SAME injected FetchPort (redirect:"error" pinned) so its tests run networkless
// and a followed redirect can never re-send the Authorization header.
import type { FetchPort } from "@/lib/write-methods/shared";

/* ------------------------------------------------------------------ */
/* Source identities + the outcome vocabulary                          */
/* ------------------------------------------------------------------ */

/**
 * A logical ROI outcome source. NOTE these are the MODULE's logical sources —
 * they do NOT all map 1:1 onto the frozen `metrics.source` CHECK (normalize.ts
 * owns that mapping and flags the two that have no storage home yet).
 */
export const ROI_SOURCE_IDS = [
  "ga4",
  "gsc",
  "call_tracking",
  "form_fills",
  "crm",
] as const;
export type RoiSourceId = (typeof ROI_SOURCE_IDS)[number];

/**
 * The canonical, vendor-independent metric names each source reports. Adapters
 * normalize a vendor's own field names onto these; the attribution model only
 * ever sees these. Open per source (a vendor may expose more) but these are the
 * ones M16 attributes on.
 */
export const ROI_SOURCE_METRICS: Record<RoiSourceId, readonly string[]> = {
  ga4: ["sessions", "engaged_sessions", "conversions"],
  gsc: ["clicks", "impressions"],
  call_tracking: ["calls"],
  form_fills: ["form_submissions"],
  crm: ["qualified_leads", "revenue"],
} as const;

/** The window an outcome value covers (ISO-8601, inclusive start / exclusive end). */
export interface OutcomePeriod {
  start: string;
  end: string;
}

/**
 * One normalized, MEASURED outcome. `value` is a finite, non-negative number —
 * a measured 0 is real data (0 sessions in a dead week), distinct from an
 * ABSENT metric (source not connected), which is simply not present at all.
 */
export interface OutcomeSample {
  source: RoiSourceId;
  metric: string;
  value: number;
  period: OutcomePeriod;
}

/** A fetch over one source for one period. */
export interface RoiSourceRequest {
  period: OutcomePeriod;
}

/**
 * The normalized result an adapter returns: measured samples only. A source
 * that measured nothing returns `samples: []` (measured-empty) — NOT invented
 * zeros, and NOT the same as being unconnected (which yields no result at all).
 */
export interface RoiSourceResult {
  source: RoiSourceId;
  /** Stable vendor id for provenance (e.g. "ga4-data-api", "callrail", "in-memory"). */
  vendor: string;
  period: OutcomePeriod;
  samples: OutcomeSample[];
}

/**
 * The provider-agnostic connector interface. Implementations:
 * Ga4Adapter | GscAdapter | CallRailAdapter | <FormVendor>Adapter |
 * <CrmVendor>Adapter | (future) InHouseAdapter — plus
 * {@link InMemoryRoiSource} for tests. Vendor keys live in the secrets vault,
 * resolved at call time inside `fetchOutcomes` — NEVER constructor-visible.
 */
export interface RoiSource {
  readonly sourceId: RoiSourceId;
  readonly vendor: string;
  fetchOutcomes(request: RoiSourceRequest): Promise<RoiSourceResult>;
}

/* ------------------------------------------------------------------ */
/* Typed failure family (read-connector honesty)                       */
/* ------------------------------------------------------------------ */

export type RoiSourceErrorCode =
  /** Adapter built with unusable config (no pinned host, bad base). */
  | "misconfigured"
  /** SSRF guard: the call's target host is not the source's pinned API host. */
  | "off_host_target"
  /** SSRF guard: the target is not https. */
  | "insecure_transport"
  /** SSRF guard: the target URL embeds a credential (userinfo/query/fragment). */
  | "credential_in_url"
  /** The vendor answered something that isn't a normalizable outcome payload. */
  | "unexpected_response"
  /** The vendor's rate limit rejected the call — retryable. */
  | "rate_limited"
  /** The vendor/transport was unreachable — retryable. */
  | "network_failure";

/**
 * A source-connector failure whose message is COMPOSED from our own coordinates
 * (source id, code) — never from a vendor body and never from a configured URL.
 * A credential cannot appear in an RoiSourceError by construction, so this is
 * safe to log/telemeter and surface to operators.
 */
export class RoiSourceError extends Error {
  readonly code: RoiSourceErrorCode;
  readonly sourceId: RoiSourceId;
  constructor(sourceId: RoiSourceId, code: RoiSourceErrorCode, message: string) {
    super(message);
    this.name = "RoiSourceError";
    this.code = code;
    this.sourceId = sourceId;
  }
}

export function isRoiSourceError(err: unknown): err is RoiSourceError {
  return err instanceof RoiSourceError;
}

/* ------------------------------------------------------------------ */
/* Host-pin / SSRF guard (doc 04 §5; write-methods origin-pin analog)   */
/* ------------------------------------------------------------------ */

/**
 * The FIXED API host per source. GA4 and GSC are Google APIs whose host can
 * NEVER move with a vendor swap, so they are hardcoded here — an adapter is not
 * allowed to be pointed anywhere else. The vendor-agnostic sources
 * (call-tracking / form-fills / CRM) have no single global host, so their pin
 * is supplied at adapter construction from a per-tenant allowlist (never from a
 * request); `null` here means "the adapter must carry its own pinned host".
 */
export const ROI_SOURCE_API_HOSTS: Record<RoiSourceId, string | null> = {
  ga4: "analyticsdata.googleapis.com",
  gsc: "searchconsole.googleapis.com",
  call_tracking: null,
  form_fills: null,
  crm: null,
} as const;

/** Lowercased registrable-host shape (no scheme, path, port, userinfo). */
const HOST_SHAPE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/**
 * Resolve the host an adapter MUST pin to, refusing anything unusable WITHOUT
 * echoing the configured value (a configured host string can be a
 * copy-paste that embedded a token — same non-echo rule as `refuseBaseUrl`).
 * For GA4/GSC the fixed host wins outright; a configured override is ignored,
 * never honored. For the vendor-agnostic sources the adapter's configured host
 * is required and must be a bare hostname.
 */
export function resolvePinnedApiHost(
  sourceId: RoiSourceId,
  configuredHost?: string,
): string {
  const fixed = ROI_SOURCE_API_HOSTS[sourceId];
  if (fixed !== null) return fixed;
  const host = typeof configuredHost === "string" ? configuredHost.trim().toLowerCase() : "";
  if (host === "" || !HOST_SHAPE.test(host)) {
    throw new RoiSourceError(
      sourceId,
      "misconfigured",
      `${sourceId}: no valid pinned API host is configured for this source (the configured value is not echoed here because it can embed credentials); reconnect the source with the vendor's bare api host`,
    );
  }
  return host;
}

/**
 * The SSRF gate every credentialed read passes through. A parsed target URL is
 * accepted ONLY when it is https, sits EXACTLY on the source's pinned host, and
 * carries no credential material in userinfo/query/fragment. Any refusal is
 * typed and NON-ECHOING — the offending URL never reaches a message, a log, or
 * an operator surface. This is what makes "resolve the credential, then call"
 * safe: the credential can only ever be sent to the one host we pinned.
 */
export function assertPinnedApiHost(target: string, pinnedHost: string, sourceId: RoiSourceId): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new RoiSourceError(
      sourceId,
      "off_host_target",
      `${sourceId}: refused a request to a target that is not a valid absolute URL (the value is not echoed — it can embed credentials)`,
    );
  }
  if (url.protocol !== "https:") {
    throw new RoiSourceError(
      sourceId,
      "insecure_transport",
      `${sourceId}: refused a non-https request target (credentials are never sent in the clear; the target is not echoed)`,
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    // A credential in the URL is the exact class refuseBaseUrl kills: never
    // confirm it by echoing, just refuse the whole request.
    throw new RoiSourceError(
      sourceId,
      "credential_in_url",
      `${sourceId}: refused a request whose URL carried userinfo, a query, or a fragment (a credential can hide there); the target is not echoed`,
    );
  }
  if (url.hostname.toLowerCase() !== pinnedHost) {
    throw new RoiSourceError(
      sourceId,
      "off_host_target",
      `${sourceId}: refused a request whose host is not this source's pinned API host (SSRF guard); the target is not echoed`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Credentialed adapter config (deferred — real adapters consume this)  */
/* ------------------------------------------------------------------ */

/**
 * What a real ROI adapter is constructed with. It resolves the credential from
 * the vault at call time (never stores the revealed string), drives the
 * injected {@link FetchPort}, and pins its host via {@link resolvePinnedApiHost}.
 * The `configuredHost` is only read for the vendor-agnostic sources; for
 * GA4/GSC it is ignored (the fixed host wins).
 */
export interface RoiSourceAdapterConfig extends CredentialedAdapterConfig {
  fetch: FetchPort;
  /** Required for call_tracking/form_fills/crm; ignored for ga4/gsc. */
  configuredHost?: string;
}

/** Re-exported for adapter authors so they import the seam from one place. */
export type { SecretsResolver };

/* ------------------------------------------------------------------ */
/* In-memory fake (attribution / persistence / read tests)             */
/* ------------------------------------------------------------------ */

/**
 * Journaling test double: a CONNECTED source under full test control. Default
 * `fetchOutcomes` returns `samples: []` (measured-empty). `report()` scripts
 * the samples the next fetch returns; `failNext()` throws a typed
 * RoiSourceError (transport/rate-limit) to exercise the collection's failed vs
 * absent distinction. It never touches the network and never needs a
 * credential — modeling "not connected" is the resolver returning null, NOT
 * this fake.
 */
export class InMemoryRoiSource implements RoiSource {
  readonly sourceId: RoiSourceId;
  readonly vendor: string;
  readonly requests: RoiSourceRequest[] = [];
  private nextSamples: Array<{ metric: string; value: number }> | null = null;
  private nextError: RoiSourceError | null = null;

  constructor(sourceId: RoiSourceId, vendor = "in-memory") {
    this.sourceId = sourceId;
    this.vendor = vendor;
  }

  /** The next fetch returns these metric/value pairs as samples for its period. */
  report(samples: Array<{ metric: string; value: number }>): this {
    this.nextSamples = samples;
    return this;
  }

  /** The next fetch throws — `network_failure` (retryable) unless overridden. */
  failNext(
    code: RoiSourceErrorCode = "network_failure",
    message = "scripted source failure",
  ): this {
    this.nextError = new RoiSourceError(this.sourceId, code, message);
    return this;
  }

  async fetchOutcomes(request: RoiSourceRequest): Promise<RoiSourceResult> {
    this.requests.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const scripted = this.nextSamples ?? [];
    this.nextSamples = null;
    return {
      source: this.sourceId,
      vendor: this.vendor,
      period: request.period,
      samples: scripted.map((s) => ({
        source: this.sourceId,
        metric: s.metric,
        value: s.value,
        period: request.period,
      })),
    };
  }
}
