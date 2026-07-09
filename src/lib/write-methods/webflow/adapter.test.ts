/**
 * WebflowAdapter unit suite — mocked HTTP only (the FetchPort is injected;
 * no test touches a network).
 *
 * Proves the adapter-level safety contract:
 *  - reads capture the byte-exact STAGED field; writes install exactly one
 *    field, verify the site stored it byte-exact, and NEVER publish — the
 *    live site stays byte-identical through every apply and revert;
 *  - every failure mode maps to the typed WriteMethodError contract with
 *    interface-voice messages (401/403, 404, 429 + Retry-After whitelisting,
 *    the HTML-interstitial classic, non-JSON, 5xx, network);
 *  - plan-time rejection: unsupported operations, non-restorable values, and
 *    mirrored Open Graph fields never reach a write;
 *  - multi-tenant discipline: the adapter is pinned to one property AND one
 *    Webflow site — mismatched contexts are refused pre-network, and targets
 *    are proven to belong to the pinned site at the API level BEFORE any
 *    write (page siteId echo; collection membership in the pinned site's own
 *    list); the API host itself is pinned outright;
 *  - credentials: resolved per call from the vault seam, egress ONLY via the
 *    Bearer Authorization header, leak through no error/log/serialization
 *    surface (the 1.2 leak-check discipline).
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
import { bearerAuthHeader } from "../shared/http";
import { ScriptedFetch, textResponse } from "../shared/http-harness";
import { WebflowAdapter, type WebflowAdapterConfig } from "./adapter";
import { FakeWebflow } from "./fake-webflow";
import { webflowLocators } from "./target";

const SECRET = "wf-pat-4bCdEfGh.5ecret.T0ken";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

/** Webflow ids are 24 lowercase hex chars; pad hex-safe mnemonics with zeros. */
const wfid = (tail: string) => tail.padStart(24, "0");
const SITE_ID = wfid("c0ffee");
const OTHER_SITE_ID = wfid("baddad");
const PAGE_ID = wfid("9a9e1");
const MIRRORED_PAGE_ID = wfid("9a9e2");
const FOREIGN_PAGE_ID = wfid("9a9e3");
const COLLECTION_ID = wfid("c011");
const FOREIGN_COLLECTION_ID = wfid("c012");
const ITEM_ID = wfid("17e1");
const FOREIGN_ITEM_ID = wfid("17e2");

const SITE = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
  siteId: SITE_ID,
};
const CTX: AdapterContext = {
  tenantId: "t1",
  clientId: "c1",
  propertyId: "prop-1",
};
const PAGE_URL = "https://ggrealty.example/listings";

const ORIGINAL_SEO_TITLE = "Homes for Sale in San Diego";
const ORIGINAL_SEO_DESC = "Browse San Diego listings, updated daily.";
const ORIGINAL_OG_TITLE = "GG Realty — San Diego Homes";
const ORIGINAL_SUMMARY = "Old listing summary";
const FAQ_SCHEMA: Json = { "@type": "FAQPage" };

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
  return new FakeWebflow({
    token: SECRET,
    siteId: SITE_ID,
    pages: {
      [PAGE_ID]: {
        name: "Listings",
        seo: { title: ORIGINAL_SEO_TITLE, description: ORIGINAL_SEO_DESC },
        // Seeded OG values → mirror flags default OFF (owner disabled them).
        openGraph: { title: ORIGINAL_OG_TITLE, description: "OG description" },
      },
      [MIRRORED_PAGE_ID]: {
        name: "About",
        seo: { title: "About GG Realty" },
        // openGraph unseeded → BOTH mirror flags default ON (Webflow's default).
      },
      [FOREIGN_PAGE_ID]: {
        siteId: OTHER_SITE_ID,
        name: "Another client's page",
        seo: { title: "Not ours" },
      },
    },
    collections: {
      [COLLECTION_ID]: {
        fields: ["summary", "faq-schema", "beds"],
        items: {
          [ITEM_ID]: {
            name: "Casa Uno",
            slug: "casa-uno",
            summary: ORIGINAL_SUMMARY,
            "faq-schema": FAQ_SCHEMA,
            beds: 3,
          },
        },
      },
      [FOREIGN_COLLECTION_ID]: {
        siteId: OTHER_SITE_ID,
        items: { [FOREIGN_ITEM_ID]: { summary: "another client's item" } },
      },
    },
  });
}

function makeAdapter(overrides: Partial<WebflowAdapterConfig> = {}) {
  const fake = makeFake();
  const resolver = makeResolver();
  const adapter = new WebflowAdapter({
    site: SITE,
    secrets: resolver,
    authRef: "vault://webflow/prop-1",
    fetch: fake.port,
    ...overrides,
  });
  return { adapter, fake, resolver };
}

function seoTitleWrite(
  after: Json,
  before: Json = ORIGINAL_SEO_TITLE,
): AdapterWrite {
  return {
    target: { url: PAGE_URL, locator: webflowLocators.pageSeoTitle(PAGE_ID) },
    before,
    after,
    ctx: CTX,
  };
}

function summaryWrite(after: Json, before: Json = ORIGINAL_SUMMARY): AdapterWrite {
  return {
    target: {
      url: PAGE_URL,
      locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "summary"),
    },
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
  expect(error.method).toBe("webflow");
  return error;
}

/** No adapter call may ever touch a publish or live endpoint. */
function expectNoPublishTraffic(fake: FakeWebflow): void {
  for (const req of fake.requests) {
    expect(req.url).not.toContain("publish");
    expect(req.url).not.toMatch(/\/live(\?|$)/);
  }
}

/* ------------------------------------------------------------------ */
/* readCurrent — byte-exact STAGED capture                             */
/* ------------------------------------------------------------------ */

describe("readCurrent", () => {
  it("reads the staged seo.title from the pinned host with vault-resolved Bearer auth", async () => {
    const { adapter, fake, resolver } = makeAdapter();
    const value = await adapter.readCurrent(
      { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
      CTX,
    );
    expect(value).toBe(ORIGINAL_SEO_TITLE);

    // Exactly one request, to the pinned API host, Bearer-authed, no-redirect.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    expect(fake.requests[0].url).toBe(
      `https://api.webflow.com/v2/pages/${PAGE_ID}`,
    );
    expect(fake.requests[0].headers.authorization).toBe(bearerAuthHeader(SECRET));
    expect(fake.requests[0].redirect).toBe("error");
    // The vault seam was hit at call time, tenant-scoped.
    expect(resolver.calls).toEqual([
      {
        authRef: "vault://webflow/prop-1",
        scope: { tenantId: "t1", clientId: "c1" },
      },
    ]);
  });

  it("reads og fields (mirror off) and item fields of any JSON shape", async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.readCurrent(
        { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/og.title` },
        CTX,
      ),
    ).resolves.toBe(ORIGINAL_OG_TITLE);
    await expect(
      adapter.readCurrent(summaryWrite("x").target, CTX),
    ).resolves.toBe(ORIGINAL_SUMMARY);
    await expect(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "faq-schema"),
        },
        CTX,
      ),
    ).resolves.toEqual(FAQ_SCHEMA);
    await expect(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "beds"),
        },
        CTX,
      ),
    ).resolves.toBe(3);
  });

  it("proves collection membership through the PINNED site's own list before touching an item", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.readCurrent(summaryWrite("x").target, CTX);
    expect(fake.requests.map((r) => r.url)).toEqual([
      `https://api.webflow.com/v2/sites/${SITE_ID}/collections`,
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${ITEM_ID}`,
    ]);
  });

  it("refuses a MIRRORED og field as unsupported_operation — the value is derived and the flag cannot round-trip", async () => {
    const { adapter, fake } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        { url: PAGE_URL, locator: `webflow:page/${MIRRORED_PAGE_ID}/og.title` },
        CTX,
      ),
      "unsupported_operation",
    );
    expect(error.message).toContain("MIRRORS");
    expect(error.message).toContain("titleCopied");
    expect(error.message).toContain("write the SEO title instead");
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("refuses an UNSET (null) page field — a state rollback could not restore is caught at plan time", async () => {
    const { adapter } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: `webflow:page/${MIRRORED_PAGE_ID}/seo.description`,
        },
        CTX,
      ),
      "invalid_value",
    );
    expect(error.message).toContain("unset");
    expect(error.message).toContain("byte-exact");
  });

  it("refuses an absent item field as target_missing (no such field, or never valued — Webflow omits unset fields)", async () => {
    const { adapter, fake } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "floor-plan"),
        },
        CTX,
      ),
      "target_missing",
    );
    expect(error.message).toContain("floor-plan");
    expect(error.message).toContain("unset");
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* apply / revert — one verified STAGED field write, never a publish   */
/* ------------------------------------------------------------------ */

describe("apply", () => {
  it("PATCHes exactly one page field after a pre-write site check, verifies the echo, and never touches the LIVE site", async () => {
    const { adapter, fake } = makeAdapter();
    const after = "San Diego Homes for Sale | GG Realty";
    await adapter.apply(seoTitleWrite(after));

    // Pre-write pin verification (GET) then the write (PATCH) — nothing else.
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET https://api.webflow.com/v2/pages/${PAGE_ID}`,
      `PATCH https://api.webflow.com/v2/pages/${PAGE_ID}`,
    ]);
    // Exactly one field in the update body — never a broader entity write.
    expect(JSON.parse(fake.requests[1].body ?? "")).toEqual({
      seo: { title: after },
    });
    // STAGED updated; untouched siblings stay untouched.
    expect(fake.page(PAGE_ID).seo.title).toBe(after);
    expect(fake.page(PAGE_ID).seo.description).toBe(ORIGINAL_SEO_DESC);
    // STAGED-vs-PUBLISHED fidelity: the live site is byte-identical, and no
    // publish/live endpoint was ever called.
    expect(fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expectNoPublishTraffic(fake);
  });

  it("writes a CMS item field (schema JSON-LD) under the single fieldData key", async () => {
    const { adapter, fake } = makeAdapter();
    const jsonLd: Json = { "@context": "https://schema.org", "@type": "FAQPage" };
    await adapter.apply({
      target: {
        url: PAGE_URL,
        locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "faq-schema"),
      },
      before: FAQ_SCHEMA,
      after: jsonLd,
      ctx: CTX,
    });
    const patch = fake.requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toBe(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${ITEM_ID}`,
    );
    expect(JSON.parse(patch?.body ?? "")).toEqual({
      fieldData: { "faq-schema": jsonLd },
    });
    expect(fake.item(COLLECTION_ID, ITEM_ID)["faq-schema"]).toEqual(jsonLd);
    // Untouched siblings + the live item stay untouched.
    expect(fake.item(COLLECTION_ID, ITEM_ID).summary).toBe(ORIGINAL_SUMMARY);
    expect(fake.liveItem(COLLECTION_ID, ITEM_ID)["faq-schema"]).toEqual(FAQ_SCHEMA);
    expectNoPublishTraffic(fake);
  });

  it("reports write_verification_failed when the site stores a normalized value (server-side rewriting)", async () => {
    const { adapter, fake } = makeAdapter();
    // Simulate server-side normalization (whitespace collapsing, the same
    // class as slug normalization — which the grammar refuses outright).
    fake.mutateWrites((v) => v.replace(/\s+/g, " ").trim());
    const error = await expectFailure(
      adapter.apply(summaryWrite("A  double-spaced   summary ")),
      "write_verification_failed",
    );
    expect(error.message).toContain("stored a different value");
  });

  it("refuses a mirrored og write PRE-WRITE — the PATCH is never sent", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: webflowLocators.pageOgTitle(MIRRORED_PAGE_ID),
        },
        before: "About GG Realty",
        after: "New OG Title",
        ctx: CTX,
      }),
      "unsupported_operation",
    );
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("rejects a non-restorable BEFORE pre-network — rollback impossibility never reaches the site", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(adapter.apply(seoTitleWrite("New", null)), "invalid_value");
    await expectFailure(adapter.apply(seoTitleWrite(null)), "invalid_value");
    await expectFailure(adapter.apply(summaryWrite(null)), "invalid_value");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects unsupported operations pre-network (item slug field, page name, publish)", async () => {
    const { adapter, fake } = makeAdapter();
    for (const locator of [
      webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "slug"),
      `webflow:page/${PAGE_ID}/title`,
      `webflow:site/${SITE_ID}/publish`,
    ]) {
      await expectFailure(
        adapter.apply({
          target: { url: PAGE_URL, locator },
          before: "old",
          after: "new",
          ctx: CTX,
        }),
        "unsupported_operation",
      );
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("revert", () => {
  it("restores the captured before-state byte-exact through the same surface — live site still untouched", async () => {
    const { adapter, fake } = makeAdapter();
    const write = seoTitleWrite("San Diego Homes for Sale | GG Realty");
    await adapter.apply(write);
    expect(fake.page(PAGE_ID).seo.title).toBe(write.after);

    await adapter.revert(write);
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(patches[1].body ?? "")).toEqual({
      seo: { title: ORIGINAL_SEO_TITLE },
    });
    expect(fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expectNoPublishTraffic(fake);
  });

  it("fails loudly (write_verification_failed) when the restore would not be byte-exact — the row must stay applied", async () => {
    const { adapter, fake } = makeAdapter();
    const write = summaryWrite("New summary", "Old  summary with  odd spacing");
    // The restore direction hits server-side normalization: the stored value
    // would differ from the captured before-state.
    fake.mutateWrites((v) => v.replace(/\s+/g, " "));
    await expectFailure(adapter.revert(write), "write_verification_failed");
  });
});

/* ------------------------------------------------------------------ */
/* Failure honesty — the typed error contract                          */
/* ------------------------------------------------------------------ */

describe("failure modes", () => {
  const readTitle = (adapter: WebflowAdapter) =>
    adapter.readCurrent(
      { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
      CTX,
    );

  it("401 → credential_rejected (rotated/revoked token), with the vendor slug", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rotateToken("wf-pat-rotated-away");
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(401);
    expect(error.vendorCode).toBe("unauthorized");
    expect(error.message).toContain("reconnect the property");
  });

  it("403 → credential_rejected (missing scopes, not identity)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.failNextWith(403, "missing_scopes");
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(403);
    expect(error.vendorCode).toBe("missing_scopes");
  });

  it("404 → target_missing (deleted since the audit)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.removePage(PAGE_ID);
    const error = await expectFailure(readTitle(adapter), "target_missing");
    expect(error.httpStatus).toBe(404);
    expect(error.vendorCode).toBe("resource_not_found");
  });

  it("HTML instead of JSON (a CDN/WAF interstitial) → unexpected_response, named honestly, body never echoed", async () => {
    const { adapter, fake } = makeAdapter();
    fake.simulateHtmlInterstitial();
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("New")),
      "unexpected_response",
    );
    expect(error.message).toContain("HTML page instead of an API response");
    // The interstitial's markup/content never leaks into the message.
    expect(error.message).not.toContain("<html");
    expect(error.message).not.toContain("Checking your browser");
    expect(error.message).not.toContain("Just a moment");
  });

  it("non-JSON garbage → unexpected_response without echoing the body", async () => {
    const scripted = new ScriptedFetch().on("*", /./, () =>
      textResponse(200, "PROXY ERROR :: upstream sadness"),
    );
    const { adapter } = makeAdapter({ fetch: scripted.port });
    const error = await expectFailure(readTitle(adapter), "unexpected_response");
    expect(error.message).toContain("not valid JSON");
    expect(error.message).not.toContain("upstream sadness");
  });

  it("5xx with an error envelope → vendor_failure carrying status + sanitized slug only, site untouched", async () => {
    const { adapter, fake } = makeAdapter();
    fake.failNextWriteWith(500, "internal_error");
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("New")),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(500);
    expect(error.vendorCode).toBe("internal_error");
    // The envelope's free-text message is NOT trusted into ours.
    expect(error.message).not.toContain("The request failed");
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
  });

  it("400 validation (a field the collection does not declare) → vendor_failure, no state change", async () => {
    const { adapter, fake } = makeAdapter();
    // Bypass the read path's absence check by scripting a direct write: the
    // membership check passes, the PATCH itself is rejected by validation.
    const error = await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "not-a-field"),
        },
        before: "old",
        after: "new",
        ctx: CTX,
      }),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(400);
    expect(error.vendorCode).toBe("validation_error");
    expect(fake.item(COLLECTION_ID, ITEM_ID)).not.toHaveProperty("not-a-field");
  });

  it("transport failure → network_failure naming the pinned host, detail whitelisted", async () => {
    const { adapter, fake } = makeAdapter();
    fake.http.failNext(
      Object.assign(
        new Error("connect ECONNREFUSED 10.0.0.5:443 via corp-proxy (auth=hunter2)"),
        { code: "ECONNREFUSED" },
      ),
    );
    const error = await expectFailure(readTitle(adapter), "network_failure");
    expect(error.message).toContain("https://api.webflow.com");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("10.0.0.5");
  });
});

/* ------------------------------------------------------------------ */
/* 429 — honest rate-limit mapping (nothing retries automatically)     */
/* ------------------------------------------------------------------ */

describe("rate limiting", () => {
  const readTitle = (adapter: WebflowAdapter) =>
    adapter.readCurrent(
      { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
      CTX,
    );

  it("429 → rate_limited with the whitelisted Retry-After and retryable interface-voice semantics", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rateLimitNext(30);
    const error = await expectFailure(readTitle(adapter), "rate_limited");
    expect(error.httpStatus).toBe(429);
    expect(error.vendorCode).toBe("too_many_requests");
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toContain("NOT performed");
    expect(error.message).toContain("~30s");
    expect(error.message).toContain("nothing retries automatically");
  });

  it("a garbage Retry-After header is dropped, never echoed", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rateLimitNext("later maybe 10; see https://evil.example");
    const error = await expectFailure(readTitle(adapter), "rate_limited");
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).not.toContain("later maybe");
    expect(error.message).not.toContain("evil.example");
    expect(error.message).toContain("shortly");
  });

  it("a rate-limited apply performs NOTHING — no write reached the site", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rateLimitNext(60);
    await expectFailure(adapter.apply(seoTitleWrite("New")), "rate_limited");
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
  });
});

/* ------------------------------------------------------------------ */
/* Multi-tenant discipline — pinned property + pinned site + pinned host */
/* ------------------------------------------------------------------ */

describe("site pinning", () => {
  const foreignContexts: Array<[string, AdapterContext]> = [
    ["another tenant", { ...CTX, tenantId: "t2" }],
    ["another client", { ...CTX, clientId: "c2" }],
    ["another property", { ...CTX, propertyId: "prop-2" }],
  ];

  it.each(foreignContexts)(
    "refuses a context for %s pre-network (property_mismatch)",
    async (_label, ctx) => {
      const { adapter, fake } = makeAdapter();
      await expectFailure(
        adapter.readCurrent(
          { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
          ctx,
        ),
        "property_mismatch",
      );
      await expectFailure(
        adapter.apply({ ...seoTitleWrite("New"), ctx }),
        "property_mismatch",
      );
      await expectFailure(
        adapter.revert({ ...seoTitleWrite("New"), ctx }),
        "property_mismatch",
      );
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("refuses a page belonging to ANOTHER Webflow site (cross_site_target) — on read, and pre-write on apply", async () => {
    const { adapter, fake } = makeAdapter();
    const target = {
      url: PAGE_URL,
      locator: webflowLocators.pageSeoTitle(FOREIGN_PAGE_ID),
    };
    await expectFailure(adapter.readCurrent(target, CTX), "cross_site_target");
    await expectFailure(
      adapter.apply({ target, before: "Not ours", after: "Ours now", ctx: CTX }),
      "cross_site_target",
    );
    // The pre-write pin check refused BEFORE any PATCH left.
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    // And the foreign page is untouched.
    expect(fake.page(FOREIGN_PAGE_ID).seo.title).toBe("Not ours");
  });

  it("refuses a collection that is not in the PINNED site's own list — the foreign collection is never even requested", async () => {
    const { adapter, fake } = makeAdapter();
    const target = {
      url: PAGE_URL,
      locator: webflowLocators.itemField(
        FOREIGN_COLLECTION_ID,
        FOREIGN_ITEM_ID,
        "summary",
      ),
    };
    await expectFailure(adapter.readCurrent(target, CTX), "cross_site_target");
    await expectFailure(
      adapter.apply({ target, before: "a", after: "b", ctx: CTX }),
      "cross_site_target",
    );
    // Membership was checked against the PINNED site's list only; no request
    // ever named the foreign collection or item.
    for (const req of fake.requests) {
      expect(req.url).toBe(
        `https://api.webflow.com/v2/sites/${SITE_ID}/collections`,
      );
    }
    expect(fake.item(FOREIGN_COLLECTION_ID, FOREIGN_ITEM_ID).summary).toBe(
      "another client's item",
    );
  });

  it("refuses a userinfo-bearing target URL pre-network WITHOUT echoing it", async () => {
    const { adapter, fake } = makeAdapter();
    const url = "https://wf-admin:sekrit-target@ggrealty.example/listings";
    const error = await expectFailure(
      adapter.apply({
        ...seoTitleWrite("New"),
        target: { url, locator: webflowLocators.pageSeoTitle(PAGE_ID) },
      }),
      "unsupported_operation",
    );
    expect(error.message).toContain("embeds credentials");
    expect(error.message).not.toContain("sekrit-target");
    expect(error.message).not.toContain("wf-admin");
    await expectFailure(
      adapter.readCurrent(
        { url, locator: webflowLocators.pageSeoTitle(PAGE_ID) },
        CTX,
      ),
      "unsupported_operation",
    );
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an UNPARSEABLE target URL without echoing it (a malformed URL can embed credentials)", async () => {
    const { adapter, fake } = makeAdapter();
    const url = "http://u:sekrit-url@"; // absolute scheme, empty host → unparseable
    const error = await expectFailure(
      adapter.readCurrent(
        { url, locator: webflowLocators.pageSeoTitle(PAGE_ID) },
        CTX,
      ),
      "unsupported_operation",
    );
    expect(error.message).toContain("not parseable");
    expect(error.message).not.toContain("sekrit-url");
    expect(fake.requests).toHaveLength(0);
  });

  it("pins the API host outright: any custom base URL that is not https://api.webflow.com is refused at construction, never echoed", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    const build = (apiBaseUrl?: string) =>
      new WebflowAdapter({
        site: SITE,
        secrets: resolver,
        authRef: "vault://webflow/prop-1",
        fetch: fake.port,
        apiBaseUrl,
      });
    // The only legal values.
    expect(() => build()).not.toThrow();
    expect(() => build("https://api.webflow.com")).not.toThrow();
    expect(() => build("https://api.webflow.com/")).not.toThrow();
    // Everything else is refused — including the SSRF/cleartext classes.
    for (const bad of [
      "https://evil.example",
      "http://api.webflow.com", // cleartext — the token would egress unencrypted
      "https://api.webflow.com:8443",
      "https://api.webflow.com/v2", // paths are the adapter's business, not config
      "https://api.webflow.com.evil.example",
      "https://user:sekrit-base@api.webflow.com",
      "not a url",
    ]) {
      let thrown: unknown;
      try {
        build(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      const error = thrown as WriteMethodError;
      expect(error.code).toBe("misconfigured");
      // The rejected value is NEVER echoed (it can carry a credential).
      expect(error.message).not.toContain(bad);
      expect(error.message).not.toContain("sekrit-base");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an unusable Webflow site id at construction without echoing it", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    for (const bad of [SITE_ID.toUpperCase(), SITE_ID.slice(0, 23), "not-a-site-id"]) {
      let thrown: unknown;
      try {
        new WebflowAdapter({
          site: { ...SITE, siteId: bad },
          secrets: resolver,
          authRef: "vault://webflow/prop-1",
          fetch: fake.port,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      const error = thrown as WriteMethodError;
      expect(error.code).toBe("misconfigured");
      expect(error.message).not.toContain(bad);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Credential containment (doc 04 §5 + the 1.2 leak-check discipline)  */
/* ------------------------------------------------------------------ */

describe("credential containment", () => {
  it("the token's ONLY egress is the Bearer Authorization header of requests to the pinned host", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(seoTitleWrite("New Title"));
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const req of fake.requests) {
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(req.url).not.toContain(SECRET);
      expect(req.url).not.toContain(SECRET_B64);
      expect(req.body ?? "").not.toContain(SECRET);
      expect(req.body ?? "").not.toContain(SECRET_B64);
    }
  });

  it("no failure-mode error carries the token (raw or encoded) on any surface", async () => {
    const errors: WriteMethodError[] = [];

    // 401 while the real token is resolved (site rotated it away).
    const { adapter: a401, fake: fake401 } = makeAdapter();
    fake401.rotateToken("someone-elses-token");
    errors.push(
      await expectFailure(
        a401.readCurrent(
          { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
          CTX,
        ),
        "credential_rejected",
      ),
    );

    // HTML interstitial, rate limit, vendor failure, network failure.
    const { adapter: aHtml, fake: fakeHtml } = makeAdapter();
    fakeHtml.simulateHtmlInterstitial();
    errors.push(
      await expectFailure(aHtml.apply(seoTitleWrite("N")), "unexpected_response"),
    );
    const { adapter: aRate, fake: fakeRate } = makeAdapter();
    fakeRate.rateLimitNext(10);
    errors.push(await expectFailure(aRate.apply(seoTitleWrite("N")), "rate_limited"));
    const { adapter: aVendor, fake: fakeVendor } = makeAdapter();
    fakeVendor.failNextWriteWith(502, "bad_gateway");
    errors.push(
      await expectFailure(aVendor.apply(seoTitleWrite("N")), "vendor_failure"),
    );
    const { adapter: aNet, fake: fakeNet } = makeAdapter();
    fakeNet.http.failNext();
    errors.push(
      await expectFailure(
        aNet.readCurrent(
          { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
          CTX,
        ),
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
    await adapter.readCurrent(
      { url: PAGE_URL, locator: `webflow:page/${PAGE_ID}/seo.title` },
      CTX,
    );
  });
});
