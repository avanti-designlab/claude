/**
 * CloudflareEdgeAdapter unit suite — mocked HTTP only (the FetchPort is
 * injected; no test touches a network).
 *
 * Proves the adapter-level safety contract:
 *  - a "write" is a manifest rule upsert/removal — reads capture RULE state
 *    (null = no rule, a fully round-trippable state on this method), writes
 *    compose a canonical next manifest (version bumped) and verify the
 *    stored bytes BYTE-EXACT against what was written;
 *  - honesty around what verification claims: a concurrent manifest writer,
 *    a torn/normalized write, or a vanished key is a LOUD
 *    write_verification_failed (the contrast pin against the Wix GET→PUT
 *    residual — here the interleaving IS visible); render-verification is
 *    explicitly NOT claimed (MONITOR's job, ~60s KV propagation);
 *  - never clobber: a foreign/corrupt stored manifest refuses every
 *    operation and is never overwritten; a DISABLED rule (out-of-band ops
 *    state) refuses read and write;
 *  - every failure mode maps to the typed WriteMethodError contract
 *    (403 rotated token, deleted namespace vs missing key on 404, 429 +
 *    Retry-After whitelisting, HTML interstitial, non-JSON, 5xx with the
 *    NUMERIC Cloudflare code sanitized — free text never echoed, network);
 *  - multi-tenant discipline: pinned account/zone/worker/namespace validated
 *    at construction, AdapterContext re-asserted pre-network, the API host
 *    pinned outright, every request URL composed from pinned state only —
 *    the pin IS the isolation boundary;
 *  - credentials: resolved per call from the vault seam, egress ONLY via the
 *    Bearer Authorization header, leak through no error/log/serialization
 *    surface (the 1.2 leak-check discipline).
 */

import util from "node:util";
import { describe, expect, it } from "vitest";
import {
  fixedClock,
  type AdapterContext,
  type AdapterWrite,
} from "@/lib/change-management";
import {
  VendorCredential,
  type ConnectorScope,
  type SecretsResolver,
} from "@/lib/connectors";
import type { Json } from "@/lib/types/db";
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_KEY,
  parseManifest,
  serializeManifest,
  type EdgeRulesManifest,
} from "../../../../workers/edge-autofix/src/manifest";
import { WriteMethodError, type WriteMethodErrorCode } from "../shared/errors";
import {
  CloudflareEdgeAdapter,
  CLOUDFLARE_API_HOST,
  type CloudflareEdgeAdapterConfig,
} from "./adapter";
import { FakeCloudflareKv } from "./fake-cloudflare";
import { edgeLocators, ruleFor, parseEdgeTarget } from "./target";

const SECRET = "cf-api-token-4bCdEfGh5ecretT0ken";

const ACCOUNT_ID = "aabbccddeeff00112233445566778899";
const ZONE_ID = "99887766554433221100ffeeddccbbaa";
const NAMESPACE_ID = "0123456789abcdef0123456789abcdef";
const SCRIPT_NAME = "edge-autofix-ggrealty";

const PIN = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
  accountId: ACCOUNT_ID,
  zoneId: ZONE_ID,
  scriptName: SCRIPT_NAME,
  namespaceId: NAMESPACE_ID,
};
const CTX: AdapterContext = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
};
const PAGE_URL = "https://ggrealty.example/pricing";
const MANIFEST_URL = `${CLOUDFLARE_API_HOST}/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${MANIFEST_KEY}`;

const NOW = "2026-07-09T12:00:00.000Z";
const NEW_TITLE = "Pricing | GG Realty";

/** A vault-seam stub that HOLDS the credential as a property, so deep
 * inspection of the adapter graph genuinely reaches it (leak check). */
function makeResolver(secret = SECRET) {
  const calls: Array<{ authRef: string; scope: ConnectorScope }> = [];
  const resolver = {
    credential: new VendorCredential(secret),
    calls,
    resolve: async (authRef: string, scope: ConnectorScope) => {
      calls.push({ authRef, scope });
      return resolver.credential;
    },
  };
  return resolver satisfies SecretsResolver & { credential: VendorCredential };
}

/** Serialize the manifest a sequence of adapter writes should have produced. */
function expectedManifest(
  version: number,
  rules: EdgeRulesManifest["rules"],
): string {
  return serializeManifest({
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    updatedAt: NOW,
    rules,
  });
}

function titleRule(value: string, path = "/pricing") {
  return ruleFor({ kind: "title" }, path, value);
}

function makeAdapter(overrides: Partial<CloudflareEdgeAdapterConfig> = {}) {
  const fake = new FakeCloudflareKv({
    apiToken: SECRET,
    accountId: ACCOUNT_ID,
    namespaceId: NAMESPACE_ID,
  });
  const resolver = makeResolver();
  const adapter = new CloudflareEdgeAdapter({
    pin: PIN,
    secrets: resolver,
    authRef: "vault://cloudflare/prop-1",
    fetch: fake.port,
    clock: fixedClock(NOW),
    ...overrides,
  });
  return { adapter, fake, resolver };
}

function titleWrite(after: Json, before: Json = null): AdapterWrite {
  return {
    target: { url: PAGE_URL, locator: edgeLocators.title() },
    before,
    after,
    ctx: CTX,
  };
}

async function expectFailure(
  promise: Promise<unknown>,
  code: WriteMethodErrorCode,
): Promise<WriteMethodError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WriteMethodError);
  const error = thrown as WriteMethodError;
  expect(error.code).toBe(code);
  expect(error.method).toBe("edge_worker");
  return error;
}

/* ------------------------------------------------------------------ */
/* readCurrent — RULE state, not origin HTML                           */
/* ------------------------------------------------------------------ */

describe("readCurrent", () => {
  it("reads null when no manifest exists yet (the pre-first-write state) — one pinned, Bearer-authed, no-redirect GET", async () => {
    const { adapter, fake, resolver } = makeAdapter();
    await expect(
      adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, CTX),
    ).resolves.toBeNull();

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    expect(fake.requests[0].url).toBe(MANIFEST_URL);
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(fake.requests[0].redirect).toBe("error");
    expect(resolver.calls).toEqual([
      {
        authRef: "vault://cloudflare/prop-1",
        scope: { tenantId: "t1", clientId: "c1" },
      },
    ]);
  });

  it("reads null for an absent rule in an existing manifest, and the value for a present one — origin HTML never enters the picture", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(MANIFEST_KEY, expectedManifest(3, [titleRule("Existing Title")]));

    await expect(
      adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, CTX),
    ).resolves.toBe("Existing Title");
    // Same page, different slot → absent → null.
    await expect(
      adapter.readCurrent(
        { url: PAGE_URL, locator: edgeLocators.metaDescription() },
        CTX,
      ),
    ).resolves.toBeNull();
    // Same slot, different page → absent → null.
    await expect(
      adapter.readCurrent(
        { url: "https://ggrealty.example/other", locator: edgeLocators.title() },
        CTX,
      ),
    ).resolves.toBeNull();
  });

  it("reads a JSON-LD rule's object back byte-exact", async () => {
    const { adapter, fake } = makeAdapter();
    const json = { "@type": "FAQPage", mainEntity: [{ q: "A?" }] };
    fake.seedValue(
      MANIFEST_KEY,
      expectedManifest(1, [ruleFor({ kind: "json_ld", scriptId: "faq" }, "/pricing", json)]),
    );
    await expect(
      adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.jsonLd("faq") }, CTX),
    ).resolves.toEqual(json);
  });

  it("refuses a DISABLED rule loudly — the out-of-band kill-switch state the diff cannot represent", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(
      MANIFEST_KEY,
      expectedManifest(2, [{ ...titleRule("Killed"), enabled: false }]),
    );
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, CTX),
      "invalid_value",
    );
    expect(error.message).toContain("DISABLED");
  });

  it("refuses a foreign/corrupt stored manifest loudly (unexpected_response) — never guesses", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(MANIFEST_KEY, '{"format":"someone-elses/rules","rules":"?"}');
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, CTX),
      "unexpected_response",
    );
    expect(error.message).toContain("not in this platform's format");
  });
});

/* ------------------------------------------------------------------ */
/* apply — upsert one rule slot, verified byte-exact                   */
/* ------------------------------------------------------------------ */

describe("apply", () => {
  it("first-ever write: creates manifest v1 with the one enabled rule, verifies the stored bytes, GET→PUT→GET journal", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(titleWrite(NEW_TITLE));

    // The stored manifest is EXACTLY the canonical serialization.
    expect(fake.value(MANIFEST_KEY)).toBe(expectedManifest(1, [titleRule(NEW_TITLE)]));
    // And it is a manifest the WORKER will accept (strict parse).
    expect(parseManifest(fake.value(MANIFEST_KEY)!)).not.toBeNull();

    expect(fake.requests.map((r) => r.method)).toEqual(["GET", "PUT", "GET"]);
    expect(new Set(fake.requests.map((r) => r.url))).toEqual(new Set([MANIFEST_URL]));
  });

  it("upsert over an existing rule REPLACES its slot and bumps the version; other rules ride along untouched", async () => {
    const { adapter, fake } = makeAdapter();
    const other = ruleFor({ kind: "canonical" }, "/pricing", "https://ggrealty.example/pricing");
    fake.seedValue(MANIFEST_KEY, expectedManifest(4, [titleRule("Old Title"), other]));

    await adapter.apply(titleWrite(NEW_TITLE, "Old Title"));

    expect(fake.value(MANIFEST_KEY)).toBe(
      expectedManifest(5, [titleRule(NEW_TITLE), other]),
    );
  });

  it("a 5xx PUT leaves the stored manifest untouched and surfaces vendor_failure with the NUMERIC code slug", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(MANIFEST_KEY, expectedManifest(1, [titleRule("Old")]));
    fake.failNextWriteWith(500, 10000);

    const error = await expectFailure(
      adapter.apply(titleWrite(NEW_TITLE, "Old")),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(500);
    expect(error.vendorCode).toBe("10000");
    // The vendor's free-text message is NEVER echoed.
    expect(error.message).not.toContain("vendor free-text");
    expect(fake.value(MANIFEST_KEY)).toBe(expectedManifest(1, [titleRule("Old")]));
  });
});

/* ------------------------------------------------------------------ */
/* revert — removal restores absence; restore re-installs byte-exact   */
/* ------------------------------------------------------------------ */

describe("revert", () => {
  it("before=null removes the rule — the origin (never touched) shows through; version bumps", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(titleWrite(NEW_TITLE));
    await adapter.revert(titleWrite(NEW_TITLE, null));

    expect(fake.value(MANIFEST_KEY)).toBe(expectedManifest(2, []));
  });

  it("a non-null before re-installs the prior rule version byte-exact (slot versioning through before-capture)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(MANIFEST_KEY, expectedManifest(1, [titleRule("Prior Title")]));
    await adapter.apply(titleWrite(NEW_TITLE, "Prior Title"));
    await adapter.revert(titleWrite(NEW_TITLE, "Prior Title"));

    expect(fake.value(MANIFEST_KEY)).toBe(expectedManifest(3, [titleRule("Prior Title")]));
  });

  it("removing an already-absent rule is a legal idempotent write (re-run of an interrupted revert)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(MANIFEST_KEY, expectedManifest(6, []));
    await adapter.revert(titleWrite(NEW_TITLE, null));
    expect(fake.value(MANIFEST_KEY)).toBe(expectedManifest(7, []));
  });
});

/* ------------------------------------------------------------------ */
/* Verification honesty — the contrast pin with the Wix residual       */
/* ------------------------------------------------------------------ */

describe("write verification (manifest-level, byte-exact)", () => {
  it("CONTRAST PIN (vs the Wix GET→PUT residual): a concurrent manifest writer IS caught — loud write_verification_failed, never a silent last-writer-wins claim", async () => {
    // On Wix, an in-window concurrent edit echoes back exactly what we sent
    // and NOTHING can flag it (accepted residual, gate-dispositioned
    // 2026-07-09). On THIS method the verification read hits the
    // authoritative store, so an interleaved write — even one landing after
    // a fully successful PUT — makes verification fail loudly and the row
    // stays in its pre-call status. If this test ever fails, the edge
    // method's concurrency story changed — re-examine it against the Wix
    // disposition.
    const { adapter, fake } = makeAdapter();
    const foreign = expectedManifest(9, [titleRule("The other writer won")]);
    fake.overwriteAfterNextPut(foreign);

    const error = await expectFailure(
      adapter.apply(titleWrite(NEW_TITLE)),
      "write_verification_failed",
    );
    expect(error.message).toContain("concurrent");
    // The other write is what the store holds — and we never claimed ours.
    expect(fake.value(MANIFEST_KEY)).toBe(foreign);
  });

  it("a torn/normalized write is caught byte-exact (the corruptor counterfactual proves verification is load-bearing)", async () => {
    const { adapter, fake } = makeAdapter();
    // A single-character divergence in the stored bytes must fail the write.
    fake.corruptNextWrite((stored) => stored.replace(NEW_TITLE, `${NEW_TITLE} `));
    await expectFailure(adapter.apply(titleWrite(NEW_TITLE)), "write_verification_failed");
  });

  it("a manifest that VANISHES between PUT and verification is write_verification_failed, not a success", async () => {
    const { adapter, fake } = makeAdapter();
    fake.deleteAfterNextPut();
    const error = await expectFailure(
      adapter.apply(titleWrite(NEW_TITLE)),
      "write_verification_failed",
    );
    expect(error.message).toContain("read back different");
    expect(fake.value(MANIFEST_KEY)).toBeNull();
  });

  it("write-through a DISABLED rule is refused pre-write in BOTH directions (defense in depth)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.seedValue(
      MANIFEST_KEY,
      expectedManifest(2, [{ ...titleRule("Killed"), enabled: false }]),
    );
    await expectFailure(adapter.apply(titleWrite(NEW_TITLE, "Killed")), "invalid_value");
    await expectFailure(adapter.revert(titleWrite(NEW_TITLE, "Killed")), "invalid_value");
    // Nothing was written past the refusal.
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("a foreign/corrupt stored manifest is NEVER clobbered — both directions refuse before any PUT", async () => {
    const { adapter, fake } = makeAdapter();
    const foreign = '{"whoami":"some other product entirely"}';
    fake.seedValue(MANIFEST_KEY, foreign);
    await expectFailure(adapter.apply(titleWrite(NEW_TITLE)), "unexpected_response");
    await expectFailure(adapter.revert(titleWrite(NEW_TITLE, null)), "unexpected_response");
    expect(fake.value(MANIFEST_KEY)).toBe(foreign);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Failure honesty — the typed error contract                          */
/* ------------------------------------------------------------------ */

describe("failure modes", () => {
  const readTitle = (adapter: CloudflareEdgeAdapter) =>
    adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, CTX);

  it("403 → credential_rejected (rotated/revoked token), numeric slug sanitized", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rotateToken("rotated-away");
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(403);
    expect(error.vendorCode).toBe("9109");
    expect(error.message).toContain("reconnect the property");
  });

  it("401 → credential_rejected too (both are refusals of the token)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.failNextWith(401, 10001);
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(401);
  });

  it("deleted NAMESPACE → target_missing on read AND write (missing KEY is the legitimate null — the two 404s are distinguished by code)", async () => {
    const { adapter, fake } = makeAdapter();
    // Missing key first: legitimate empty state.
    await expect(readTitle(adapter)).resolves.toBeNull();

    fake.deleteNamespace();
    const readError = await expectFailure(readTitle(adapter), "target_missing");
    expect(readError.vendorCode).toBe("10013");
    expect(readError.message).toContain("re-run the edge worker provisioning");
    await expectFailure(adapter.apply(titleWrite(NEW_TITLE)), "target_missing");
  });

  it("429 → rate_limited with a WHITELISTED Retry-After (the operation did NOT happen; nothing retries automatically)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rateLimitNext(30);
    const error = await expectFailure(readTitle(adapter), "rate_limited");
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toContain("NOT performed");
    expect(error.message).toContain("nothing retries automatically");

    // Garbage Retry-After is DROPPED, never echoed.
    fake.rateLimitNext("Wed, 09 Jul 2026 13:00:00 GMT; also s3cret");
    const dropped = await expectFailure(readTitle(adapter), "rate_limited");
    expect(dropped.retryAfterSeconds).toBeUndefined();
    expect(dropped.message).not.toContain("s3cret");
  });

  it("HTML interstitial (challenge page where the API was promised) → unexpected_response", async () => {
    const { adapter, fake } = makeAdapter();
    fake.simulateHtmlInterstitial();
    const error = await expectFailure(readTitle(adapter), "unexpected_response");
    expect(error.message).toContain("HTML page");
  });

  it("network-level failure → network_failure with the WHITELISTED transport code only", async () => {
    const { adapter, fake } = makeAdapter();
    const hostileError = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.cloudflare.com via proxy http://user:s3cret@proxy"),
      { code: "ENOTFOUND" },
    );
    fake.http.failNext(hostileError);
    const error = await expectFailure(readTitle(adapter), "network_failure");
    expect(error.message).toContain("ENOTFOUND");
    expect(error.message).not.toContain("s3cret");
    expect(error.message).not.toContain("proxy");
  });
});

/* ------------------------------------------------------------------ */
/* Pinning — the isolation boundary (doc 04 §5)                        */
/* ------------------------------------------------------------------ */

describe("pinning and isolation", () => {
  it("a mismatched AdapterContext is refused BEFORE any network call (property_mismatch)", async () => {
    const { adapter, fake } = makeAdapter();
    for (const ctx of [
      { ...CTX, tenantId: "t2" },
      { ...CTX, clientId: "c2" },
      { ...CTX, propertyId: "prop-2" },
    ]) {
      await expectFailure(
        adapter.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, ctx),
        "property_mismatch",
      );
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("construction refuses malformed account/zone/namespace ids and script names — without echoing them", () => {
    const bad = [
      { ...PIN, accountId: "not-hex" },
      { ...PIN, zoneId: "abc" },
      { ...PIN, namespaceId: `${NAMESPACE_ID}ff` },
      { ...PIN, scriptName: "Bad_Name!" },
      { ...PIN, accountId: `../../${ACCOUNT_ID}` },
    ];
    for (const pin of bad) {
      let thrown: unknown;
      try {
        makeAdapter({ pin });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      expect((thrown as WriteMethodError).code).toBe("misconfigured");
      expect((thrown as WriteMethodError).message).not.toContain("not-hex");
      expect((thrown as WriteMethodError).message).not.toContain("../");
    }
  });

  it("the API host is pinned outright: any custom base URL is refused at construction without echo; the exact host (± trailing slash) is accepted", () => {
    for (const apiBaseUrl of [
      "https://api.cloudflare.com.evil.example",
      "http://api.cloudflare.com",
      "https://api.cloudflare.com:8443",
      "https://api.cloudflare.com/tenant-x",
      "https://api.cloudflare.com?token=s3cret",
    ]) {
      let thrown: unknown;
      try {
        makeAdapter({ apiBaseUrl });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      expect((thrown as WriteMethodError).code).toBe("misconfigured");
      expect((thrown as WriteMethodError).message).not.toContain("s3cret");
      expect((thrown as WriteMethodError).message).not.toContain("evil");
    }
    expect(() => makeAdapter({ apiBaseUrl: "https://api.cloudflare.com/" })).not.toThrow();
  });

  it("cross-account/namespace refusal: an adapter pinned elsewhere reaches NOTHING through this client's storage", async () => {
    const fake = new FakeCloudflareKv({
      apiToken: SECRET,
      accountId: ACCOUNT_ID,
      namespaceId: NAMESPACE_ID,
      values: { [MANIFEST_KEY]: expectedManifest(1, [titleRule("Client one's rule")]) },
    });
    const resolver = makeResolver();
    const otherPin = {
      tenantId: "t2",
      clientId: "c9",
      propertyId: "prop-9",
      accountId: "ffffffffffffffffffffffffffffffff",
      zoneId: ZONE_ID,
      scriptName: "edge-autofix-other",
      namespaceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    };
    const other = new CloudflareEdgeAdapter({
      pin: otherPin,
      secrets: resolver,
      authRef: "vault://cloudflare/prop-9",
      fetch: fake.port,
      clock: fixedClock(NOW),
    });
    const otherCtx: AdapterContext = { tenantId: "t2", clientId: "c9", propertyId: "prop-9" };

    // Read: not routable. Write: not routable. Nothing stored changes.
    await expectFailure(
      other.readCurrent({ url: PAGE_URL, locator: edgeLocators.title() }, otherCtx),
      "target_missing",
    );
    await expectFailure(
      other.apply({ target: { url: PAGE_URL, locator: edgeLocators.title() }, before: null, after: "X", ctx: otherCtx }),
      "target_missing",
    );
    expect(fake.value(MANIFEST_KEY)).toBe(
      expectedManifest(1, [titleRule("Client one's rule")]),
    );
    // Every URL the other adapter composed names ITS OWN pin, never ours.
    for (const req of fake.requests) {
      expect(req.url).toContain(otherPin.accountId);
      expect(req.url).not.toContain(NAMESPACE_ID);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Credential containment (the 1.2 leak-check discipline)              */
/* ------------------------------------------------------------------ */

describe("credential containment", () => {
  it("the token egresses ONLY via the Authorization header — URL, body, and every stored byte stay clean", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(titleWrite(NEW_TITLE));
    for (const req of fake.requests) {
      expect(req.url).not.toContain(SECRET);
      expect(req.body ?? "").not.toContain(SECRET);
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
    }
    expect(fake.value(MANIFEST_KEY)).not.toContain(SECRET);
  });

  it("no error surface carries the credential (typed failures compose from our coordinates only)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rotateToken("rotated");
    const error = await expectFailure(
      adapter.apply(titleWrite(NEW_TITLE)),
      "credential_rejected",
    );
    expect(error.message).not.toContain(SECRET);
    expect(util.inspect(error, { depth: null })).not.toContain(SECRET);
  });

  it("deep inspection of the adapter graph never prints the secret (VendorCredential containment holds through this adapter)", () => {
    const { adapter } = makeAdapter();
    const printed =
      util.inspect(adapter, { depth: null, showHidden: true }) +
      JSON.stringify(adapter) +
      String(adapter);
    expect(printed).not.toContain(SECRET);
  });
});

/* ------------------------------------------------------------------ */
/* Grammar-level defense in depth through the adapter                  */
/* ------------------------------------------------------------------ */

describe("plan-time refusals through the adapter", () => {
  it("unsupported locators and non-installable values never reach an HTTP call", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "edge:robots" }, CTX),
      "unsupported_operation",
    );
    await expectFailure(adapter.apply(titleWrite(42)), "invalid_value");
    await expectFailure(
      adapter.apply(titleWrite(NEW_TITLE, { text: "bad shape" })),
      "invalid_value",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("parseEdgeTarget and the adapter agree on the slot (no drift between plan and write)", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(titleWrite(NEW_TITLE));
    const address = parseEdgeTarget({ url: PAGE_URL, locator: edgeLocators.title() });
    const manifest = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(manifest.rules.map((r) => r.id)).toEqual([address.ruleId]);
  });
});
