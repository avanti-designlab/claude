/**
 * WordPressAdapter — write method 1 of 4 (doc 04 §1: "gold standard, highest
 * coverage — build first"), implementing the frozen `WriteMethodAdapter` port
 * against the WordPress REST API (wp/v2).
 *
 * Where it sits (doc 04 §2 — THE non-negotiable): this adapter is driven ONLY
 * by the ChangeManager. The pipeline captures the byte-exact live before-state
 * through `readCurrent` BEFORE `apply` writes anything (that captured state is
 * persisted as `site_changes.diff.before` — the authoritative rollback
 * baseline), and rollback calls `revert`, which writes that before-state back
 * through this same adapter. The adapter itself is therefore two symmetric,
 * unconditional single-field writes plus an honest read — no adapter-level
 * state, no fire-and-forget path, no conditional "smart" writes (the manager
 * owns drift + clobber semantics; see its ordering comments).
 *
 * Safety properties, each proven by tests:
 *  - PINNED SITE (multi-tenant discipline): the adapter is constructed per
 *    property with the site's base URL + tenant/client/property ids. Every
 *    call re-asserts the AdapterContext against the pin, request URLs are
 *    built exclusively from the pinned base (never from the target), and an
 *    absolute target URL on a different origin is refused. Routing a write to
 *    another site through this instance is structurally impossible.
 *  - PLAN-TIME REVERSIBILITY: unsupported operations and non-restorable
 *    values are refused before any HTTP call (see target.ts) — a change that
 *    could not be rolled back byte-exact never touches the site.
 *  - WRITE VERIFICATION: every write re-reads the stored value from the REST
 *    response and compares it byte-exact (jsonEqual) to what was sent. If
 *    WordPress altered it (kses stripping for a capability-limited user, a
 *    filter), the write is reported FAILED — on apply the row stays
 *    'previewed'; on revert the row stays 'applied' and a human intervenes —
 *    instead of silently recording a state the site does not have.
 *  - CREDENTIALS (doc 04 §5): an Application Password reaches this adapter
 *    only as a vault ref + SecretsResolver. It is resolved per call, revealed
 *    only into the Authorization header, never stored on the instance, and
 *    never present in any error (errors are composed from status + sanitized
 *    slug only). The site must be connected over HTTPS — an http: base URL is
 *    refused at construction (the password would cross the wire in cleartext)
 *    — and every request states `redirect: "error"`, so the Authorization
 *    header can never be re-sent wherever a redirect points.
 *  - FAILURE HONESTY: 401/403 → credential_rejected; 404 / unexposed meta →
 *    target_missing; HTML-instead-of-JSON (the wp-login redirect classic) →
 *    unexpected_response; other API errors → vendor_failure; transport →
 *    network_failure. One operation per apply — the manager's applyBatch
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
  basicAuthHeader,
  looksLikeHtml,
  tryParseJson,
  type FetchPort,
} from "../shared/http";
import {
  assertReversibleValue,
  describeOperation,
  parseWordPressTarget,
  restRouteFor,
  type WordPressOperation,
} from "./target";

const METHOD: SiteChangeMethod = "wordpress";

/** The property this adapter instance is permanently pinned to. */
export interface WordPressSitePin {
  tenantId: string;
  clientId: string;
  propertyId: string;
  /**
   * The WordPress site's base URL (subdirectory installs supported, e.g.
   * `https://client.example.com/blog`). The ONLY place requests ever go.
   * MUST be https: — the Application Password rides every request as a Basic
   * Authorization header, so an http: base is refused at construction.
   */
  baseUrl: string;
}

export interface WordPressAdapterConfig {
  site: WordPressSitePin;
  /** Vault seam: the Application Password is resolved per call, never held. */
  secrets: SecretsResolver;
  /**
   * Secrets-vault reference for this property's connection (never a raw
   * credential). The vaulted value is the Basic pair `user:application-password`.
   */
  authRef: string;
  /** Injected HTTP (global `fetch` in production; ScriptedFetch in tests). */
  fetch: FetchPort;
}

export class WordPressAdapter implements WriteMethodAdapter {
  readonly method = METHOD;

  private readonly site: WordPressSitePin;
  /** Pinned origin — the cross-site guard compares against this. */
  private readonly origin: string;
  /** `{origin}{basePath}/wp-json/wp/v2` — every request URL starts here. */
  private readonly restRoot: string;
  private readonly secrets: SecretsResolver;
  private readonly authRef: string;
  private readonly fetchPort: FetchPort;

  constructor(config: WordPressAdapterConfig) {
    let parsed: URL;
    try {
      parsed = new URL(config.site.baseUrl);
    } catch {
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `wordpress: property ${config.site.propertyId} has an unusable base URL ('${config.site.baseUrl}') — reconnect the property with the site's full https address`,
      );
    }
    if (parsed.protocol !== "https:") {
      // HTTPS is NOT optional (Code Review Major 1): the Application Password
      // travels as a Basic Authorization header on every request — over http:
      // it would cross the network in cleartext. (Stock WordPress agrees: it
      // disables Application Passwords entirely on non-SSL sites.) There is
      // deliberately no dev-mode opt-out.
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `wordpress: property ${config.site.propertyId} must be connected over HTTPS (got '${parsed.protocol}') — this connection authenticates with an application password on every request, and WordPress itself disables application passwords on non-SSL sites; reconnect the property with its https:// address`,
      );
    }
    if (parsed.username || parsed.password) {
      // Never echo the URL back — it is the thing carrying the credential.
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `wordpress: property ${config.site.propertyId} base URL embeds credentials — credentials live in the secrets vault (auth_ref), never in a URL`,
      );
    }
    if (parsed.search || parsed.hash) {
      throw new WriteMethodError(
        METHOD,
        "misconfigured",
        `wordpress: property ${config.site.propertyId} base URL must not carry a query or fragment ('${config.site.baseUrl}')`,
      );
    }
    this.site = config.site;
    this.origin = parsed.origin;
    const basePath = parsed.pathname.replace(/\/+$/, "");
    this.restRoot = `${this.origin}${basePath}/wp-json/wp/v2`;
    this.secrets = config.secrets;
    this.authRef = config.authRef;
    this.fetchPort = config.fetch;
  }

  /* ---------------------------------------------------------------- */
  /* WriteMethodAdapter                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Read the live value at a target (the pipeline's before-capture + the §4
   * onboarding no-op verify). Values a later rollback could NOT restore
   * byte-exact (e.g. a null meta) are refused here — plan time, not rollback time.
   */
  async readCurrent(target: ChangeTarget, ctx: AdapterContext): Promise<Json> {
    const op = this.plan(target, ctx);
    const what = `read ${describeOperation(op)}`;
    const payload = await this.request("GET", op, undefined, what);
    const value = this.extractField(op, payload, what);
    assertReversibleValue(op, value, "live");
    return value;
  }

  /** Install the approved after-state (one field, one POST, verified). */
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
    assertReversibleValue(op, write.before, "before");
    assertReversibleValue(op, write.after, "after");

    const value = direction === "apply" ? write.after : write.before;
    const what = `${direction} ${describeOperation(op)}`;
    const payload = await this.request(
      "POST",
      op,
      JSON.stringify(this.updateBodyFor(op, value)),
      what,
    );

    // Byte-exactness verification: WordPress echoes the stored entity; if the
    // stored value differs from what we sent (kses stripped a tag, a filter
    // rewrote it), the write FAILED as far as change management is concerned.
    const stored = this.extractField(op, payload, what);
    if (!jsonEqual(stored, value)) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `wordpress ${what}: the site stored a different value than the one written — a filter or the connected user's permissions altered it (the site may now hold the altered value); fix the connected user's capabilities or adjust the change before retrying`,
      );
    }
  }

  /** WP update-body per operation (exactly one field per write). */
  private updateBodyFor(
    op: WordPressOperation,
    value: Json,
  ): { [key: string]: Json } {
    switch (op.field) {
      case "title":
        return { title: value };
      case "content":
        return { content: value };
      case "meta":
        return { meta: { [op.metaKey]: value } };
      case "alt_text":
        return { alt_text: value };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Site pinning (multi-tenant discipline, doc 04 §5)                 */
  /* ---------------------------------------------------------------- */

  private plan(target: ChangeTarget, ctx: AdapterContext): WordPressOperation {
    this.assertPinnedProperty(ctx);
    this.assertSameSite(target);
    return parseWordPressTarget(target);
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
        `wordpress: this connection is pinned to property ${pin.propertyId} (tenant ${pin.tenantId}, client ${pin.clientId}) — refusing an operation routed for property ${ctx.propertyId} (tenant ${ctx.tenantId}, client ${ctx.clientId})`,
      );
    }
  }

  /**
   * The target URL must live on the pinned origin. Requests are built from
   * the pinned base regardless — this guard exists to refuse a MIS-ROUTED
   * change (a target belonging to another site) loudly instead of writing the
   * right locator on the wrong site. Relative targets resolve against the pin.
   */
  private assertSameSite(target: ChangeTarget): void {
    let resolved: URL;
    try {
      resolved = new URL(target.url, `${this.origin}/`);
    } catch {
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        `wordpress: target url '${target.url}' is not a valid URL`,
      );
    }
    if (resolved.username || resolved.password) {
      // Checked BEFORE the origin comparison, and the URL is never echoed —
      // a userinfo-bearing URL is itself the thing carrying a credential
      // (consistent with the constructor's non-echo of a userinfo base URL).
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        `wordpress: the change target's URL embeds credentials (userinfo) — credentials live in the secrets vault (auth_ref), never in a URL; refusing the operation before any request`,
      );
    }
    if (resolved.origin !== this.origin) {
      throw new WriteMethodError(
        METHOD,
        "cross_site_target",
        `wordpress: target url ${target.url} is not on this connection's site (${this.origin}) — a write is never routed across origins`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* HTTP + response honesty                                           */
  /* ---------------------------------------------------------------- */

  /**
   * One authenticated wp/v2 request. `context=edit` on BOTH verbs: reads need
   * the raw (unrendered) fields for byte-exact capture, and the write's echo
   * must be raw for byte-exact verification.
   */
  private async request(
    method: "GET" | "POST",
    op: WordPressOperation,
    body: string | undefined,
    what: string,
  ): Promise<Json> {
    const url = `${this.restRoot}/${restRouteFor(op)}?context=edit`;

    // Vault seam: resolved per call; the revealed string exists only inside
    // the header expression below — never on `this`, never in an error.
    const credential = await this.secrets.resolve(this.authRef, {
      tenantId: this.site.tenantId,
      clientId: this.site.clientId,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: basicAuthHeader(credential.reveal()),
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let status: number;
    let text: string;
    try {
      // `redirect: "error"` — a write must land at exactly the URL it was
      // sent to; the port never follows a redirect (see FetchPortInit), so a
      // redirecting site rejects here and surfaces as network_failure below.
      const res = await this.fetchPort(url, {
        method,
        headers,
        body,
        redirect: "error",
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      // The transport detail is WHITELISTED (safeTransportDetail): only a
      // machine-style code or error name — never err.message, which can carry
      // arbitrary resolver/proxy/middlebox text.
      const detail = safeTransportDetail(err);
      throw new WriteMethodError(
        METHOD,
        "network_failure",
        `wordpress ${what}: could not reach ${this.origin}${detail ? ` (${detail})` : ""} — the request failed at the transport level (DNS, TLS, timeout, or a refused redirect); check the site's availability and the property's connection`,
      );
    }
    return this.decode(status, text, what);
  }

  /** Map a raw HTTP outcome to the typed contract — or the expected JSON payload. */
  private decode(status: number, text: string, what: string): Json {
    const parsed = tryParseJson(text);
    const vendorCode = parsed.ok ? this.vendorCodeOf(parsed.value) : undefined;
    const slug = vendorCode ? ` [${vendorCode}]` : "";

    if (status === 401 || status === 403) {
      throw new WriteMethodError(
        METHOD,
        "credential_rejected",
        `wordpress ${what}: the site refused this connection's credentials (HTTP ${status}${slug}) — the application password may be revoked or its user missing edit permission; reconnect the property`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 404) {
      throw new WriteMethodError(
        METHOD,
        "target_missing",
        `wordpress ${what}: the target does not exist on the site (HTTP 404${slug})${parsed.ok ? " — it may have been deleted since the audit" : " — the site's REST API may also be unavailable at /wp-json"}`,
        { httpStatus: status, vendorCode },
      );
    }
    if (!parsed.ok) {
      // The classic: a login redirect or security plugin answering HTML (or
      // any non-JSON) where the REST API was promised.
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        looksLikeHtml(text)
          ? `wordpress ${what}: the site answered with an HTML page instead of a REST response (HTTP ${status}) — usually a login redirect or a security plugin blocking the REST API; verify the REST API is reachable with an application password`
          : `wordpress ${what}: the site's response was not valid JSON (HTTP ${status}) — the REST API may be misconfigured or intercepted`,
        { httpStatus: status },
      );
    }
    if (status < 200 || status >= 300) {
      throw new WriteMethodError(
        METHOD,
        "vendor_failure",
        `wordpress ${what}: the site's API reported an error (HTTP ${status}${slug})`,
        { httpStatus: status, vendorCode },
      );
    }
    return parsed.value as Json;
  }

  /** Pull the WP error envelope's `code` slug — sanitized, never free text. */
  private vendorCodeOf(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    return safeVendorCode((payload as { [k: string]: unknown }).code);
  }

  /**
   * Extract the operation's field from a wp/v2 entity payload — strictly.
   * A payload without the expected raw field means the site is not giving us
   * a byte-exact surface, and we say so instead of guessing.
   */
  private extractField(
    op: WordPressOperation,
    payload: Json,
    what: string,
  ): Json {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw this.unexpectedShape(what, "the REST response was not an entity object");
    }
    const entity = payload as { [k: string]: Json };

    if (op.field === "title" || op.field === "content") {
      const field = entity[op.field];
      if (field === null || typeof field !== "object" || Array.isArray(field)) {
        throw this.unexpectedShape(what, `the REST response has no ${op.field} object`);
      }
      const raw = (field as { [k: string]: Json }).raw;
      if (typeof raw !== "string") {
        throw this.unexpectedShape(
          what,
          `the REST response has no raw ${op.field} — the edit context did not apply`,
        );
      }
      return raw;
    }

    if (op.field === "meta") {
      const meta = entity.meta;
      // PHP-empty-array quirk: a post type with NO meta registered for REST
      // serializes its empty meta map as `[]` (an empty PHP array becomes a
      // JSON array, not `{}`). That is a healthy response from a healthy site
      // — the key is simply not exposed, same diagnosis as a missing key.
      if (Array.isArray(meta) && meta.length === 0) {
        throw this.metaKeyNotExposed(op.metaKey, what);
      }
      if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
        throw this.unexpectedShape(what, "the REST response exposes no meta object");
      }
      const metaObj = meta as { [k: string]: Json };
      if (!Object.prototype.hasOwnProperty.call(metaObj, op.metaKey)) {
        throw this.metaKeyNotExposed(op.metaKey, what);
      }
      return metaObj[op.metaKey];
    }

    // alt_text (media): a plain string field on the media entity.
    const alt = entity.alt_text;
    if (typeof alt !== "string") {
      throw this.unexpectedShape(what, "the REST response has no alt_text field");
    }
    return alt;
  }

  /**
   * Unregistered/unexposed meta is a MISSING TARGET: WP silently drops writes
   * to unregistered keys, which would break both write honesty and rollback.
   * Raised pre-write on the read path AND post-write on the direct-apply path
   * (the write's echo not carrying the key means the site dropped it).
   */
  private metaKeyNotExposed(metaKey: string, what: string): WriteMethodError {
    return new WriteMethodError(
      METHOD,
      "target_missing",
      `wordpress ${what}: the meta field '${metaKey}' is not exposed by this site's REST API — the plugin that owns it (the AEO plugin or the site's SEO plugin) must register it before this fix can be written`,
    );
  }

  private unexpectedShape(what: string, why: string): WriteMethodError {
    return new WriteMethodError(
      METHOD,
      "unexpected_response",
      `wordpress ${what}: ${why} — the site may be running an incompatible WordPress version or a plugin that alters REST output`,
    );
  }
}
