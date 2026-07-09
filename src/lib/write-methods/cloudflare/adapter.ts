/**
 * CloudflareEdgeAdapter — write method 4 of 4 (doc 04 §1 method 2: the
 * universal fallback, REQUIRED for Framer), implementing the frozen
 * `WriteMethodAdapter` port against the Cloudflare REST API
 * (api.cloudflare.com). Method value: `edge_worker`.
 *
 * WHAT A "WRITE" IS ON THIS METHOD — stated plainly because it is inherently
 * different from methods 1–3: this adapter NEVER mutates origin content. The
 * client's site keeps serving exactly what its platform serves; a per-client
 * Cloudflare Worker on the client's domain (workers/edge-autofix) rewrites
 * responses in flight, driven by a versioned rules manifest in a per-client
 * KV namespace. A write here = upserting (or removing) ONE rule in that
 * manifest. Consequences, each carried through the contract below:
 *
 *  - ROLLBACK IS STRONGER THAN METHODS 1–3. Reverting a change removes (or
 *    restores the prior version of) the rule, and the origin content —
 *    which was never touched — shows through unchanged. There is no
 *    "server normalized our restore" failure mode against origin state,
 *    because there is no origin state to restore: absence of a rule IS the
 *    original state, restorable byte-exact by construction.
 *
 *  - BEFORE-CAPTURE IS RULE STATE, NOT ORIGIN HTML. `readCurrent` returns
 *    the RULE'S current state (null = no rule; otherwise the rule's value),
 *    so `site_changes.diff.before` / `diff.after` are prior-rule-state →
 *    new-rule-state. The origin HTML never appears in the diff because the
 *    method never modifies it. Byte-exact round-trip is therefore
 *    MANIFEST-LEVEL: what the manifest stores is what the diff says, exactly.
 *
 *  - VERIFICATION IS MANIFEST-LEVEL; RENDER-VERIFICATION BELONGS TO MONITOR.
 *    After every write the adapter reads the manifest back and verifies it
 *    BYTE-EXACT against what it wrote (canonical serialization makes that
 *    meaningful). What it deliberately does NOT claim: that the worker is
 *    already rendering the rule — pages render per request, and KV edge
 *    propagation takes up to ~60s, so the rendered effect lands on the next
 *    request after propagation. That is the `applied_at` caveat: MONITOR
 *    correlation against applied_at IS sound for this method (unlike
 *    Webflow's staged writes there is no indefinite publish gap), with the
 *    known ≤~60s + next-visit lag — PLUS one more: visitors holding a primed
 *    pre-rule cache entry revalidate → 304 → pass-through until their TTL
 *    expires, so MONITOR must not read stale-cache visitors as a failed
 *    rule. MONITOR verifies the rendered DOM effect on the live URL; the
 *    worker's `x-edge-autofix` header only names the rules SELECTED for the
 *    page (a per-element failure can drop one after the headers are sent),
 *    so header presence alone is never proof.
 *
 *  - CONCURRENT WRITERS — WHAT VERIFICATION DOES AND DOES NOT SEE. The
 *    manifest write is a GET → compose → PUT → verify-GET sequence. The
 *    byte-exact read-back catches a foreign write landing INSIDE our own
 *    PUT→verify window (pinned): one clean verified write, one loud
 *    write_verification_failed whose row stays in its pre-call status. What
 *    it CANNOT see: a STALE-BASE interleaving — both writers read the same
 *    base; the second PUT lands after the first writer's verify — is NOT
 *    detectable at this seam and silently drops the first write (both
 *    writers read back exactly the bytes they wrote and both report
 *    verified success). See the KNOWN RACE section below: wiring this
 *    method to live client properties is gated on per-property write
 *    serialization.
 *
 * Safety properties, each proven by tests:
 *  - PINNED ACCOUNT/ZONE/WORKER/NAMESPACE (doc 04 §5: per-client isolation).
 *    The adapter is constructed per property with the Cloudflare account id,
 *    zone id, worker script name, and KV namespace id — all validated at
 *    construction — plus tenant/client/property ids. Every call re-asserts
 *    the AdapterContext against the pin, and every request URL is composed
 *    ONLY from pinned construction state (account + namespace; ids are
 *    hex-validated so nothing can smuggle path segments). The API host is
 *    pinned outright to https://api.cloudflare.com — any other base URL is
 *    refused at construction without being echoed (SSRF class closed). One
 *    adapter instance is structurally incapable of addressing another
 *    client's namespace, account, or worker.
 *  - PLAN-TIME REVERSIBILITY (target.ts): only the five slot-exact rule
 *    operations are expressible; regex/patch rewrites are unrepresentable in
 *    the manifest format itself. `null` (rule absent) is a first-class,
 *    fully restorable state on BOTH sides of a write. A rule found DISABLED
 *    (an ops kill-switch action outside the pipeline) is refused loudly in
 *    both read and write directions — the diff cannot represent
 *    disabled-ness, so round-tripping through it would be a lie.
 *  - NEVER CLOBBER FOREIGN DATA: a stored manifest that does not STRICTLY
 *    parse as ours (foreign format, hand-edit, torn write) fails every
 *    operation loudly; this adapter never overwrites what it cannot read. A
 *    MISSING manifest is the legitimate first-write state (empty, version 0).
 *  - CREDENTIALS (doc 04 §5): the Cloudflare API token reaches this adapter
 *    only as a vault ref + SecretsResolver; resolved per call, revealed only
 *    into the Bearer Authorization header, never stored on the instance,
 *    never present in any error. HTTPS-only host, `redirect: "error"` on
 *    every request — the token cannot be re-sent wherever a redirect points.
 *  - FAILURE HONESTY: 401/403 → credential_rejected; 404 with Cloudflare's
 *    key-not-found code on a READ → the legitimate "no manifest yet" state;
 *    any other 404 → target_missing (namespace/route gone — deleted
 *    provisioning); 429 → rate_limited (operation did NOT happen; row stays
 *    retryable; Retry-After whitelisted digits or dropped; NOTHING retries
 *    automatically); HTML-instead-of-JSON → unexpected_response; other API
 *    errors → vendor_failure with the numeric Cloudflare error code as the
 *    sanitized slug — vendor free-text messages are NEVER echoed; transport
 *    throws → network_failure with the whitelisted code only. KV propagation
 *    and partial-manifest states can never yield a false verified claim: the
 *    write is verified against the API's authoritative store (not the edge
 *    cache), and any divergence VISIBLE ON THE VERIFICATION READ — a torn
 *    write, an in-window concurrent writer, a vanished key — is
 *    write_verification_failed with the row left in its pre-call status. (A
 *    stale-base overwrite landing AFTER verification is not visible here —
 *    see KNOWN RACE below. An HTML interstitial on the verification read is
 *    named honestly as unexpected_response, not misattributed as a failed
 *    write.)
 *
 * KNOWN RACE — HARD PRECONDITION ON PRODUCTION WIRING (gate-dispositioned by
 * Orchestrator + Code Review, 2026-07-09). Workers KV has no compare-and-swap
 * or conditional write, so NOTHING at this seam can detect a STALE-BASE
 * interleaving of the GET → compose → PUT → verify-GET sequence:
 *
 *   writer A GETs base v5 · writer B GETs base v5 · A PUTs v6ᴬ · A verifies ✓
 *   · B PUTs v6ᴮ (composed from the stale v5 base) · B verifies ✓
 *
 *   Both writers read back exactly the bytes they wrote, so BOTH report
 *   verified success — and A's write is silently gone from the manifest.
 *
 * Consequences if this ever fires against a live property:
 *   - a lost APPLY is a FALSE AUDIT ROW: `site_changes` says the rule is
 *     installed and verified while the edge serves the page without it;
 *   - a lost REVERT is worse: the rule is STILL LIVE on the client's domain
 *     while its row reads 'reverted' — a direct doc 04 §2 violation (the
 *     one-action rollback silently did not happen).
 *
 * Why it is not closed here: KV offers no CAS to make the read-modify-write
 * atomic, and a version-check-before-PUT only narrows the window. What DOES
 * close it: every writer to this namespace is OURS (the pipeline is the only
 * manifest writer; client staff have no path here), so per-property WRITE
 * SERIALIZATION at the production-wiring seam (BUILD-STATE carried ticket
 * ii) eliminates the interleaving entirely — unlike the Wix residual, where
 * the concurrent writer can be a human outside our control.
 *
 * THE BINDING PRECONDITION: this method MUST NOT be wired to live client
 * properties until per-property write serialization exists at the wiring
 * seam. The race is pinned by the adapter test named "KNOWN RACE (stale-base
 * interleaving, gate-dispositioned 2026-07-09): closes at the wiring seam,
 * not here" — if adapter-level detection ever improves, that test flips and
 * this disposition must be re-opened.
 *
 * FIRST-LIVE-WRITE CANARY (joins carried ticket ii — confirm when the wiring
 * step connects this method to its first real property): the Cloudflare
 * error-code semantics this adapter keys on — 10009 = "key not found" on the
 * KV values GET (treated as "no manifest yet") and 403 (not 400) for a
 * revoked/insufficient token — plus that the raw KV values GET echoes stored
 * bytes exactly (byte-exact verification depends on it), plus READ-AFTER-
 * WRITE CONSISTENCY of the KV values GET at api.cloudflare.com: the
 * verification GET assumes the authoritative store echoes a just-PUT value;
 * a lagging read would surface as a spurious LOUD write_verification_failed
 * — fail-safe, but it must be recognized as read lag, not misread as a
 * concurrent writer.
 */

import {
  jsonEqual,
  type AdapterContext,
  type AdapterWrite,
  type ChangeTarget,
  type Clock,
  type WriteMethodAdapter,
} from "@/lib/change-management";
import type { SecretsResolver } from "@/lib/connectors";
import type { Json, SiteChangeMethod } from "@/lib/types/db";
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_KEY,
  parseManifest,
  serializeManifest,
  type EdgeRule,
  type EdgeRulesManifest,
} from "../../../../workers/edge-autofix/src/manifest";
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
import { refuseBaseUrl } from "../shared/refuse";
import {
  assertReversibleEdgeValue,
  describeEdgeOperation,
  parseEdgeTarget,
  ruleFor,
  ruleValueOf,
  type EdgeRuleAddress,
} from "./target";

const METHOD: SiteChangeMethod = "edge_worker";

/** The ONLY host this method ever talks to. Not configurable in production. */
export const CLOUDFLARE_API_HOST = "https://api.cloudflare.com";

/** Cloudflare account / zone / KV-namespace ids are 32 lowercase hex chars. */
const CF_RESOURCE_ID = /^[0-9a-f]{32}$/;
/** Worker service names: lowercase DNS-label style. */
const CF_SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Cloudflare's "key not found" error code on the KV values GET. */
const KV_KEY_NOT_FOUND = "10009";
/** Retry-After whitelist: plain integer seconds only; anything else is dropped. */
const RETRY_AFTER_SECONDS = /^\d{1,6}$/;

/** The per-client edge deployment this adapter instance is permanently pinned to. */
export interface CloudflareEdgePin {
  tenantId: string;
  clientId: string;
  propertyId: string;
  /** Cloudflare account the client's worker + namespace live in (32-hex). */
  accountId: string;
  /** The client domain's zone — where the worker route is attached (32-hex). */
  zoneId: string;
  /** The per-client worker service name (isolation: one worker per domain). */
  scriptName: string;
  /** The per-client KV namespace holding the rules manifest (32-hex). */
  namespaceId: string;
}

export interface CloudflareEdgeAdapterConfig {
  pin: CloudflareEdgePin;
  /** Vault seam: the API token is resolved per call, never held. */
  secrets: SecretsResolver;
  /**
   * Secrets-vault reference for this property's connection (never a raw
   * credential). The vaulted value is a Cloudflare API token scoped to the
   * pinned account's Workers KV Storage (sent as a Bearer header).
   */
  authRef: string;
  /** Injected HTTP (global `fetch` in production; FakeCloudflareKv in tests). */
  fetch: FetchPort;
  /** Injected time — stamps the manifest's `updatedAt` deterministically. */
  clock: Clock;
  /**
   * Optional override that may only ever equal {@link CLOUDFLARE_API_HOST} —
   * it exists so a misconfiguration is refused LOUDLY at construction instead
   * of a request leaving for an attacker-chosen host. The rejected value is
   * never echoed (shared refuse-without-echo helper).
   */
  apiBaseUrl?: string;
}

export class CloudflareEdgeAdapter implements WriteMethodAdapter {
  readonly method = METHOD;

  private readonly pin: CloudflareEdgePin;
  /** `https://api.cloudflare.com` — every request URL starts here. */
  private readonly apiRoot: string;
  private readonly secrets: SecretsResolver;
  private readonly authRef: string;
  private readonly fetchPort: FetchPort;
  private readonly clock: Clock;

  constructor(config: CloudflareEdgeAdapterConfig) {
    const base = config.apiBaseUrl ?? CLOUDFLARE_API_HOST;
    const normalized = base.endsWith("/") ? base.slice(0, -1) : base;
    if (normalized !== CLOUDFLARE_API_HOST) {
      throw refuseBaseUrl(
        METHOD,
        config.pin.propertyId,
        `is configured with a custom API base URL — this method talks only to ${CLOUDFLARE_API_HOST}`,
        "remove the override",
      );
    }
    for (const [field, value, grammar] of [
      ["Cloudflare account id", config.pin.accountId, CF_RESOURCE_ID],
      ["Cloudflare zone id", config.pin.zoneId, CF_RESOURCE_ID],
      ["edge-rules KV namespace id", config.pin.namespaceId, CF_RESOURCE_ID],
      ["edge worker script name", config.pin.scriptName, CF_SCRIPT_NAME],
    ] as const) {
      if (!grammar.test(value)) {
        throw new WriteMethodError(
          METHOD,
          "misconfigured",
          `edge_worker: property ${config.pin.propertyId} has an unusable ${field} (the value is not echoed; account/zone/namespace ids are 32 lowercase hex characters, script names lowercase-hyphen) — re-run the edge worker provisioning for this property`,
        );
      }
    }
    this.pin = config.pin;
    this.apiRoot = CLOUDFLARE_API_HOST;
    this.secrets = config.secrets;
    this.authRef = config.authRef;
    this.fetchPort = config.fetch;
    this.clock = config.clock;
  }

  /* ---------------------------------------------------------------- */
  /* WriteMethodAdapter                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Read the current RULE state at a target (the pipeline's before-capture +
   * the §4 onboarding no-op verify — which also proves token + namespace
   * reachability). `null` = no rule installed (the origin shows through);
   * otherwise the rule's value. A DISABLED rule is refused — see the header.
   */
  async readCurrent(target: ChangeTarget, ctx: AdapterContext): Promise<Json> {
    const address = this.plan(target, ctx);
    const what = `read ${describeEdgeOperation(address)}`;
    const stored = await this.readManifest(what);
    if (stored === null) return null;
    const rule = stored.manifest.rules.find((r) => r.id === address.ruleId);
    if (!rule) return null;
    this.assertRuleOperable(rule, address, what);
    return ruleValueOf(rule);
  }

  /** Install the approved after-state (one rule slot, one verified write). */
  async apply(write: AdapterWrite): Promise<void> {
    await this.writeValue(write, "apply");
  }

  /**
   * Restore the captured before-state through the SAME surface as apply —
   * `before === null` removes the rule (the original "no rule" state), a
   * non-null before re-installs the prior rule version byte-exact. The
   * origin content was never touched either way.
   */
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
    const address = this.plan(write.target, write.ctx);
    // BOTH directions must be installable BEFORE any network call: refusing a
    // non-restorable `before` here is what guarantees rollback can never
    // discover an impossible restore (doc 04 §2). On this method null is
    // installable (rule removal), so only SHAPES are gated.
    assertReversibleEdgeValue(address, write.before, "before");
    assertReversibleEdgeValue(address, write.after, "after");

    const value = direction === "apply" ? write.after : write.before;
    const what = `${direction} ${describeEdgeOperation(address)}`;

    // Fresh read of the whole manifest (the read-modify-write base). A
    // missing manifest is the legitimate first-write state; a foreign or
    // corrupt one refuses loudly inside readManifest — never clobbered.
    const stored = await this.readManifest(what);
    const base: EdgeRulesManifest = stored?.manifest ?? {
      format: MANIFEST_FORMAT,
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: 0,
      updatedAt: this.clock.now(),
      rules: [],
    };

    // Live-state gate (defense in depth — the pipeline's before-capture
    // already refused): never write THROUGH a rule someone disabled out of
    // band; surface it instead.
    const existing = base.rules.find((r) => r.id === address.ruleId);
    if (existing) this.assertRuleOperable(existing, address, what);

    // Compose the next manifest: this slot's rule replaced/removed, version
    // bumped, canonical order restored at serialization. Removing an
    // already-absent rule is a legal no-op write (idempotent re-reverts).
    const rules = base.rules.filter((r) => r.id !== address.ruleId);
    if (value !== null) {
      rules.push(ruleFor(address.op, address.path, value));
    }
    const next: EdgeRulesManifest = {
      format: MANIFEST_FORMAT,
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: base.version + 1,
      updatedAt: this.clock.now(),
      rules,
    };
    const text = serializeManifest(next);

    await this.putManifest(text, what);

    // MANIFEST-LEVEL VERIFICATION (the honesty line): read the authoritative
    // store back and require BYTE-EXACT equality with what was written. A
    // torn write, a normalizing proxy, an IN-WINDOW concurrent writer, or a
    // vanished key all land here as a loud write_verification_failed — the
    // row stays in its pre-call status and a human decides. (A stale-base
    // interleaving is NOT visible here — see the KNOWN RACE header section.)
    // What is NOT claimed: that the worker already renders the rule (KV
    // propagation ~60s; rendering is per-request) — render-verification
    // belongs to MONITOR, which checks the rendered DOM on the live URL
    // (the worker's x-edge-autofix header only names selected rules).
    const echoed = await this.readManifestRaw(what);
    // Same HTML-interstitial guard as every other manifest read: a challenge
    // page answering the VERIFICATION read is an interception, not evidence
    // about the write — name it honestly instead of misattributing it as a
    // failed write (the manifest we serialize is JSON and can never look
    // like HTML, so this can never mask a true byte divergence).
    if (echoed !== null && looksLikeHtml(echoed)) {
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        `edge_worker ${what}: the write-verification read answered with an HTML page instead of the stored manifest — usually a proxy or challenge page in front of api.cloudflare.com; the write itself is UNVERIFIED (the change row stays in its pre-call status); retry once the interstitial clears`,
      );
    }
    if (echoed === null || echoed !== text) {
      throw new WriteMethodError(
        METHOD,
        "write_verification_failed",
        `edge_worker ${what}: the rules manifest read back different from the one written — a concurrent write to this property's edge rules, a torn write, or storage interference (the change was NOT verified installed; the change row stays in its pre-write status); re-run the action once, and investigate if it repeats`,
      );
    }
  }

  /**
   * A rule can only be read/written through the pipeline while it is in the
   * one state the diff can represent: ENABLED (or absent). Disabled is an
   * out-of-band ops state; operating "through" it would round-trip a lie.
   */
  private assertRuleOperable(
    rule: EdgeRule,
    address: EdgeRuleAddress,
    what: string,
  ): void {
    if (!rule.enabled) {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `edge_worker ${what}: this rule is currently DISABLED in the edge manifest (an out-of-band kill-switch state this pipeline's diffs cannot represent) — re-enable or remove it via the ops surface that disabled it, then retry`,
      );
    }
    // Belt-and-braces: parseManifest already proved id === derivation, so an
    // id match implies matching op/path/discriminator; jsonEqual-compare the
    // slot coordinates anyway so a future parser regression fails loudly.
    const expected = ruleFor(address.op, address.path, ruleValueOf(rule));
    if (!jsonEqual(expected as unknown as Json, rule as unknown as Json)) {
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        `edge_worker ${what}: the stored rule does not match its own slot coordinates — the manifest may have been hand-edited; re-provision the property's edge rules storage`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pinning (multi-tenant discipline, doc 04 §5)                      */
  /* ---------------------------------------------------------------- */

  private plan(target: ChangeTarget, ctx: AdapterContext): EdgeRuleAddress {
    this.assertPinnedProperty(ctx);
    return parseEdgeTarget(target);
  }

  /** The call's context must be the pinned property — no cross-routing. */
  private assertPinnedProperty(ctx: AdapterContext): void {
    const pin = this.pin;
    if (
      ctx.tenantId !== pin.tenantId ||
      ctx.clientId !== pin.clientId ||
      ctx.propertyId !== pin.propertyId
    ) {
      throw new WriteMethodError(
        METHOD,
        "property_mismatch",
        `edge_worker: this connection is pinned to property ${pin.propertyId} (tenant ${pin.tenantId}, client ${pin.clientId}) — refusing an operation routed for property ${ctx.propertyId} (tenant ${ctx.tenantId}, client ${ctx.clientId})`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Manifest I/O against the pinned account + namespace               */
  /* ---------------------------------------------------------------- */

  /** The one URL this adapter reads/writes — pinned construction state only. */
  private manifestUrl(): string {
    return `${this.apiRoot}/client/v4/accounts/${this.pin.accountId}/storage/kv/namespaces/${this.pin.namespaceId}/values/${MANIFEST_KEY}`;
  }

  /**
   * Read + strictly parse the stored manifest. Returns null when NO manifest
   * exists yet (the legitimate pre-first-write state); refuses loudly when
   * one exists but is not ours (never clobber what we cannot read).
   */
  private async readManifest(
    what: string,
  ): Promise<{ manifest: EdgeRulesManifest; text: string } | null> {
    const text = await this.readManifestRaw(what);
    if (text === null) return null;
    if (looksLikeHtml(text)) {
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        `edge_worker ${what}: the rules storage answered with an HTML page instead of the stored manifest — usually a proxy or challenge page in front of api.cloudflare.com; retry, and reconnect the property if it persists`,
      );
    }
    const manifest = parseManifest(text);
    if (manifest === null) {
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        `edge_worker ${what}: the stored rules manifest is not in this platform's format — refusing to touch it (a foreign or corrupted manifest is never overwritten; the worker is meanwhile failing open and serving the origin untouched); re-provision the property's edge rules storage`,
      );
    }
    return { manifest, text };
  }

  /** Raw manifest GET: stored bytes, or null when the key does not exist. */
  private async readManifestRaw(what: string): Promise<string | null> {
    const res = await this.request("GET", undefined, what);
    if (res.status >= 200 && res.status < 300) return res.text;
    if (res.status === 404) {
      // Cloudflare distinguishes "key not found" (the legitimate empty
      // state) from "namespace/route not found" (deleted provisioning) by
      // error code; only the former reads as an empty manifest.
      const vendorCode = this.envelopeCode(res.text);
      if (vendorCode === KV_KEY_NOT_FOUND) return null;
    }
    throw this.decodeFailure(res.status, res.text, res.retryAfter, what);
  }

  /** Write the manifest text and decode Cloudflare's JSON envelope. */
  private async putManifest(text: string, what: string): Promise<void> {
    const res = await this.request("PUT", text, what);
    if (res.status >= 200 && res.status < 300) {
      const parsed = tryParseJson(res.text);
      if (
        parsed.ok &&
        typeof parsed.value === "object" &&
        parsed.value !== null &&
        (parsed.value as { success?: unknown }).success === true
      ) {
        return;
      }
      throw new WriteMethodError(
        METHOD,
        "unexpected_response",
        `edge_worker ${what}: the rules storage accepted the request but did not confirm success (HTTP ${res.status}) — the write is unverified; re-run the action`,
        { httpStatus: res.status },
      );
    }
    throw this.decodeFailure(res.status, res.text, res.retryAfter, what);
  }

  /**
   * One authenticated request against the pinned host + pinned account +
   * pinned namespace. The URL is composed only from validated construction
   * state; the token is vault-resolved per call and exists only inside the
   * header expression.
   */
  private async request(
    method: "GET" | "PUT",
    body: string | undefined,
    what: string,
  ): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const credential = await this.secrets.resolve(this.authRef, {
      tenantId: this.pin.tenantId,
      clientId: this.pin.clientId,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: bearerAuthHeader(credential.reveal()),
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    try {
      // `redirect: "error"` — a write must land at exactly the URL it was
      // sent to; a redirecting endpoint rejects here (network_failure).
      const res = await this.fetchPort(this.manifestUrl(), {
        method,
        headers,
        body,
        redirect: "error",
      });
      return {
        status: res.status,
        text: await res.text(),
        retryAfter: res.headers.get("retry-after"),
      };
    } catch (err) {
      // WHITELISTED transport detail only — never err.message (resolvers,
      // proxies, and middleboxes put arbitrary text there).
      const detail = safeTransportDetail(err);
      throw new WriteMethodError(
        METHOD,
        "network_failure",
        `edge_worker ${what}: could not reach ${CLOUDFLARE_API_HOST}${detail ? ` (${detail})` : ""} — the request failed at the transport level (DNS, TLS, timeout, or a refused redirect); check connectivity and retry`,
      );
    }
  }

  /** Map a non-2xx HTTP outcome to the typed contract. */
  private decodeFailure(
    status: number,
    text: string,
    retryAfterHeader: string | null,
    what: string,
  ): WriteMethodError {
    const vendorCode = this.envelopeCode(text);
    const slug = vendorCode ? ` [${vendorCode}]` : "";

    if (status === 401 || status === 403) {
      return new WriteMethodError(
        METHOD,
        "credential_rejected",
        `edge_worker ${what}: the Cloudflare API refused this connection's token (HTTP ${status}${slug}) — it may be revoked, expired, or missing the Workers KV Storage permission for the pinned account; reconnect the property`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 404) {
      return new WriteMethodError(
        METHOD,
        "target_missing",
        `edge_worker ${what}: the property's edge rules storage was not found (HTTP 404${slug}) — the pinned KV namespace (or its route) may have been deleted since provisioning; re-run the edge worker provisioning for this property (every request is scoped to this connection's pinned account and namespace, so another client's storage is not reachable here)`,
        { httpStatus: status, vendorCode },
      );
    }
    if (status === 429) {
      // Rate limit: the operation was REJECTED, not performed — the change
      // row stays in its pre-call status and the same action can simply be
      // re-run. Nothing here (or in the pipeline) retries automatically: an
      // unattended retry loop would be an unattended write.
      const retryAfterSeconds =
        retryAfterHeader !== null && RETRY_AFTER_SECONDS.test(retryAfterHeader)
          ? Number(retryAfterHeader)
          : undefined;
      return new WriteMethodError(
        METHOD,
        "rate_limited",
        `edge_worker ${what}: the Cloudflare API rate limit rejected this call (HTTP 429${slug}) — the operation was NOT performed and the change stays retryable; re-run the same action${retryAfterSeconds !== undefined ? ` after ~${retryAfterSeconds}s` : " shortly"} (nothing retries automatically)`,
        { httpStatus: status, vendorCode, retryAfterSeconds },
      );
    }
    if (!tryParseJson(text).ok) {
      return new WriteMethodError(
        METHOD,
        "unexpected_response",
        looksLikeHtml(text)
          ? `edge_worker ${what}: the API answered with an HTML page instead of an API response (HTTP ${status}) — usually a proxy or challenge page in front of api.cloudflare.com; retry, and reconnect the property if it persists`
          : `edge_worker ${what}: the API's response was not valid JSON (HTTP ${status}) — the request may have been intercepted`,
        { httpStatus: status },
      );
    }
    return new WriteMethodError(
      METHOD,
      "vendor_failure",
      `edge_worker ${what}: the Cloudflare API reported an error (HTTP ${status}${slug})`,
      { httpStatus: status, vendorCode },
    );
  }

  /**
   * Pull the first numeric error code from Cloudflare's JSON envelope
   * (`{ success, errors: [{ code, message }] }`) — sanitized through the
   * shared whitelist as a digit string. The envelope's free-text `message`
   * is NEVER used.
   */
  private envelopeCode(text: string): string | undefined {
    const parsed = tryParseJson(text);
    if (!parsed.ok) return undefined;
    const envelope = parsed.value;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    ) {
      return undefined;
    }
    const errors = (envelope as { errors?: unknown }).errors;
    if (!Array.isArray(errors) || errors.length === 0) return undefined;
    const first = errors[0];
    if (first === null || typeof first !== "object") return undefined;
    const code = (first as { code?: unknown }).code;
    if (typeof code === "number" && Number.isInteger(code)) {
      return safeVendorCode(String(code));
    }
    return safeVendorCode(code);
  }
}
