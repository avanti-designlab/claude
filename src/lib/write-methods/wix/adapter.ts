/**
 * WixAdapter — write method 3 of 4 (doc 04 §1: "partial auto-fix ... most
 * walled-garden of the four — build third"), implementing the frozen
 * `WriteMethodAdapter` port against the Wix REST APIs (www.wixapis.com):
 * the Pages surface for per-page SEO settings and the Wix Data API v2 for
 * CMS-collection items. FakeWix models exactly the API semantics this
 * adapter relies on; the §4 onboarding no-op verify proves them against the
 * live site per property before any write is possible.
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
 * LIVE-IMMEDIATE (the Wix-specific honesty line — the OPPOSITE of Webflow):
 * the surfaces this method writes have NO staged layer. A page-SEO PATCH and
 * a Data-item update change the LIVE site the moment the API accepts them —
 * there is no publish step to defer them behind, and no publish gate to catch
 * a bad change before visitors and crawlers see it. Consequences, stated
 * plainly rather than papered over:
 *  - the before-capture + verified revert IS the entire safety story for this
 *    method — which is exactly why the reversibility gates below are strict
 *    and why a value that cannot be restored byte-exact never gets written;
 *  - MONITOR correlation is SOUND against `site_changes.applied_at`: the live
 *    effect lands at apply time, so regression signals (M16/M3/M17) correlate
 *    directly with the recorded timestamp. This is explicitly UNLIKE Webflow,
 *    whose "applied" is staged-only and whose live effect lands at the
 *    client's next publish (see the 1.3 Webflow gate record's open
 *    correlation ticket — that ticket does NOT apply to this method).
 *
 * Safety properties, each proven by tests:
 *  - PINNED SITE (multi-tenant discipline): the adapter is constructed per
 *    property with the Wix site id (a metaSiteId GUID, validated at
 *    construction) + tenant/client/property ids. Every call re-asserts the
 *    AdapterContext against the pin — AND the pin IS the request scope: Wix
 *    API keys are account-level, so the `wix-site-id` header selects which of
 *    the account's sites a call touches, and this adapter sends the PINNED id
 *    on every request, always from construction state, never derived from a
 *    target or locator (the grammar has no site slot). The only site this
 *    instance can reach is the pinned one; a target living on another site is
 *    simply not visible inside that scope and 404s as target_missing. The API
 *    host itself is pinned outright: requests go to https://www.wixapis.com
 *    and nowhere else — any custom base URL that is not exactly that host is
 *    refused at construction (which also closes the SSRF class entirely). The
 *    target's page URL is never used for routing — it is only screened for
 *    embedded credentials.
 *  - PLAN-TIME REVERSIBILITY: unsupported operations and non-restorable
 *    values are refused before any HTTP call (see target.ts) — a change that
 *    could not be rolled back byte-exact never touches the site. The two
 *    gates that need live state are checked on every read AND pre-write on
 *    every write: a page SEO field that is UNSET (its value derives from the
 *    site-level SEO pattern — writing would create an un-restorable
 *    first-ever value) and a data-item field that is ABSENT or explicitly
 *    null (indistinguishable in the persisted diff).
 *  - FULL-REPLACE DISCIPLINE (Wix Data has no partial update): Update Data
 *    Item REPLACES the item's data, so a write here is read-fresh → swap
 *    EXACTLY the target field → PUT the whole item back. System fields
 *    (underscore-prefixed, server-managed) are stripped from the body and
 *    excluded from verification — `_updatedDate` changes on every write by
 *    definition. The echo is verified TWICE: the target field byte-exact
 *    against the value written, AND every sibling field byte-exact against
 *    the fresh-read value sent — on this surface a sibling divergence is OUR
 *    write's side effect, and it is never silent (write_verification_failed).
 *  - WRITE VERIFICATION: every write re-reads the stored value from the
 *    update echo and compares it byte-exact (jsonEqual) to what was sent. If
 *    Wix normalized or dropped it, the write is reported FAILED — on apply
 *    the row stays 'previewed'; on revert the row stays 'applied' and a human
 *    intervenes — instead of silently recording a state the site does not have.
 *  - CREDENTIALS (doc 04 §5): the Wix API key reaches this adapter only as a
 *    vault ref + SecretsResolver. It is resolved per call, revealed only into
 *    the Authorization header (Wix API keys are sent bare — no Basic/Bearer
 *    scheme), never stored on the instance, and never present in any error
 *    (errors are composed from status + sanitized slug only). The pinned host
 *    is https-only by construction, and every request states
 *    `redirect: "error"`, so the Authorization header can never be re-sent
 *    wherever a redirect points.
 *  - FAILURE HONESTY: 401/403 → credential_rejected; 404 → target_missing
 *    (within the pinned site's scope); 429 → rate_limited (the operation did
 *    NOT happen; the row stays retryable; the Retry-After hint is whitelisted
 *    digits or dropped; nothing retries automatically — an unattended retry
 *    loop would be an unattended write); HTML-instead-of-JSON (CDN/WAF
 *    interstitial) → unexpected_response; other API errors → vendor_failure;
 *    transport → network_failure. One field per write call — the manager's
 *    applyBatch stops at the first failure and reports the applied prefix
 *    exactly, so partial batches are rolled back member-by-member through
 *    this adapter.
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
import { looksLikeHtml, tryParseJson, type FetchPort } from "../shared/http";
import { refuseBaseUrl } from "../shared/refuse";
import {
  assertReversibleWixValue,
  describeWixOperation,
  parseWixTarget,
  type WixOperation,
} from "./target";

const METHOD: SiteChangeMethod = "wix";

/** The ONLY host this method ever talks to. Not configurable in production. */
export const WIX_API_HOST = "https://www.wixapis.com";

/** Wix site ids (metaSiteId) are GUIDs. */
const WIX_SITE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Retry-After whitelist: plain integer seconds only; anything else is dropped. */
const RETRY_AFTER_SECONDS = /^\d{1,6}$/;

/** The property this adapter instance is permanently pinned to. */
export interface WixSitePin {
  tenantId: string;
  clientId: string;
  propertyId: string;
  /**
   * The Wix site id (metaSiteId GUID) this connection may touch — and no
   * other. Sent as the `wix-site-id` header on EVERY request: Wix API keys
   * are account-level, so this header is what scopes each call to one site,
   * which makes the pin itself the isolation boundary.
   */
  siteId: string;
}

export interface WixAdapterConfig {
  site: WixSitePin;
  /** Vault seam: the API key is resolved per call, never held. */
  secrets: SecretsResolver;
  /**
   * Secrets-vault reference for this property's connection (never a raw
   * credential). The vaulted value is the Wix API key (sent bare in the
   * Authorization header — Wix API keys use no Basic/Bearer scheme).
   */
  authRef: string;
  /** Injected HTTP (global `fetch` in production; FakeWix in tests). */
  fetch: FetchPort;
  /**
   * Optional override that may only ever equal {@link WIX_API_HOST} — it
   * exists so a misconfiguration is refused LOUDLY at construction instead of
   * a request leaving for an attacker-chosen host. Anything else (http:,
   * other hosts, ports, paths) is `misconfigured`, and the rejected value is
   * never echoed (shared refuse-without-echo helper).
   */
  apiBaseUrl?: string;
}

export class WixAdapter implements WriteMethodAdapter {
  readonly method = METHOD;

  private readonly site: WixSitePin;
  /** `https://www.wixapis.com` — every request URL starts here. */
  private readonly apiRoot: string;
  private readonly secrets: SecretsResolver;
  private readonly authRef: string;
  private readonly fetchPort: FetchPort;

  constructor(config: WixAdapterConfig) {
    const base = config.apiBaseUrl ?? WIX_API_HOST;
    const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
    if (normalized !== WIX_API_HOST) {
      throw refuseBaseUrl(
        METHOD,
        config.site.propertyId,
        `is configured with a custom API base URL — this method talks only to ${WIX_API_HOST}`,
        "remove the override",
      );
    }
    if (!WIX_SITE_ID.test(config.site.siteId)) {
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `wix: property ${config.site.propertyId} has an unusable Wix site id (the value is not echoed; a valid id is a lowercase GUID, the site's metaSiteId) — reconnect the property`,
      );
    }
    this.site = config.site;
    this.apiRoot = WIX_API_HOST;
    this.secrets = config.secrets;
    this.authRef = config.authRef;
    this.fetchPort = config.fetch;
  }

  /* ---------------------------------------------------------------- */
  /* WriteMethodAdapter                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Read the LIVE value at a target (the pipeline's before-capture + the §4
   * onboarding no-op verify). Values a later rollback could NOT restore
   * byte-exact (an unset/inherited page field, an absent or explicitly-null
   * data field) are refused here — plan time, not rollback time.
   */
  async readCurrent(target: ChangeTarget, ctx: AdapterContext): Promise<Json> {
    const op = this.plan(target, ctx);
    const what = `read ${describeWixOperation(op)}`;
    let value: Json;
    if (op.kind === "page") {
      const payload = await this.request("GET", pageRoute(op), undefined, what);
      value = this.extractPageField(op, payload, what);
    } else {
      const payload = await this.request(
        "GET",
        dataItemReadRoute(op),
        undefined,
        what,
      );
      value = this.extractDataField(op, this.dataOf(payload, what), what);
    }
    assertReversibleWixValue(op, value, "live");
    return value;
  }

  /** Install the approved after-state (one field, one verified write). */
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
    assertReversibleWixValue(op, write.before, "before");
    assertReversibleWixValue(op, write.after, "after");

    const value = direction === "apply" ? write.after : write.before;
    const what = `${direction} ${describeWixOperation(op)}`;

    if (op.kind === "page") {
      await this.writePageField(op, value, what);
    } else {
      await this.writeDataField(op, value, what);
    }
  }

  /**
   * Page SEO write: a fresh pre-write GET gates the live-state reversibility
   * line (an UNSET field inherits the site's SEO pattern — installing a
   * first-ever explicit value could never be rolled back to "inherit", so it
   * is refused before the PATCH leaves), then a single-key merge-PATCH whose
   * echo is verified byte-exact. LIVE the moment the PATCH is accepted.
   */
  private async writePageField(
    op: Extract<WixOperation, { kind: "page" }>,
    value: Json,
    what: string,
  ): Promise<void> {
    const current = await this.request("GET", pageRoute(op), undefined, what);
    // The live field must be a SET string — the same gate readCurrent applies.
    assertReversibleWixValue(
      op,
      this.extractPageField(op, current, what),
      "live",
    );

    const payload = await this.request(
      "PATCH",
      pageRoute(op),
      JSON.stringify({ page: { seoData: { [op.attr]: value } } }),
      what,
    );
    const stored = this.extractPageField(op, payload, what);
    if (!jsonEqual(stored, value)) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `wix ${what}: the site stored a different value than the one written — Wix normalized or rewrote it (the LIVE site may now hold the altered value); adjust the change before retrying`,
      );
    }
  }

  /**
   * Data-item write under Wix's FULL-REPLACE update: read the item fresh,
   * swap exactly the target field, PUT the whole item back (system fields
   * stripped — server-managed), then verify the echo twice: target field
   * byte-exact against the value written, and every sibling byte-exact
   * against the fresh-read value sent. On a full-replace surface a sibling
   * divergence is OUR write's side effect — it is never allowed to be silent.
   */
  private async writeDataField(
    op: Extract<WixOperation, { kind: "data" }>,
    value: Json,
    what: string,
  ): Promise<void> {
    const current = await this.request(
      "GET",
      dataItemReadRoute(op),
      undefined,
      what,
    );
    const currentData = this.dataOf(current, what);
    // The target must exist as a SET field before it can be replaced — the
    // same live-state gates readCurrent applies (defense in depth: the
    // pipeline's before-capture already refused; a direct retry re-checks).
    assertReversibleWixValue(
      op,
      this.extractDataField(op, currentData, what),
      "live",
    );

    const sent = { ...userFieldsOf(currentData), [op.fieldKey]: value };
    const payload = await this.request(
      "PUT",
      `wix-data/v2/items/${op.itemId}`,
      JSON.stringify({
        dataCollectionId: op.collectionId,
        dataItem: { data: sent },
      }),
      what,
    );

    const echoed = userFieldsOf(this.dataOf(payload, what));
    const storedTarget = Object.prototype.hasOwnProperty.call(
      echoed,
      op.fieldKey,
    )
      ? echoed[op.fieldKey]
      : null;
    if (!jsonEqual(storedTarget, value)) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `wix ${what}: the site stored a different value than the one written — Wix normalized or rewrote it (the LIVE site may now hold the altered value); adjust the change before retrying`,
      );
    }
    // Sibling verification: everything this full-replace PUT carried besides
    // the target must have landed byte-exact, or the write ALTERED data it
    // was never approved to change.
    const siblingsSent: { [k: string]: Json } = { ...sent };
    delete siblingsSent[op.fieldKey];
    const siblingsEchoed: { [k: string]: Json } = { ...echoed };
    delete siblingsEchoed[op.fieldKey];
    if (!jsonEqual(siblingsSent, siblingsEchoed)) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `wix ${what}: the item's OTHER fields came back different from the values re-written around this change — Wix Data updates replace the whole item, so a sibling divergence means this write altered data it was not approved to change (the LIVE site may now hold the altered values); investigate before retrying`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Site pinning (multi-tenant discipline, doc 04 §5)                 */
  /* ---------------------------------------------------------------- */

  private plan(target: ChangeTarget, ctx: AdapterContext): WixOperation {
    this.assertPinnedProperty(ctx);
    this.assertTargetUrlCarriesNoCredential(target);
    return parseWixTarget(target);
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
        `wix: this connection is pinned to property ${pin.propertyId} (tenant ${pin.tenantId}, client ${pin.clientId}) — refusing an operation routed for property ${ctx.propertyId} (tenant ${ctx.tenantId}, client ${ctx.clientId})`,
      );
    }
  }

  /**
   * The target's page URL is NEVER used for routing (the pinned `wix-site-id`
   * header scopes every request to one site, and a Wix site's free/premium
   * domains make URL-origin checks unsound). It is only screened here: a
   * userinfo-bearing or unparseable URL may itself carry a credential, so it
   * is refused — and never echoed.
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
        "wix: the change target's URL is not parseable — refused without being echoed (a malformed URL can embed credentials)",
      );
    }
    if (resolved.username || resolved.password) {
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        "wix: the change target's URL embeds credentials (userinfo) — credentials live in the secrets vault (auth_ref), never in a URL; refusing the operation before any request",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTTP + response honesty                                           */
  /* ---------------------------------------------------------------- */

  /**
   * One authenticated request against the pinned host, ALWAYS scoped to the
   * pinned site: the `wix-site-id` header comes from construction state on
   * every call — never from a target, locator, or response — so this instance
   * is structurally incapable of addressing any other site even though the
   * account-level API key could.
   */
  private async request(
    method: "GET" | "PATCH" | "PUT",
    route: string,
    body: string | undefined,
    what: string,
  ): Promise<Json> {
    const url = `${this.apiRoot}/${route}`;

    // Vault seam: resolved per call; the revealed string exists only inside
    // the header expression below — never on `this`, never in an error. Wix
    // API keys are sent bare in the Authorization header (no Basic/Bearer).
    const credential = await this.secrets.resolve(this.authRef, {
      tenantId: this.site.tenantId,
      clientId: this.site.clientId,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: credential.reveal(),
      "wix-site-id": this.site.siteId,
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
        `wix ${what}: could not reach ${WIX_API_HOST}${detail ? ` (${detail})` : ""} — the request failed at the transport level (DNS, TLS, timeout, or a refused redirect); check connectivity and retry`,
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
        `wix ${what}: the Wix API refused this connection's API key (HTTP ${status}${slug}) — it may be revoked, rotated, or missing the Wix Data / site permissions; reconnect the property`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 404) {
      throw new WriteMethodError(
        METHOD,
        "target_missing",
        `wix ${what}: the target does not exist on the connected Wix site (HTTP 404${slug}) — the page, collection, or item may have been deleted since the audit (every request is scoped to this connection's pinned site, so a target on any other site is not visible here)`,
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
        `wix ${what}: the Wix API rate limit rejected this call (HTTP 429${slug}) — the operation was NOT performed and the change stays retryable; re-run the same action${retryAfterSeconds !== undefined ? ` after ~${retryAfterSeconds}s` : " shortly"} (nothing retries automatically)`,
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
          ? `wix ${what}: the API answered with an HTML page instead of an API response (HTTP ${status}) — usually a proxy or challenge page in front of www.wixapis.com; retry, and reconnect the property if it persists`
          : `wix ${what}: the API's response was not valid JSON (HTTP ${status}) — the request may have been intercepted`,
        { httpStatus: status },
      );
    }
    if (status < 200 || status >= 300) {
      throw new WriteMethodError(
        METHOD,
        "vendor_failure",
        `wix ${what}: the Wix API reported an error (HTTP ${status}${slug})`,
        { httpStatus: status, vendorCode },
      );
    }
    return parsed.value as Json;
  }

  /**
   * Pull the error envelope's code slug — sanitized, never free text. Wix
   * errors carry either a top-level `code` or a nested
   * `details.applicationError.code`; both pass through the same whitelist.
   */
  private vendorCodeOf(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const envelope = payload as { [k: string]: unknown };
    const topLevel = safeVendorCode(envelope.code);
    if (topLevel) return topLevel;
    const details = envelope.details;
    if (details === null || typeof details !== "object") return undefined;
    const appError = (details as { [k: string]: unknown }).applicationError;
    if (appError === null || typeof appError !== "object") return undefined;
    return safeVendorCode((appError as { [k: string]: unknown }).code);
  }

  /**
   * Extract a page operation's field from a Pages payload — strictly. A
   * missing key is an UNSET field (its rendered value derives from the
   * site-level SEO pattern) — normalized to null so the value gate (or the
   * byte-exact echo comparison) produces the honest failure.
   */
  private extractPageField(
    op: Extract<WixOperation, { kind: "page" }>,
    payload: Json,
    what: string,
  ): Json {
    const envelope = this.entityOf(payload, what);
    const page = envelope.page;
    if (page === null || typeof page !== "object" || Array.isArray(page)) {
      throw this.unexpectedShape(what, "the API response has no page object");
    }
    const seoData = (page as { [k: string]: Json }).seoData;
    if (seoData === null || typeof seoData !== "object" || Array.isArray(seoData)) {
      throw this.unexpectedShape(what, "the API response has no seoData object");
    }
    const value = (seoData as { [k: string]: Json })[op.attr];
    return value === undefined ? null : value;
  }

  /**
   * Extract a data operation's field from an item's `data` — strictly. A key
   * absent from the data means the collection has no such field OR the field
   * has never been given a value; both are un-restorable (and explicit-null
   * is indistinguishable from absent in the persisted diff), and we say so
   * instead of guessing.
   */
  private extractDataField(
    op: Extract<WixOperation, { kind: "data" }>,
    data: { [k: string]: Json },
    what: string,
  ): Json {
    if (!Object.prototype.hasOwnProperty.call(data, op.fieldKey)) {
      throw new WriteMethodError(
        METHOD,
        "target_missing",
        `wix ${what}: the field '${op.fieldKey}' is not present on this item — either the collection has no field with that key, or the field has never been given a value; a first-ever value could not be rolled back to 'unset' byte-exact, so this fix must start from an item that already carries the field`,
      );
    }
    return data[op.fieldKey];
  }

  /** Unwrap `{ dataItem: { data } }` from a Wix Data payload — strictly. */
  private dataOf(payload: Json, what: string): { [k: string]: Json } {
    const envelope = this.entityOf(payload, what);
    const dataItem = envelope.dataItem;
    if (
      dataItem === null ||
      typeof dataItem !== "object" ||
      Array.isArray(dataItem)
    ) {
      throw this.unexpectedShape(what, "the API response has no dataItem object");
    }
    const data = (dataItem as { [k: string]: Json }).data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw this.unexpectedShape(what, "the API response has no dataItem.data object");
    }
    return data as { [k: string]: Json };
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
      `wix ${what}: ${why} — the API surface may have changed or the response was intercepted`,
    );
  }
}

/** Pages route (GET + merge-PATCH share it). */
function pageRoute(op: Extract<WixOperation, { kind: "page" }>): string {
  return `site-pages/v1/pages/${op.pageId}`;
}

/** Wix Data read route: the item by id, the collection as a query param. */
function dataItemReadRoute(
  op: Extract<WixOperation, { kind: "data" }>,
): string {
  return `wix-data/v2/items/${op.itemId}?dataCollectionId=${op.collectionId}`;
}

/**
 * User fields only: strip the server-managed system-field namespace (every
 * underscore-prefixed key — `_id`, `_owner`, `_createdDate`, `_updatedDate`,
 * and whatever Wix adds next). System fields are never sent in an update body
 * and never take part in write verification.
 */
function userFieldsOf(data: { [k: string]: Json }): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}
