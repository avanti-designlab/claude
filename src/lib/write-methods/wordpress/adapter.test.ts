/**
 * WordPressAdapter unit suite — mocked HTTP only (the FetchPort is injected;
 * no test touches a network).
 *
 * Proves the adapter-level safety contract:
 *  - reads capture the RAW (byte-exact) field; writes install exactly one
 *    field and verify the site stored it byte-exact;
 *  - every failure mode maps to the typed WriteMethodError contract with
 *    interface-voice messages (401/403, 404, the wp-login HTML classic,
 *    non-JSON, 5xx, network, unexposed meta);
 *  - plan-time rejection: unsupported operations and non-restorable values
 *    never reach an HTTP call;
 *  - multi-tenant discipline: the adapter is pinned to one property/origin —
 *    mismatched contexts and cross-origin targets are refused pre-network;
 *  - credentials: resolved per call from the vault seam, egress ONLY via the
 *    Authorization header, leak through no error/log/serialization surface
 *    (the 1.2 leak-check discipline).
 */

import util from "node:util";
import { describe, expect, it } from "vitest";
import type { AdapterContext, AdapterWrite } from "@/lib/change-management";
import {
  VendorCredential,
  type ConnectorScope,
  type SecretsResolver,
} from "@/lib/connectors";
import type { Json } from "@/lib/types/db";
import { WriteMethodError, type WriteMethodErrorCode } from "../shared/errors";
import { basicAuthHeader } from "../shared/http";
import { ScriptedFetch, textResponse } from "../shared/http-harness";
import { WordPressAdapter, type WordPressAdapterConfig } from "./adapter";
import { FakeWordPress } from "./fake-wp";
import { wordpressLocators } from "./target";

const SECRET = "gg-operator:AbCd EfGh IjKl MnOp";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const SITE = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
  baseUrl: "https://ggrealty.example",
};
const CTX: AdapterContext = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
};
const PAGE_URL = "https://ggrealty.example/pricing";

const ORIGINAL_TITLE = "Homes for Sale in San Diego";
const ORIGINAL_CONTENT = "<p>Original body</p>";
const ORIGINAL_DESC = "Old description";

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

function makeFake() {
  return new FakeWordPress({
    credential: SECRET,
    posts: {
      42: {
        title: ORIGINAL_TITLE,
        content: ORIGINAL_CONTENT,
        meta: {
          _aeo_meta_description: ORIGINAL_DESC,
          _aeo_schema_jsonld: { "@type": "RealEstateAgent" },
        },
      },
    },
    pages: { 7: { title: "About GG Realty" } },
    media: { 55: { altText: "house" } },
  });
}

function makeAdapter(overrides: Partial<WordPressAdapterConfig> = {}) {
  const fake = makeFake();
  const resolver = makeResolver();
  const adapter = new WordPressAdapter({
    site: SITE,
    secrets: resolver,
    authRef: "vault://wp/prop-1",
    fetch: fake.port,
    ...overrides,
  });
  return { adapter, fake, resolver };
}

function titleWrite(after: Json, before: Json = ORIGINAL_TITLE): AdapterWrite {
  return {
    target: { url: PAGE_URL, locator: wordpressLocators.postTitle(42) },
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
  expect(error.method).toBe("wordpress");
  return error;
}

/* ------------------------------------------------------------------ */
/* readCurrent — byte-exact capture                                    */
/* ------------------------------------------------------------------ */

describe("readCurrent", () => {
  it("reads the RAW title via context=edit with vault-resolved Basic auth", async () => {
    const { adapter, fake, resolver } = makeAdapter();
    const value = await adapter.readCurrent(
      { url: PAGE_URL, locator: "wp:post/42/title" },
      CTX,
    );
    expect(value).toBe(ORIGINAL_TITLE);

    // Exactly one request, to the pinned site, in edit context, Basic-authed.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    expect(fake.requests[0].url).toBe(
      "https://ggrealty.example/wp-json/wp/v2/posts/42?context=edit",
    );
    expect(fake.requests[0].headers.authorization).toBe(basicAuthHeader(SECRET));
    // The vault seam was hit at call time, tenant-scoped.
    expect(resolver.calls).toEqual([
      {
        authRef: "vault://wp/prop-1",
        scope: { tenantId: "t1", clientId: "c1" },
      },
    ]);
  });

  it("reads content, meta values (any JSON shape), and media alt_text", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/content" }, CTX),
    ).resolves.toBe(ORIGINAL_CONTENT);
    await expect(
      adapter.readCurrent(
        { url: PAGE_URL, locator: "wp:post/42/meta/_aeo_schema_jsonld" },
        CTX,
      ),
    ).resolves.toEqual({ "@type": "RealEstateAgent" });
    await expect(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:media/55/alt_text" }, CTX),
    ).resolves.toBe("house");
  });

  it("refuses an unexposed meta key as target_missing (WP would silently drop the write)", async () => {
    const { adapter, fake } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        { url: PAGE_URL, locator: "wp:post/42/meta/_not_registered" },
        CTX,
      ),
      "target_missing",
    );
    expect(error.message).toContain("_not_registered");
    expect(error.message).toContain("not exposed");
    // The read happened (that is how exposure is detected) but no write ever will.
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("refuses a live null meta value — a state rollback could not restore is caught at plan time", async () => {
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: { 42: { title: "t", meta: { _weird: null } } },
    });
    const { adapter } = makeAdapter({ fetch: fake.port });
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/meta/_weird" }, CTX),
      "invalid_value",
    );
    expect(error.message).toContain("byte-exact");
  });

  it("supports subdirectory installs (base path is preserved in the REST root)", async () => {
    const { fake, resolver } = makeAdapter();
    const adapter = new WordPressAdapter({
      site: { ...SITE, baseUrl: "https://ggrealty.example/blog/" },
      secrets: resolver,
      authRef: "vault://wp/prop-1",
      fetch: fake.port,
    });
    await adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX);
    expect(fake.requests[0].url).toBe(
      "https://ggrealty.example/blog/wp-json/wp/v2/posts/42?context=edit",
    );
  });
});

/* ------------------------------------------------------------------ */
/* apply / revert — one verified field write                           */
/* ------------------------------------------------------------------ */

describe("apply", () => {
  it("POSTs exactly one field and verifies the site stored it byte-exact", async () => {
    const { adapter, fake } = makeAdapter();
    const after = "San Diego Homes for Sale | GG Realty";
    await adapter.apply(titleWrite(after));

    const post = fake.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(
      "https://ggrealty.example/wp-json/wp/v2/posts/42?context=edit",
    );
    // Exactly one field in the update body — never a broader entity write.
    expect(JSON.parse(post?.body ?? "")).toEqual({ title: after });
    expect(fake.post(42).title).toBe(after);
    // Untouched siblings stay untouched.
    expect(fake.post(42).content).toBe(ORIGINAL_CONTENT);
  });

  it("writes meta (schema JSON-LD) under the single key", async () => {
    const { adapter, fake } = makeAdapter();
    const jsonLd: Json = { "@context": "https://schema.org", "@type": "FAQPage" };
    await adapter.apply({
      target: { url: PAGE_URL, locator: "wp:post/42/meta/_aeo_schema_jsonld" },
      before: { "@type": "RealEstateAgent" },
      after: jsonLd,
      ctx: CTX,
    });
    expect(fake.post(42).meta._aeo_schema_jsonld).toEqual(jsonLd);
    const post = fake.requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      meta: { _aeo_schema_jsonld: jsonLd },
    });
  });

  it("reports write_verification_failed when the site stores an altered value (kses/filters)", async () => {
    const { adapter, fake } = makeAdapter();
    // Simulate kses stripping for a capability-limited application password.
    fake.mutateWrites((v) => v.replace(/<script>.*?<\/script>/g, ""));
    const error = await expectFailure(
      adapter.apply(
        titleWrite("Best homes <script>alert(1)</script> in town"),
      ),
      "write_verification_failed",
    );
    expect(error.message).toContain("stored a different value");
  });

  it("rejects a non-restorable BEFORE pre-network — rollback impossibility never reaches the site", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(adapter.apply(titleWrite("New", null)), "invalid_value");
    await expectFailure(adapter.apply(titleWrite(null)), "invalid_value");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects an unsupported operation pre-network", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.apply({
        target: { url: PAGE_URL, locator: "wp:post/42/slug" },
        before: "old-slug",
        after: "new-slug",
        ctx: CTX,
      }),
      "unsupported_operation",
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("revert", () => {
  it("restores the captured before-state byte-exact through the same surface", async () => {
    const { adapter, fake } = makeAdapter();
    const write = titleWrite("San Diego Homes for Sale | GG Realty");
    await adapter.apply(write);
    expect(fake.post(42).title).toBe(write.after);

    await adapter.revert(write);
    expect(fake.post(42).title).toBe(ORIGINAL_TITLE);
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1].body ?? "")).toEqual({ title: ORIGINAL_TITLE });
  });

  it("fails loudly (write_verification_failed) when the restore would not be byte-exact — the row must stay applied", async () => {
    const { adapter, fake } = makeAdapter();
    const write: AdapterWrite = {
      target: { url: PAGE_URL, locator: "wp:post/42/content" },
      before: '<p>Original body with <iframe src="x"></iframe></p>',
      after: "<p>clean</p>",
      ctx: CTX,
    };
    // The restore direction hits kses: the stored value would differ.
    fake.mutateWrites((v) => v.replace(/<iframe[^>]*><\/iframe>/g, ""));
    await expectFailure(adapter.revert(write), "write_verification_failed");
  });
});

/* ------------------------------------------------------------------ */
/* Failure honesty — the typed error contract                          */
/* ------------------------------------------------------------------ */

describe("failure modes", () => {
  it("401 → credential_rejected (revoked application password), with the WP slug", async () => {
    const { adapter } = makeAdapter({
      secrets: makeResolver("gg-operator:revoked revoked revoked"),
    });
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
      "credential_rejected",
    );
    expect(error.httpStatus).toBe(401);
    expect(error.vendorCode).toBe("incorrect_password");
    expect(error.message).toContain("reconnect the property");
  });

  it("403 → credential_rejected (permission, not identity)", async () => {
    const scripted = new ScriptedFetch().on("*", /./, () =>
      textResponse(403, JSON.stringify({ code: "rest_forbidden_context" }), "application/json"),
    );
    const { adapter } = makeAdapter({ fetch: scripted.port });
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
      "credential_rejected",
    );
    expect(error.httpStatus).toBe(403);
    expect(error.vendorCode).toBe("rest_forbidden_context");
  });

  it("404 → target_missing (deleted since the audit)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.remove("posts", 42);
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
      "target_missing",
    );
    expect(error.httpStatus).toBe(404);
    expect(error.vendorCode).toBe("rest_post_invalid_id");
  });

  it("HTML instead of JSON (the wp-login redirect classic) → unexpected_response, named honestly", async () => {
    const { adapter, fake } = makeAdapter();
    fake.simulateLoginRedirect();
    const error = await expectFailure(
      adapter.apply(titleWrite("New")),
      "unexpected_response",
    );
    expect(error.message).toContain("HTML page instead of a REST response");
    expect(error.message).toContain("login redirect");
    // The raw HTML body never leaks into the message.
    expect(error.message).not.toContain("<html");
    expect(error.message).not.toContain("wp-login");
  });

  it("non-JSON garbage → unexpected_response without echoing the body", async () => {
    const scripted = new ScriptedFetch().on("*", /./, () =>
      textResponse(200, "PROXY ERROR :: upstream sadness"),
    );
    const { adapter } = makeAdapter({ fetch: scripted.port });
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
      "unexpected_response",
    );
    expect(error.message).toContain("not valid JSON");
    expect(error.message).not.toContain("upstream sadness");
  });

  it("5xx with a WP error envelope → vendor_failure carrying status + sanitized slug only", async () => {
    const { adapter, fake } = makeAdapter();
    fake.failNextWriteWith(500, "internal_server_error");
    const error = await expectFailure(
      adapter.apply(titleWrite("New")),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(500);
    expect(error.vendorCode).toBe("internal_server_error");
    // The envelope's free-text message is NOT trusted into ours.
    expect(error.message).not.toContain("Internal error");
    // The failed write did not alter the site.
    expect(fake.post(42).title).toBe(ORIGINAL_TITLE);
  });

  it("transport failure → network_failure naming the pinned origin", async () => {
    const { adapter, fake } = makeAdapter();
    fake.http.failNext(new Error("getaddrinfo ENOTFOUND ggrealty.example"));
    const error = await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
      "network_failure",
    );
    expect(error.message).toContain("https://ggrealty.example");
  });
});

/* ------------------------------------------------------------------ */
/* Network-failure detail whitelisting (never echo err.message)        */
/* ------------------------------------------------------------------ */

describe("network failure detail whitelisting", () => {
  const read = (adapter: WordPressAdapter) =>
    adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX);

  it("surfaces only a whitelisted code — the transport error's free text (proxy banners, hosts) never leaks", async () => {
    const { adapter, fake } = makeAdapter();
    fake.http.failNext(
      Object.assign(
        new Error("connect ECONNREFUSED 10.0.0.5:443 via corp-proxy (auth=hunter2)"),
        { code: "ECONNREFUSED" },
      ),
    );
    const error = await expectFailure(read(adapter), "network_failure");
    expect(error.message).toContain("https://ggrealty.example");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("corp-proxy");
    expect(error.message).not.toContain("10.0.0.5");
  });

  it("finds the code on the error's cause (where undici's fetch wraps it)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.http.failNext(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND internal-vpn-host"), {
          code: "ENOTFOUND",
        }),
      }),
    );
    const error = await expectFailure(read(adapter), "network_failure");
    expect(error.message).toContain("ENOTFOUND");
    expect(error.message).not.toContain("fetch failed");
    expect(error.message).not.toContain("internal-vpn-host");
  });

  it("falls back to the error NAME when no code exists (the TypeError a refused redirect rejects with)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.http.failNext(
      new TypeError("Failed to fetch: redirect mode set to error, Location: https://evil.example/next"),
    );
    const error = await expectFailure(read(adapter), "network_failure");
    expect(error.message).toContain("TypeError");
    expect(error.message).not.toContain("evil.example");
    expect(error.message).not.toContain("Failed to fetch");
  });
});

/* ------------------------------------------------------------------ */
/* Redirect policy — stated explicitly on every request                */
/* ------------------------------------------------------------------ */

describe("redirect policy", () => {
  it("every request the adapter sends states redirect: 'error' — a redirect is never followed", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX);
    await adapter.apply(titleWrite("New Title"));
    expect(fake.requests.length).toBeGreaterThan(1); // read + write, both pinned
    for (const req of fake.requests) {
      expect(req.redirect).toBe("error");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Registered-meta fidelity (real wp/v2 REST behavior)                 */
/* ------------------------------------------------------------------ */

describe("registered-meta fidelity", () => {
  it("meta: [] (the PHP empty-array quirk — no registered meta) diagnoses as target_missing with the register-the-key fix, never unexpected_response", async () => {
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: {
        42: { title: "t", meta: { _aeo_meta_description: "stored but unregistered" } },
      },
      registeredMeta: {}, // zero registered keys → real WP serializes meta as []
    });
    const { adapter } = makeAdapter({ fetch: fake.port });
    const error = await expectFailure(
      adapter.readCurrent(
        { url: PAGE_URL, locator: "wp:post/42/meta/_aeo_meta_description" },
        CTX,
      ),
      "target_missing",
    );
    // The ACCURATE interface-voice diagnosis: the key is not exposed and a
    // plugin must register it — not a bogus incompatible-WordPress warning.
    expect(error.message).toContain("_aeo_meta_description");
    expect(error.message).toContain("not exposed");
    expect(error.message).toContain("register");
    expect(error.message).not.toContain("incompatible");
    // Diagnosed from the read — no write ever attempted.
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("direct-apply honesty: a write WP silently drops (unregistered key) is reported target_missing from the write's own echo", async () => {
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: { 42: { title: "t", meta: { _aeo_meta_description: "old" } } },
      registeredMeta: { _aeo_meta_description: "string" },
    });
    const { adapter } = makeAdapter({ fetch: fake.port });
    const error = await expectFailure(
      adapter.apply({
        target: { url: PAGE_URL, locator: "wp:post/42/meta/_unregistered_key" },
        before: "old",
        after: "new",
        ctx: CTX,
      }),
      "target_missing",
    );
    expect(error.message).toContain("_unregistered_key");
    expect(error.message).toContain("register");
    // The POST happened (real WP answers 200 while dropping the key)...
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    // ...but the adapter refused to claim success, and the site truly has no key.
    expect(fake.post(42).meta).not.toHaveProperty("_unregistered_key");
    expect(fake.post(42).meta._aeo_meta_description).toBe("old"); // untouched sibling
  });

  it("a registered-type mismatch fails 400 rest_invalid_param → vendor_failure with status + slug, site untouched", async () => {
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: { 42: { title: "t", meta: { _aeo_word_count: 100 } } },
      registeredMeta: { _aeo_word_count: "number" },
    });
    const { adapter } = makeAdapter({ fetch: fake.port });
    const error = await expectFailure(
      adapter.apply({
        target: { url: PAGE_URL, locator: "wp:post/42/meta/_aeo_word_count" },
        before: 100,
        after: "not-a-number",
        ctx: CTX,
      }),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(400);
    expect(error.vendorCode).toBe("rest_invalid_param");
    // The envelope's free-text message is never trusted into ours.
    expect(error.message).not.toContain("Invalid parameter");
    expect(fake.post(42).meta._aeo_word_count).toBe(100);
  });

  it("a registered key still round-trips byte-exact under whitelist mode", async () => {
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: { 42: { title: "t", meta: { _aeo_meta_description: "old desc" } } },
      registeredMeta: { _aeo_meta_description: "string" },
    });
    const { adapter } = makeAdapter({ fetch: fake.port });
    const target = {
      url: PAGE_URL,
      locator: "wp:post/42/meta/_aeo_meta_description",
    };
    await expect(adapter.readCurrent(target, CTX)).resolves.toBe("old desc");
    const write: AdapterWrite = { target, before: "old desc", after: "new desc", ctx: CTX };
    await adapter.apply(write);
    expect(fake.post(42).meta._aeo_meta_description).toBe("new desc");
    await adapter.revert(write);
    expect(fake.post(42).meta._aeo_meta_description).toBe("old desc");
  });
});

/* ------------------------------------------------------------------ */
/* Multi-tenant discipline — pinned property + pinned origin           */
/* ------------------------------------------------------------------ */

describe("site pinning", () => {
  const foreignContexts: Array<[string, AdapterContext]> = [
    ["another tenant", { ...CTX, tenantId: "t2" }],
    ["another client", { ...CTX, clientId: "c2" }],
    ["another property", { ...CTX, propertyId: "prop-2" }],
  ];

  it.each(foreignContexts)("refuses a context for %s pre-network (property_mismatch)", async (_label, ctx) => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, ctx),
      "property_mismatch",
    );
    await expectFailure(
      adapter.apply({ ...titleWrite("New"), ctx }),
      "property_mismatch",
    );
    await expectFailure(
      adapter.revert({ ...titleWrite("New"), ctx }),
      "property_mismatch",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["an absolute URL on another site", "https://other-client.example/pricing"],
    ["a same-host different-port URL", "https://ggrealty.example:8443/pricing"],
    ["a protocol-relative URL to another host", "//evil.example/pricing"],
  ])("refuses %s pre-network (cross_site_target)", async (_label, url) => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.apply({ ...titleWrite("New"), target: { url, locator: "wp:post/42/title" } }),
      "cross_site_target",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a userinfo-bearing target URL pre-network WITHOUT echoing it (same- and cross-origin alike)", async () => {
    const { adapter, fake } = makeAdapter();
    for (const url of [
      "https://wp-admin:sekrit-target@ggrealty.example/pricing", // pinned origin
      "https://wp-admin:sekrit-target@evil.example/pricing", // foreign origin
    ]) {
      const error = await expectFailure(
        adapter.apply({
          ...titleWrite("New"),
          target: { url, locator: "wp:post/42/title" },
        }),
        "unsupported_operation",
      );
      // The URL is the thing carrying a credential — never echoed, on any surface.
      expect(error.message).toContain("embeds credentials");
      expect(error.message).not.toContain("sekrit-target");
      expect(error.message).not.toContain("wp-admin");
      expect(error.message).not.toContain(url);
      // Also refused on the read path, pre-network.
      await expectFailure(
        adapter.readCurrent({ url, locator: "wp:post/42/title" }, CTX),
        "unsupported_operation",
      );
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("accepts same-origin absolute and relative target URLs; requests are built ONLY from the pinned base", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.readCurrent(
      { url: "/pricing", locator: "wp:post/42/title" },
      CTX,
    );
    await adapter.readCurrent(
      { url: "https://ggrealty.example/pricing?utm=x", locator: "wp:post/42/title" },
      CTX,
    );
    for (const req of fake.requests) {
      expect(req.url.startsWith("https://ggrealty.example/wp-json/wp/v2/")).toBe(true);
    }
  });

  it("refuses to be constructed on an unusable base URL (misconfigured)", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    const build = (baseUrl: string) =>
      new WordPressAdapter({
        site: { ...SITE, baseUrl },
        secrets: resolver,
        authRef: "vault://wp/prop-1",
        fetch: fake.port,
      });
    for (const bad of [
      "not a url",
      "ftp://ggrealty.example",
      "http://ggrealty.example", // cleartext — the app password would egress unencrypted
      "https://user:pass@ggrealty.example", // creds belong in the vault
      "https://ggrealty.example/?p=1",
      "https://ggrealty.example/#x",
    ]) {
      let thrown: unknown;
      try {
        build(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      expect((thrown as WriteMethodError).code).toBe("misconfigured");
    }
    // The creds-in-URL refusal must not echo the URL (it carries the secret).
    let credsError: unknown;
    try {
      build("https://user:sekrit-pass@ggrealty.example");
    } catch (err) {
      credsError = err;
    }
    expect((credsError as WriteMethodError).message).not.toContain("sekrit-pass");
  });

  it("refuses an http: base URL at construction — the application password never travels cleartext (no dev opt-out)", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    let thrown: unknown;
    try {
      new WordPressAdapter({
        site: { ...SITE, baseUrl: "http://ggrealty.example" },
        secrets: resolver,
        authRef: "vault://wp/prop-1",
        fetch: fake.port,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WriteMethodError);
    const error = thrown as WriteMethodError;
    expect(error.code).toBe("misconfigured");
    // Interface-voice: the operator is told to reconnect over HTTPS.
    expect(error.message).toContain("HTTPS");
    expect(error.message).toContain("https://");
    // Constructor refusal means zero requests could ever carry the credential.
    expect(fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Credential containment (doc 04 §5 + the 1.2 leak-check discipline)  */
/* ------------------------------------------------------------------ */

describe("credential containment", () => {
  it("the secret's ONLY egress is the Authorization header of requests to the pinned site", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(titleWrite("New Title"));
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const req of fake.requests) {
      expect(req.headers.authorization).toBe(`Basic ${SECRET_B64}`);
      expect(req.url).not.toContain(SECRET);
      expect(req.url).not.toContain(SECRET_B64);
      expect(req.body ?? "").not.toContain(SECRET);
      expect(req.body ?? "").not.toContain(SECRET_B64);
    }
  });

  it("no failure-mode error carries the secret (raw or base64) on any surface", async () => {
    const errors: WriteMethodError[] = [];

    // 401 while the real secret is resolved (fake expects something else).
    const fake401 = new FakeWordPress({ credential: "someone:else", posts: { 42: { title: "t" } } });
    const { adapter: a401 } = makeAdapter({ fetch: fake401.port });
    errors.push(
      await expectFailure(
        a401.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
        "credential_rejected",
      ),
    );

    // Login-redirect HTML, vendor failure, network failure.
    const { adapter: aHtml, fake: fakeHtml } = makeAdapter();
    fakeHtml.simulateLoginRedirect();
    errors.push(
      await expectFailure(aHtml.apply(titleWrite("N")), "unexpected_response"),
    );
    const { adapter: aVendor, fake: fakeVendor } = makeAdapter();
    fakeVendor.failNextWriteWith(502, "bad_gateway");
    errors.push(await expectFailure(aVendor.apply(titleWrite("N")), "vendor_failure"));
    const { adapter: aNet, fake: fakeNet } = makeAdapter();
    fakeNet.http.failNext();
    errors.push(
      await expectFailure(
        aNet.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX),
        "network_failure",
      ),
    );

    for (const error of errors) {
      const surfaces = [
        error.message,
        util.inspect(error, { showHidden: true, depth: null }),
        JSON.stringify({ error: error.message, code: error.code }),
        String(error),
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(SECRET);
        expect(surface).not.toContain(SECRET_B64);
      }
    }
  });

  it("deep inspection of the adapter graph reaches only the MASKED credential", async () => {
    const { adapter, resolver } = makeAdapter();
    // The resolver stub holds the VendorCredential as a plain property, so
    // util.inspect genuinely traverses to it — and must hit the mask.
    const surfaces = [
      util.inspect(adapter, { showHidden: true, depth: null }),
      util.inspect(resolver, { showHidden: true, depth: null }),
      JSON.stringify(resolver),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET);
      expect(surface).not.toContain(SECRET_B64);
    }
    expect(util.inspect(resolver.credential)).toBe("VendorCredential(***)");
    // ...while the adapter can still use it.
    await adapter.readCurrent({ url: PAGE_URL, locator: "wp:post/42/title" }, CTX);
  });
});
