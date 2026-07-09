/**
 * FakeCloudflareKv — a stateful Cloudflare Workers-KV REST stand-in for
 * adapter + pipeline tests (no live network; built on the shared
 * ScriptedFetch harness, exactly like FakeWordPress / FakeWebflow / FakeWix).
 *
 * Faithful where it matters to the safety contract — the API semantics the
 * adapter RELIES on, modeled deliberately:
 *  - VALUES ARE RAW BYTES: GET on
 *    /client/v4/accounts/{acct}/storage/kv/namespaces/{ns}/values/{key}
 *    echoes the STORED VALUE verbatim (no JSON envelope) — the property the
 *    adapter's byte-exact write verification depends on. Errors, by
 *    contrast, come as the Cloudflare envelope
 *    `{ success:false, errors:[{ code:<number>, message }], ... }` with the
 *    NUMERIC code the adapter's sanitizer must stringify (10009 = key not
 *    found — the legitimate "no manifest yet" state; 10013 = namespace not
 *    found — deleted provisioning).
 *  - PUT stores the request body verbatim and answers the success envelope
 *    `{ success:true, errors:[], messages:[], result:null }`.
 *  - Bearer auth: a wrong, missing, or scheme-less token answers 403 code
 *    9109 (Cloudflare rejects bad tokens with 403, not 401 — the adapter's
 *    credential_rejected covers both). `rotateToken()` models a mid-flight
 *    rotation/revocation.
 *  - SCOPING: this fake stands in for ONE account + ONE namespace. A request
 *    for any other account routes to 404 code 7003, any other namespace to
 *    404 code 10013 — which is how tests prove the adapter's pin is the
 *    isolation boundary (a second adapter pinned elsewhere reaches nothing
 *    through this account).
 *
 * Fault injection: one-shot any-request or write-only failures with any
 * status/code, an Nth-PUT failure (mid-batch adversity), 429 with a
 * scriptable Retry-After, HTML-interstitial mode (all requests, or arriving
 * only after the next PUT — the verification-read interception),
 * `corruptNextWrite` (a torn or normalized store — the counterfactual
 * proving the byte-exact verification is load-bearing),
 * `overwriteAfterNextPut` (a concurrent writer landing between our PUT and
 * the verification GET — the IN-WINDOW interleaving this method catches
 * LOUDLY, in contrast to Wix's silent residual; the STALE-BASE interleaving
 * is not visible at this seam — see adapter.ts KNOWN RACE), namespace
 * deletion, key deletion, token rotation, plus network-level failure via
 * the underlying ScriptedFetch.
 */

import type { FetchPort, FetchPortResponse } from "../shared/http";
import {
  htmlResponse,
  jsonResponse,
  ScriptedFetch,
  textResponse,
  type RecordedRequest,
} from "../shared/http-harness";

export interface FakeCloudflareKvSeed {
  /** Expected raw API token (arrives as `Bearer <token>`). */
  apiToken: string;
  /** The account this fake stands in for (32-hex). */
  accountId: string;
  /** The one namespace this fake stands in for (32-hex). */
  namespaceId: string;
  /** Pre-seeded values (key → raw stored text). */
  values?: Record<string, string>;
}

const INTERSTITIAL_HTML =
  '<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body><div id="challenge">Checking your browser before accessing api.cloudflare.com</div></body></html>';

const VALUES_ROUTE =
  /^\/client\/v4\/accounts\/([0-9a-f]{32})\/storage\/kv\/namespaces\/([0-9a-f]{32})\/values\/(.+)$/;

export class FakeCloudflareKv {
  /** The underlying harness — exposed for network-fault injection + journal. */
  readonly http = new ScriptedFetch();

  private readonly accountId: string;
  private readonly namespaceId: string;
  private apiToken: string;
  private readonly values = new Map<string, string>();
  private namespaceDeleted = false;
  private htmlInterstitial = false;
  private interstitialAfterNextPut = false;
  private pendingFailure: FetchPortResponse | null = null;
  private pendingWriteFailure: { afterPuts: number; response: FetchPortResponse } | null =
    null;
  private writeCorruptor: ((stored: string) => string) | null = null;
  private pendingOverwrite: string | null = null;
  private pendingDelete = false;

  constructor(seed: FakeCloudflareKvSeed) {
    this.apiToken = seed.apiToken;
    this.accountId = seed.accountId;
    this.namespaceId = seed.namespaceId;
    for (const [key, value] of Object.entries(seed.values ?? {})) {
      this.values.set(key, value);
    }
    // One catch-all route: like the real API host, every path answers.
    this.http.on("*", /./, (req) => this.handle(req));
  }

  /** The injectable FetchPort for the adapter under test. */
  get port(): FetchPort {
    return this.http.port;
  }

  /** Journal of everything the adapter sent. */
  get requests(): RecordedRequest[] {
    return this.http.requests;
  }

  /* -------- state accessors (byte-exact assertions) -------- */

  /** The raw stored value, or null — exactly what the worker would read. */
  value(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  /* -------- fault injection -------- */

  /** Every request answers 200 + an HTML challenge page (CDN/WAF interstitial). */
  simulateHtmlInterstitial(): this {
    this.htmlInterstitial = true;
    return this;
  }

  /**
   * The interstitial arrives only AFTER the next PUT stores successfully —
   * so the write LANDS but its verification GET (and everything after) reads
   * a challenge page. Proves the verification read routes through the same
   * HTML guard as every other read (unexpected_response, named honestly),
   * instead of misattributing the interception as write_verification_failed.
   */
  htmlInterstitialAfterNextPut(): this {
    this.interstitialAfterNextPut = true;
    return this;
  }

  /** The NEXT request (any verb) fails once with the given status/code. */
  failNextWith(status: number, code: number): this {
    this.pendingFailure = envelope(status, code);
    return this;
  }

  /** The next PUT fails once with the given status/code (state untouched). */
  failNextWriteWith(status = 500, code = 10000): this {
    return this.failPut(1, status, code);
  }

  /**
   * The Nth PUT from now (1-based) fails once with the given status/code,
   * state untouched — mid-batch adversity (member N's write, not member 1's).
   */
  failPut(nth: number, status: number, code: number): this {
    this.pendingWriteFailure = { afterPuts: nth - 1, response: envelope(status, code) };
    return this;
  }

  /**
   * The NEXT request answers 429, state untouched. `retryAfter` becomes the
   * Retry-After header verbatim (pass garbage to prove the adapter
   * whitelists it); omit for a header-less 429.
   */
  rateLimitNext(retryAfter?: number | string): this {
    this.pendingFailure = jsonResponse(
      429,
      cfError(10015),
      retryAfter === undefined ? undefined : { "retry-after": String(retryAfter) },
    );
    return this;
  }

  /**
   * The next PUT stores fn(body) instead of the body — a torn write or a
   * normalizing middlebox. KV itself stores bytes verbatim; this is the
   * counterfactual that proves the byte-exact verification is load-bearing.
   */
  corruptNextWrite(fn: (stored: string) => string): this {
    this.writeCorruptor = fn;
    return this;
  }

  /**
   * A CONCURRENT WRITER: immediately after the next PUT stores, the given
   * text overwrites it — so the writer's verification GET reads the other
   * write. This is the IN-WINDOW interleaving the edge method catches
   * LOUDLY (one clean write, one write_verification_failed), in contrast to
   * the Wix GET→PUT residual where the echo cannot see it. The STALE-BASE
   * interleaving (second PUT landing after the first writer's verify) is
   * NOT visible at this seam — see adapter.ts KNOWN RACE and its pin test.
   */
  overwriteAfterNextPut(text: string): this {
    this.pendingOverwrite = text;
    return this;
  }

  /**
   * A CONCURRENT DELETER: immediately after the next PUT stores, the key is
   * deleted — the verification GET then finds nothing at all (the
   * `echoed === null` verification branch).
   */
  deleteAfterNextPut(): this {
    this.pendingDelete = true;
    return this;
  }

  /**
   * Rotate the account's API token: the fake now expects `next`, so a
   * resolver still handing out the old token starts getting 403 —
   * exactly a mid-flight rotation/revocation.
   */
  rotateToken(next: string): this {
    this.apiToken = next;
    return this;
  }

  /** Delete the whole namespace (deleted-provisioning scenarios): 404 10013. */
  deleteNamespace(): this {
    this.namespaceDeleted = true;
    return this;
  }

  /** Remove one key (vanished-manifest scenarios): GET answers 404 10009. */
  deleteKey(key: string): this {
    this.values.delete(key);
    return this;
  }

  /** Seed a raw value directly (foreign/corrupt-manifest scenarios). */
  seedValue(key: string, text: string): this {
    this.values.set(key, text);
    return this;
  }

  /* -------- request handling -------- */

  private handle(req: RecordedRequest): FetchPortResponse {
    if (this.htmlInterstitial) return htmlResponse(200, INTERSTITIAL_HTML);
    if (this.pendingFailure) {
      const failure = this.pendingFailure;
      this.pendingFailure = null;
      return failure;
    }
    if (req.headers["authorization"] !== `Bearer ${this.apiToken}`) {
      // Cloudflare rejects a bad/missing token with 403 (code 9109).
      return envelope(403, 9109);
    }

    const url = new URL(req.url);
    const match = VALUES_ROUTE.exec(url.pathname);
    if (!match) return envelope(404, 7000); // no route
    const [, accountId, namespaceId, key] = match;
    if (accountId !== this.accountId) {
      // Another account: not routable with this fake's scope.
      return envelope(404, 7003);
    }
    if (namespaceId !== this.namespaceId || this.namespaceDeleted) {
      return envelope(404, 10013); // namespace not found
    }

    if (req.method === "GET") {
      const stored = this.values.get(key);
      if (stored === undefined) return envelope(404, 10009); // key not found
      // RAW value echo — no envelope. This is the byte-exactness seam.
      return textResponse(200, stored, "application/octet-stream");
    }

    if (req.method === "PUT") {
      if (this.pendingWriteFailure) {
        if (this.pendingWriteFailure.afterPuts === 0) {
          const failure = this.pendingWriteFailure.response;
          this.pendingWriteFailure = null;
          return failure;
        }
        this.pendingWriteFailure.afterPuts--;
      }
      const body = req.body ?? "";
      const stored = this.writeCorruptor ? this.writeCorruptor(body) : body;
      this.writeCorruptor = null;
      this.values.set(key, stored);
      if (this.pendingOverwrite !== null) {
        // The concurrent writer lands right behind us.
        this.values.set(key, this.pendingOverwrite);
        this.pendingOverwrite = null;
      }
      if (this.pendingDelete) {
        // The concurrent deleter lands right behind us.
        this.values.delete(key);
        this.pendingDelete = false;
      }
      if (this.interstitialAfterNextPut) {
        // The write stored; everything AFTER it hits a challenge page.
        this.htmlInterstitial = true;
        this.interstitialAfterNextPut = false;
      }
      return jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: null,
      });
    }

    return envelope(405, 7002);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The Cloudflare error envelope: NUMERIC codes + free text (never echoed). */
function cfError(code: number): unknown {
  return {
    success: false,
    errors: [
      {
        code,
        message:
          "A vendor free-text message that must never appear in an operator-facing error.",
      },
    ],
    messages: [],
    result: null,
  };
}

function envelope(status: number, code: number): FetchPortResponse {
  return jsonResponse(status, cfError(code));
}
