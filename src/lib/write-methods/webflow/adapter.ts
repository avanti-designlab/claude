/**
 * WebflowAdapter — write method 2 of 4 (doc 04 §1: "auto-fix (workable) —
 * build second"), implementing the frozen `WriteMethodAdapter` port against
 * the Webflow Data API v2.
 *
 * Where it sits (doc 04 §2 — THE non-negotiable): this adapter is driven ONLY
 * by the ChangeManager. The pipeline captures the byte-exact live before-state
 * through `readCurrent` BEFORE `apply` writes anything (that captured state is
 * persisted as `site_changes.diff.before` — the authoritative rollback
 * baseline), and rollback calls `revert`, which writes that before-state back
 * through this same adapter. The adapter itself is two symmetric,
 * unconditional single-field writes plus an honest read — no adapter-level
 * state, no fire-and-forget path, no conditional "smart" writes (the manager
 * owns drift + clobber semantics; see its ordering comments).
 *
 * STAGED, NEVER PUBLISHED (the Webflow-specific reversibility line): every
 * write this adapter performs lands in Webflow's STAGED state — the page-
 * metadata and item PATCH endpoints, never the publish or `/items/{id}/live`
 * endpoints. The LIVE site is byte-untouched by an apply AND by a revert;
 * going live stays with the change-management pipeline's explicit publish
 * flow. This is what keeps every operation round-trippable: a staged value is
 * restorable byte-exact, a publish (content + prior publish state together)
 * is not, so publishing is not an operation of this method at all (rejected
 * at the grammar — see target.ts).
 *
 * Safety properties, each proven by tests:
 *  - PINNED SITE (multi-tenant discipline): the adapter is constructed per
 *    property with the Webflow site id + tenant/client/property ids. Every
 *    call re-asserts the AdapterContext against the pin, AND asserts at the
 *    API level that the target belongs to the pinned site BEFORE any write:
 *    a page read echoes its `siteId` (asserted against the pin); an item's
 *    collection must appear in the pinned site's own collection list (the
 *    item payload carries no site id, so membership is proven through
 *    `/sites/{pinned}/collections` — one extra read per item call, safety
 *    over request-count). A mis-routed target is refused as
 *    `cross_site_target` pre-write. The API host itself is pinned outright:
 *    requests go to https://api.webflow.com and nowhere else — any custom
 *    base URL that is not exactly that host is refused at construction
 *    (which also closes the SSRF class entirely). The target's page URL is
 *    never used for routing (site identity is proven at the API level, and a
 *    Webflow site's many domains make URL-origin checks unsound) — it is
 *    only screened for embedded credentials.
 *  - PLAN-TIME REVERSIBILITY: unsupported operations and non-restorable
 *    values are refused before any HTTP call (see target.ts) — a change that
 *    could not be rolled back byte-exact never touches the site. The one gate
 *    that needs live state — a page whose Open Graph field MIRRORS its SEO
 *    field (titleCopied/descriptionCopied) — is checked pre-write on every
 *    read AND every write.
 *  - WRITE VERIFICATION: every write re-reads the stored value from the PATCH
 *    echo and compares it byte-exact (jsonEqual) to what was sent. If Webflow
 *    normalized or dropped it, the write is reported FAILED — on apply the
 *    row stays 'previewed'; on revert the row stays 'applied' and a human
 *    intervenes — instead of silently recording a state the site does not have.
 *  - CREDENTIALS (doc 04 §5): the Webflow API token reaches this adapter only
 *    as a vault ref + SecretsResolver. It is resolved per call, revealed only
 *    into the Bearer Authorization header, never stored on the instance, and
 *    never present in any error (errors are composed from status + sanitized
 *    slug only). The pinned host is https-only by construction, and every
 *    request states `redirect: "error"`, so the Authorization header can
 *    never be re-sent wherever a redirect points.
 *  - FAILURE HONESTY: 401/403 → credential_rejected; 404 → target_missing;
 *    429 → rate_limited (the operation did NOT happen; the row stays
 *    retryable; the Retry-After hint is whitelisted digits or dropped;
 *    nothing retries automatically — an unattended retry loop would be an
 *    unattended write); HTML-instead-of-JSON (CDN/WAF interstitial) →
 *    unexpected_response; other API errors → vendor_failure; transport →
 *    network_failure. One field per write call — the manager's applyBatch
 *    stops at the first failure and reports the applied prefix exactly, so
 *    partial batches are rolled back member-by-member through this adapter.
 */

import {
  jsonEqual,
  type AdapterContext,
  type AdapterWrite,
  type ChangeTarget,
  type WriteMethodAdapter,
} from "@/lib/change-management";
import type { SecretsResolver } from "@/lib/connectors";
import type { Json, SiteChangeMethod } from "@/lib/types/db";
import {
  safeTransportDetail,
  safeVendorCode,
  WriteMethodError,
} from "../shared/errors";
import {
  bearerAuthHeader,
  looksLikeHtml,
  tryParseJson,
  type FetchPort,
} from "../shared/http";
import {
  assertReversibleWebflowValue,
  describeWebflowOperation,
  parseWebflowTarget,
  webflowRouteFor,
  type WebflowOperation,
} from "./target";

const METHOD: SiteChangeMethod = "webflow";

/** The ONLY host this method ever talks to. Not configurable in production. */
export const WEBFLOW_API_HOST = "https://api.webflow.com";

/** Webflow object ids are exactly 24 lowercase hex characters. */
const WEBFLOW_ID = /^[0-9a-f]{24}$/;

/** Retry-After whitelist: plain integer seconds only; anything else is dropped. */
const RETRY_AFTER_SECONDS = /^\d{1,6}$/;

/** The property this adapter instance is permanently pinned to. */
export interface WebflowSitePin {
  tenantId: string;
  clientId: string;
  propertyId: string;
  /** The Webflow site id this connection may touch — and no other. */
  siteId: string;
}

export interface WebflowAdapterConfig {
  site: WebflowSitePin;
  /** Vault seam: the API token is resolved per call, never held. */
  secrets: SecretsResolver;
  /**
   * Secrets-vault reference for this property's connection (never a raw
   * credential). The vaulted value is the Webflow API token (Bearer).
   */
  authRef: string;
  /** Injected HTTP (global `fetch` in production; FakeWebflow in tests). */
  fetch: FetchPort;
  /**
   * Optional override that may only ever equal {@link WEBFLOW_API_HOST} — it
   * exists so a misconfiguration is refused LOUDLY at construction instead of
   * a request leaving for an attacker-chosen host. Anything else (http:,
   * other hosts, ports, paths) is `misconfigured`, and the rejected value is
   * never echoed (a pasted "base URL" is exactly where a credential lands by
   * mistake).
   */
  apiBaseUrl?: string;
}

export class WebflowAdapter implements WriteMethodAdapter {
  readonly method = METHOD;

  private readonly site: WebflowSitePin;
  /** `https://api.webflow.com/v2` — every request URL starts here. */
  private readonly apiRoot: string;
  private readonly secrets: SecretsResolver;
  private readonly authRef: string;
  private readonly fetchPort: FetchPort;

  constructor(config: WebflowAdapterConfig) {
    const base = config.apiBaseUrl ?? WEBFLOW_API_HOST;
    const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
    if (normalized !== WEBFLOW_API_HOST) {
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `webflow: property ${config.site.propertyId} is configured with a custom API base URL — this method talks only to ${WEBFLOW_API_HOST} (the configured value is not echoed here because base URLs can embed credentials); remove the override`,
      );
    }
    if (!WEBFLOW_ID.test(config.site.siteId)) {
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `webflow: property ${config.site.propertyId} has an unusable Webflow site id (the value is not echoed; a valid id is 24 lowercase hex characters) — reconnect the property`,
      );
    }
    this.site = config.site;
    this.apiRoot = `${WEBFLOW_API_HOST}/v2`;
    this.secrets = config.secrets;
    this.authRef = config.authRef;
    this.fetchPort = config.fetch;
  }

  /* ---------------------------------------------------------------- */
  /* WriteMethodAdapter                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Read the live STAGED value at a target (the pipeline's before-capture +
   * the §4 onboarding no-op verify). Values a later rollback could NOT
   * restore byte-exact (an unset field, a mirrored OG field) are refused
   * here — plan time, not rollback time.
   */
  async readCurrent(target: ChangeTarget, ctx: AdapterContext): Promise<Json> {
    const op = this.plan(target, ctx);
    const what = `read ${describeWebflowOperation(op)}`;
    let value: Json;
    if (op.kind === "page") {
      const entity = await this.fetchPinnedPage(op, what);
      value = this.extractPageField(op, entity, what, "pre_write");
    } else {
      await this.assertCollectionOnPinnedSite(op, what);
      const entity = await this.request("GET", webflowRouteFor(op), undefined, what);
      value = this.extractItemField(op, entity, what);
    }
    assertReversibleWebflowValue(op, value, "live");
    return value;
  }

  /** Install the approved after-state (one field, one PATCH, verified). */
  async apply(write: AdapterWrite): Promise<void> {
    await this.writeValue(write, "apply");
  }

  /** Restore the captured before-state through the SAME surface as apply. */
  async revert(write: AdapterWrite): Promise<void> {
    await this.writeValue(write, "revert");
  }

  /* ---------------------------------------------------------------- */
  /* The single write path (apply and revert are the same machine)     */
  /* ---------------------------------------------------------------- */

  private async writeValue(
    write: AdapterWrite,
    direction: "apply" | "revert",
  ): Promise<void> {
    const op = this.plan(write.target, write.ctx);
    // BOTH directions must be installable BEFORE any network call: refusing a
    // non-restorable `before` here is what guarantees rollback can never
    // discover an impossible restore (doc 04 §2).
    assertReversibleWebflowValue(op, write.before, "before");
    assertReversibleWebflowValue(op, write.after, "after");

    const value = direction === "apply" ? write.after : write.before;
    const what = `${direction} ${describeWebflowOperation(op)}`;

    // PRE-WRITE site verification (doc 04 §5): the target must provably belong
    // to the pinned site BEFORE the PATCH leaves — a page's own read echoes
    // its siteId; an item's collection must be listed by the pinned site. For
    // OG fields the same pre-read also gates the mirror flag: a mirrored field
    // is refused here as unsupported, before any write.
    if (op.kind === "page") {
      const current = await this.fetchPinnedPage(op, what);
      this.extractPageField(op, current, what, "pre_write");
    } else {
      await this.assertCollectionOnPinnedSite(op, what);
    }

    const payload = await this.request(
      "PATCH",
      webflowRouteFor(op),
      JSON.stringify(updateBodyFor(op, value)),
      what,
    );

    // Byte-exactness verification: the PATCH echoes the stored entity; if the
    // stored value differs from what was sent (server normalization, a
    // silently-ignored mirrored field, a dropped key), the write FAILED as far
    // as change management is concerned. For pages the echo's siteId is
    // re-asserted too — the write must have landed on the pinned site.
    if (op.kind === "page") this.assertPageOnPinnedSite(payload, what);
    const stored =
      op.kind === "page"
        ? this.extractPageField(op, payload, what, "post_write")
        : this.extractItemField(op, payload, what);
    if (!jsonEqual(stored, value)) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `webflow ${what}: the site stored a different value than the one written — Webflow normalized or rewrote it (the site may now hold the altered value); adjust the change before retrying`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Site pinning (multi-tenant discipline, doc 04 §5)                 */
  /* ---------------------------------------------------------------- */

  private plan(target: ChangeTarget, ctx: AdapterContext): WebflowOperation {
    this.assertPinnedProperty(ctx);
    this.assertTargetUrlCarriesNoCredential(target);
    return parseWebflowTarget(target);
  }

  /** The call's context must be the pinned property — no cross-routing. */
  private assertPinnedProperty(ctx: AdapterContext): void {
    const pin = this.site;
    if (
      ctx.tenantId !== pin.tenantId ||
      ctx.clientId !== pin.clientId ||
      ctx.propertyId !== pin.propertyId
    ) {
      throw new WriteMethodError(
        METHOD,
        "property_mismatch",
        `webflow: this connection is pinned to property ${pin.propertyId} (tenant ${pin.tenantId}, client ${pin.clientId}) — refusing an operation routed for property ${ctx.propertyId} (tenant ${ctx.tenantId}, client ${ctx.clientId})`,
      );
    }
  }

  /**
   * The target's page URL is NEVER used for routing (identity is proven at
   * the API level via siteId / collection membership — a Webflow site answers
   * on several domains, so URL-origin checks would be unsound). It is only
   * screened here: a userinfo-bearing or unparseable URL may itself carry a
   * credential, so it is refused — and never echoed.
   */
  private assertTargetUrlCarriesNoCredential(target: ChangeTarget): void {
    let resolved: URL;
    try {
      // The base only anchors RELATIVE urls for parsing; nothing is requested.
      resolved = new URL(target.url, "https://target-page.invalid/");
    } catch {
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        "webflow: the change target's URL is not parseable — refused without being echoed (a malformed URL can embed credentials)",
      );
    }
    if (resolved.username || resolved.password) {
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        "webflow: the change target's URL embeds credentials (userinfo) — credentials live in the secrets vault (auth_ref), never in a URL; refusing the operation before any request",
      );
    }
  }

  /** GET the page and prove it belongs to the pinned site (else cross_site_target). */
  private async fetchPinnedPage(
    op: Extract<WebflowOperation, { kind: "page" }>,
    what: string,
  ): Promise<Json> {
    const payload = await this.request("GET", webflowRouteFor(op), undefined, what);
    this.assertPageOnPinnedSite(payload, what);
    return payload;
  }

  private assertPageOnPinnedSite(payload: Json, what: string): void {
    const entity = this.entityOf(payload, what);
    const siteId = entity.siteId;
    if (typeof siteId !== "string") {
      throw this.unexpectedShape(what, "the API response carries no siteId");
    }
    if (siteId !== this.site.siteId) {
      throw new WriteMethodError(
        METHOD,
        "cross_site_target",
        `webflow ${what}: the page belongs to a different Webflow site than this connection's pinned site — a write is never routed across sites`,
      );
    }
  }

  /**
   * Prove the collection belongs to the pinned site BEFORE touching the item.
   * Item payloads carry no site id, so membership is established through the
   * pinned site's OWN collection list — built from the pinned id, so a foreign
   * collection simply is not there. Checked fresh per call (no cached
   * topology): a collection moved/deleted between calls fails closed.
   */
  private async assertCollectionOnPinnedSite(
    op: Extract<WebflowOperation, { kind: "item" }>,
    what: string,
  ): Promise<void> {
    const payload = await this.request(
      "GET",
      `sites/${this.site.siteId}/collections`,
      undefined,
      what,
    );
    const collections = this.entityOf(payload, what).collections;
    if (!Array.isArray(collections)) {
      throw this.unexpectedShape(what, "the API response has no collections list");
    }
    const member = collections.some(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        (c as { [k: string]: Json }).id === op.collectionId,
    );
    if (!member) {
      throw new WriteMethodError(
        METHOD,
        "cross_site_target",
        `webflow ${what}: collection ${op.collectionId} is not a collection of this connection's pinned Webflow site — a write is never routed across sites; refused before any request touched the target`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTTP + response honesty                                           */
  /* ---------------------------------------------------------------- */

  /** One authenticated Data API v2 request against the pinned host. */
  private async request(
    method: "GET" | "PATCH",
    route: string,
    body: string | undefined,
    what: string,
  ): Promise<Json> {
    const url = `${this.apiRoot}/${route}`;

    // Vault seam: resolved per call; the revealed string exists only inside
    // the header expression below — never on `this`, never in an error.
    const credential = await this.secrets.resolve(this.authRef, {
      tenantId: this.site.tenantId,
      clientId: this.site.clientId,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: bearerAuthHeader(credential.reveal()),
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let status: number;
    let text: string;
    let retryAfterHeader: string | null;
    try {
      // `redirect: "error"` — a write must land at exactly the URL it was
      // sent to; the port never follows a redirect (see FetchPortInit), so a
      // redirecting endpoint rejects here and surfaces as network_failure.
      const res = await this.fetchPort(url, {
        method,
        headers,
        body,
        redirect: "error",
      });
      status = res.status;
      retryAfterHeader = res.headers.get("retry-after");
      text = await res.text();
    } catch (err) {
      // The transport detail is WHITELISTED (safeTransportDetail): only a
      // machine-style code or error name — never err.message, which can carry
      // arbitrary resolver/proxy/middlebox text.
      const detail = safeTransportDetail(err);
      throw new WriteMethodError(
        METHOD,
        "network_failure",
        `webflow ${what}: could not reach ${WEBFLOW_API_HOST}${detail ? ` (${detail})` : ""} — the request failed at the transport level (DNS, TLS, timeout, or a refused redirect); check connectivity and retry`,
      );
    }
    return this.decode(status, text, retryAfterHeader, what);
  }

  /** Map a raw HTTP outcome to the typed contract — or the expected JSON payload. */
  private decode(
    status: number,
    text: string,
    retryAfterHeader: string | null,
    what: string,
  ): Json {
    const parsed = tryParseJson(text);
    const vendorCode = parsed.ok ? this.vendorCodeOf(parsed.value) : undefined;
    const slug = vendorCode ? ` [${vendorCode}]` : "";

    if (status === 401 || status === 403) {
      throw new WriteMethodError(
        METHOD,
        "credential_rejected",
        `webflow ${what}: the Webflow API refused this connection's token (HTTP ${status}${slug}) — it may be revoked, rotated, or missing the cms:write / pages:write scopes; reconnect the property`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 404) {
      throw new WriteMethodError(
        METHOD,
        "target_missing",
        `webflow ${what}: the target does not exist on Webflow (HTTP 404${slug}) — the page or item may have been deleted since the audit, or this connection's token may have lost access to the site`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 429) {
      // Rate limit: the operation was REJECTED, not performed — the change
      // row stays in its pre-call status and the same action can simply be
      // re-run. The Retry-After hint survives only as whitelisted digits.
      // Nothing here (or in the pipeline) retries automatically: an
      // unattended retry loop would be an unattended write.
      const retryAfterSeconds =
        retryAfterHeader !== null && RETRY_AFTER_SECONDS.test(retryAfterHeader)
          ? Number(retryAfterHeader)
          : undefined;
      throw new WriteMethodError(
        METHOD,
        "rate_limited",
        `webflow ${what}: the Webflow API rate limit rejected this call (HTTP 429${slug}) — the operation was NOT performed and the change stays retryable; re-run the same action${retryAfterSeconds !== undefined ? ` after ~${retryAfterSeconds}s` : " shortly"} (nothing retries automatically)`,
        { httpStatus: status, vendorCode, retryAfterSeconds },
      );
    }
    if (!parsed.ok) {
      // A CDN/WAF challenge page or proxy interstitial answering HTML (or any
      // non-JSON) where the API was promised.
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        looksLikeHtml(text)
          ? `webflow ${what}: the API answered with an HTML page instead of an API response (HTTP ${status}) — usually a proxy or challenge page in front of api.webflow.com; retry, and reconnect the property if it persists`
          : `webflow ${what}: the API's response was not valid JSON (HTTP ${status}) — the request may have been intercepted`,
        { httpStatus: status },
      );
    }
    if (status < 200 || status >= 300) {
      throw new WriteMethodError(
        METHOD,
        "vendor_failure",
        `webflow ${what}: the Webflow API reported an error (HTTP ${status}${slug})`,
        { httpStatus: status, vendorCode },
      );
    }
    return parsed.value as Json;
  }

  /** Pull the v2 error envelope's `code` slug — sanitized, never free text. */
  private vendorCodeOf(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    return safeVendorCode((payload as { [k: string]: unknown }).code);
  }

  /**
   * Extract a page operation's field from a Page payload — strictly. The OG
   * mirror flag is enforced here: pre-write a mirrored field is an
   * UNSUPPORTED operation (its value is derived from the SEO field, and the
   * flag cannot be restored alongside the value); post-write a flag that
   * turned out mirrored means the site diverged from what was written.
   */
  private extractPageField(
    op: Extract<WebflowOperation, { kind: "page" }>,
    payload: Json,
    what: string,
    phase: "pre_write" | "post_write",
  ): Json {
    const entity = this.entityOf(payload, what);
    const groupKey = op.group === "seo" ? "seo" : "openGraph";
    const group = entity[groupKey];
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      throw this.unexpectedShape(what, `the API response has no ${groupKey} object`);
    }
    const fields = group as { [k: string]: Json };

    if (op.group === "og") {
      const flagKey = op.attr === "title" ? "titleCopied" : "descriptionCopied";
      const flag = fields[flagKey];
      if (typeof flag !== "boolean") {
        throw this.unexpectedShape(what, `the API response has no ${flagKey} flag`);
      }
      if (flag) {
        throw phase === "pre_write"
          ? new WriteMethodError(
              METHOD,
              "unsupported_operation",
              `webflow ${what}: this page's Open Graph ${op.attr} MIRRORS its SEO ${op.attr} (${flagKey} is on) — the mirrored value is derived, and the mirror flag cannot be restored byte-exact alongside the value in a single-field write; write the SEO ${op.attr} instead, or turn the mirror off in Webflow first`,
            )
          : new WriteMethodError(
              METHOD,
              "write_verification_failed",
              `webflow ${what}: after the write, the site reports the Open Graph ${op.attr} is mirroring the SEO ${op.attr} (${flagKey} turned on) — the stored state diverged from the value written`,
            );
      }
    }

    const value = fields[op.attr];
    // A missing key is an unset field — normalized to null so the value gate
    // (or the byte-exact echo comparison) produces the honest failure.
    return value === undefined ? null : value;
  }

  /**
   * Extract an item operation's field from an Item payload — strictly. A key
   * that is absent from `fieldData` means the collection has no such field OR
   * the field has never been given a value (Webflow omits unset optional
   * fields); both are un-restorable, and we say so instead of guessing.
   */
  private extractItemField(
    op: Extract<WebflowOperation, { kind: "item" }>,
    payload: Json,
    what: string,
  ): Json {
    const entity = this.entityOf(payload, what);
    const fieldData = entity.fieldData;
    if (
      fieldData === null ||
      typeof fieldData !== "object" ||
      Array.isArray(fieldData)
    ) {
      throw this.unexpectedShape(what, "the API response has no fieldData object");
    }
    const fields = fieldData as { [k: string]: Json };
    if (!Object.prototype.hasOwnProperty.call(fields, op.fieldSlug)) {
      throw new WriteMethodError(
        METHOD,
        "target_missing",
        `webflow ${what}: the field '${op.fieldSlug}' is not present on this item — either the collection has no field with that slug, or the field has never been given a value (Webflow omits unset optional fields); a first-ever value could not be rolled back to 'unset' byte-exact, so this fix must start from an item that already carries the field`,
      );
    }
    return fields[op.fieldSlug];
  }

  private entityOf(payload: Json, what: string): { [k: string]: Json } {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw this.unexpectedShape(what, "the API response was not an object");
    }
    return payload as { [k: string]: Json };
  }

  private unexpectedShape(what: string, why: string): WriteMethodError {
    return new WriteMethodError(
      METHOD,
      "unexpected_response",
      `webflow ${what}: ${why} — the API surface may have changed or the response was intercepted`,
    );
  }
}

/** Data API v2 update body per operation (exactly one field per write). */
function updateBodyFor(
  op: WebflowOperation,
  value: Json,
): { [key: string]: Json } {
  if (op.kind === "item") {
    return { fieldData: { [op.fieldSlug]: value } };
  }
  return op.group === "seo"
    ? { seo: { [op.attr]: value } }
    : { openGraph: { [op.attr]: value } };
}
