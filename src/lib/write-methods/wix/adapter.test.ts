/**
 * WixAdapter unit suite — mocked HTTP only (the FetchPort is injected;
 * no test touches a network).
 *
 * Proves the adapter-level safety contract:
 *  - reads capture the byte-exact LIVE field; writes install exactly one
 *    field and verify the site stored it byte-exact — on the Wix Data
 *    full-replace surface the verification ALSO covers every sibling field
 *    the write re-carried, and on the page-SEO surface the NON-TARGET
 *    seoData attribute, so every divergence VISIBLE at the write's echo
 *    fails loudly (server normalization, replace-semantics surprises, edits
 *    that landed before the fresh read);
 *  - the one divergence NOT visible at any echo — a concurrent edit landing
 *    inside the data write's GET→PUT window — is silently overwritten (Wix
 *    Data v2 has no conditional/partial update; last-writer-wins) and is
 *    pinned below as the ACCEPTED RESIDUAL (gate-dispositioned: Orchestrator
 *    + Code Review, 2026-07-09);
 *  - every failure mode maps to the typed WriteMethodError contract with
 *    interface-voice messages (401/403, 404, 429 + Retry-After whitelisting,
 *    the HTML-interstitial classic, non-JSON, 5xx, network);
 *  - plan-time rejection: unsupported operations (system fields, app
 *    collections), non-restorable values, unset-inherits page fields, and
 *    absent/explicitly-null data fields never reach a write;
 *  - multi-tenant discipline: the adapter is pinned to one property AND one
 *    Wix site — mismatched contexts are refused pre-network, and the pinned
 *    `wix-site-id` header (never anything derived from a target) scopes every
 *    request, so the pin IS the isolation boundary; the API host itself is
 *    pinned outright;
 *  - credentials: resolved per call from the vault seam, egress ONLY via the
 *    bare Authorization header (no Basic/Bearer scheme), leak through no
 *    error/log/serialization surface (the 1.2 leak-check discipline).
 */

import util from "node:util";
import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  steppingClock,
  type AdapterContext,
  type AdapterWrite,
  type TenantContext,
} from "@/lib/change-management";
import {
  VendorCredential,
  type ConnectorScope,
  type SecretsResolver,
} from "@/lib/connectors";
import type { Json } from "@/lib/types/db";
import { WriteMethodError, type WriteMethodErrorCode } from "../shared/errors";
import { jsonResponse, ScriptedFetch, textResponse } from "../shared/http-harness";
import { WixAdapter, type WixAdapterConfig } from "./adapter";
import { FakeWix } from "./fake-wix";
import { wixLocators } from "./target";

const SECRET = "IST.wix-api-key.4bCdEfGh.5ecretT0ken";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const SITE_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const OTHER_SITE_ID = "ffffffff-0000-1111-2222-333344445555";
const PAGE_ID = "c1dmp";
const UNSET_PAGE_ID = "about1";
const COLLECTION_ID = "Listings";
const ITEM_ID = "8d2e1f0a-3b68-4f07-9aa4-b5c8d2e1f0a3";
const NULL_FIELD_ITEM_ID = "9e3f2a1b-4c79-4a18-8bb5-c6d9e3f2a1b4";

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
  return new FakeWix({
    apiKey: SECRET,
    siteId: SITE_ID,
    pages: {
      [PAGE_ID]: {
        name: "Listings",
        seoData: { title: ORIGINAL_SEO_TITLE, description: ORIGINAL_SEO_DESC },
      },
      [UNSET_PAGE_ID]: {
        name: "About",
        // description omitted → UNSET: the page inherits the site's SEO
        // pattern for it (the derived-value state the adapter must refuse).
        seoData: { title: "About GG Realty" },
      },
    },
    collections: {
      [COLLECTION_ID]: {
        items: {
          [ITEM_ID]: {
            name: "Casa Uno",
            summary: ORIGINAL_SUMMARY,
            faqSchema: FAQ_SCHEMA,
            beds: 3,
          },
          // An EXPLICITLY-null field — distinct from absent on Wix Data, but
          // indistinguishable in the persisted diff, so it must be refused.
          [NULL_FIELD_ITEM_ID]: { name: "Casa Dos", agentNote: null },
        },
      },
    },
  });
}

function makeAdapter(overrides: Partial<WixAdapterConfig> = {}) {
  const fake = makeFake();
  const resolver = makeResolver();
  const adapter = new WixAdapter({
    site: SITE,
    secrets: resolver,
    authRef: "vault://wix/prop-1",
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
    target: { url: PAGE_URL, locator: wixLocators.pageSeoTitle(PAGE_ID) },
    before,
    after,
    ctx: CTX,
  };
}

function summaryWrite(after: Json, before: Json = ORIGINAL_SUMMARY): AdapterWrite {
  return {
    target: {
      url: PAGE_URL,
      locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "summary"),
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
  expect(error.method).toBe("wix");
  return error;
}

/* ------------------------------------------------------------------ */
/* readCurrent — byte-exact LIVE capture                               */
/* ------------------------------------------------------------------ */

describe("readCurrent", () => {
  it("reads the live seo.title from the pinned host with vault-resolved BARE-key auth + the pinned wix-site-id header", async () => {
    const { adapter, fake, resolver } = makeAdapter();
    const value = await adapter.readCurrent(
      { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
      CTX,
    );
    expect(value).toBe(ORIGINAL_SEO_TITLE);

    // Exactly one request, to the pinned API host, site-scoped, no-redirect.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe("GET");
    expect(fake.requests[0].url).toBe(
      `https://www.wixapis.com/site-pages/v1/pages/${PAGE_ID}`,
    );
    // Wix API keys are sent BARE — no Basic/Bearer scheme.
    expect(fake.requests[0].headers.authorization).toBe(SECRET);
    expect(fake.requests[0].headers["wix-site-id"]).toBe(SITE_ID);
    expect(fake.requests[0].redirect).toBe("error");
    // The vault seam was hit at call time, tenant-scoped.
    expect(resolver.calls).toEqual([
      {
        authRef: "vault://wix/prop-1",
        scope: { tenantId: "t1", clientId: "c1" },
      },
    ]);
  });

  it("reads data-item fields of any JSON shape via the collection-scoped item route", async () => {
    const { adapter, fake } = makeAdapter();
    await expect(
      adapter.readCurrent(summaryWrite("x").target, CTX),
    ).resolves.toBe(ORIGINAL_SUMMARY);
    expect(fake.requests[0].url).toBe(
      `https://www.wixapis.com/wix-data/v2/items/${ITEM_ID}?dataCollectionId=${COLLECTION_ID}`,
    );
    await expect(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "faqSchema"),
        },
        CTX,
      ),
    ).resolves.toEqual(FAQ_SCHEMA);
    await expect(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "beds"),
        },
        CTX,
      ),
    ).resolves.toBe(3);
  });

  it("refuses an UNSET page field — its value derives from the site's SEO pattern and could never be restored", async () => {
    const { adapter, fake } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: `wix:page/${UNSET_PAGE_ID}/seo.description`,
        },
        CTX,
      ),
      "invalid_value",
    );
    expect(error.message).toContain("inherits the site's SEO pattern");
    expect(fake.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("refuses an absent data field as target_missing (no such field, or never valued)", async () => {
    const { adapter, fake } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "floorPlan"),
        },
        CTX,
      ),
      "target_missing",
    );
    expect(error.message).toContain("floorPlan");
    expect(error.message).toContain("unset");
    expect(fake.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("refuses an EXPLICITLY-null data field — indistinguishable from absent in the persisted diff, so unverifiable", async () => {
    const { adapter } = makeAdapter();
    const error = await expectFailure(
      adapter.readCurrent(
        {
          url: PAGE_URL,
          locator: wixLocators.dataField(
            COLLECTION_ID,
            NULL_FIELD_ITEM_ID,
            "agentNote",
          ),
        },
        CTX,
      ),
      "invalid_value",
    );
    expect(error.message).toContain("null");
    expect(error.message).toContain("refused before any write");
  });
});

/* ------------------------------------------------------------------ */
/* apply / revert — one verified LIVE field write                      */
/* ------------------------------------------------------------------ */

describe("apply", () => {
  it("PATCHes exactly one page SEO key after a fresh pre-write read, and verifies the echo byte-exact", async () => {
    const { adapter, fake } = makeAdapter();
    const after = "San Diego Homes for Sale | GG Realty";
    await adapter.apply(seoTitleWrite(after));

    // Pre-write live-state read (GET) then the write (PATCH) — nothing else.
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET https://www.wixapis.com/site-pages/v1/pages/${PAGE_ID}`,
      `PATCH https://www.wixapis.com/site-pages/v1/pages/${PAGE_ID}`,
    ]);
    // Exactly one key in the merge-PATCH — never a broader page write.
    expect(JSON.parse(fake.requests[1].body ?? "")).toEqual({
      page: { seoData: { title: after } },
    });
    // LIVE-IMMEDIATE: the accepted write IS the live site; the untouched
    // sibling stays untouched.
    expect(fake.page(PAGE_ID).seoData.title).toBe(after);
    expect(fake.page(PAGE_ID).seoData.description).toBe(ORIGINAL_SEO_DESC);
  });

  it("writes a data field via the full-replace PUT: system fields stripped from the body, every sibling re-carried byte-exact", async () => {
    const { adapter, fake } = makeAdapter();
    const before = fake.itemSystem(COLLECTION_ID, ITEM_ID);
    const jsonLd: Json = { "@context": "https://schema.org", "@type": "FAQPage" };
    await adapter.apply({
      target: {
        url: PAGE_URL,
        locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "faqSchema"),
      },
      before: FAQ_SCHEMA,
      after: jsonLd,
      ctx: CTX,
    });

    const put = fake.requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe(`https://www.wixapis.com/wix-data/v2/items/${ITEM_ID}`);
    const body = JSON.parse(put?.body ?? "") as {
      dataCollectionId: string;
      dataItem: { data: Record<string, Json> };
    };
    expect(body.dataCollectionId).toBe(COLLECTION_ID);
    // The full-replace body carries the fresh-read siblings + the one swapped
    // field — and NO server-managed system fields.
    expect(body.dataItem.data).toEqual({
      name: "Casa Uno",
      summary: ORIGINAL_SUMMARY,
      faqSchema: jsonLd,
      beds: 3,
    });
    expect(Object.keys(body.dataItem.data).some((k) => k.startsWith("_"))).toBe(
      false,
    );
    // Stored: target updated, siblings byte-identical.
    expect(fake.item(COLLECTION_ID, ITEM_ID)).toEqual({
      name: "Casa Uno",
      summary: ORIGINAL_SUMMARY,
      faqSchema: jsonLd,
      beds: 3,
    });
    // The server-managed _updatedDate advanced — and the write still verified
    // (system fields are excluded from verification by design).
    expect(fake.itemSystem(COLLECTION_ID, ITEM_ID)._updatedDate).not.toBe(
      before._updatedDate,
    );
  });

  it("reports write_verification_failed when the site stores a normalized value (server-side rewriting)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.mutateWrites((v) => v.replace(/\s+/g, " ").trim());
    const error = await expectFailure(
      adapter.apply(summaryWrite("A  double-spaced   summary ")),
      "write_verification_failed",
    );
    expect(error.message).toContain("stored a different value");
    expect(error.message).toContain("LIVE");
  });

  it("reports write_verification_failed when a SIBLING the full-replace re-carried comes back altered — a side effect is never silent", async () => {
    const { adapter, fake } = makeAdapter();
    // The target is a NUMBER (unmutated); the string siblings hit server-side
    // normalization when stored. The target echo matches byte-exact — only
    // the sibling verification can catch that this write altered data it was
    // never approved to change.
    fake.mutateWrites((v) => v.toUpperCase());
    const error = await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "beds"),
        },
        before: 3,
        after: 4,
        ctx: CTX,
      }),
      "write_verification_failed",
    );
    expect(error.message).toContain("OTHER fields");
    expect(error.message).toContain("not approved to change");
  });

  it("rejects a non-restorable BEFORE pre-network — rollback impossibility never reaches the site", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(adapter.apply(seoTitleWrite("New", null)), "invalid_value");
    await expectFailure(adapter.apply(seoTitleWrite(null)), "invalid_value");
    await expectFailure(adapter.apply(summaryWrite(null)), "invalid_value");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects unsupported operations pre-network (system field, app collection, page rename)", async () => {
    const { adapter, fake } = makeAdapter();
    for (const locator of [
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_owner`,
      `wix:data/Stores/Products/${ITEM_ID}/field/price`,
      `wix:page/${PAGE_ID}/name`,
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

  it("refuses to install a FIRST-EVER value on an unset page field pre-write — the PATCH is never sent", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: wixLocators.pageSeoDescription(UNSET_PAGE_ID),
        },
        before: "A description the crawl thought it saw",
        after: "New description",
        ctx: CTX,
      }),
      "invalid_value",
    );
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    // The unset field stayed unset.
    expect(fake.page(UNSET_PAGE_ID).seoData.description).toBeUndefined();
  });

  it("refuses to write an ABSENT data field pre-write — the PUT is never sent (defense in depth under the pipeline's own gate)", async () => {
    const { adapter, fake } = makeAdapter();
    await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "floorPlan"),
        },
        before: "old",
        after: "new",
        ctx: CTX,
      }),
      "target_missing",
    );
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(fake.item(COLLECTION_ID, ITEM_ID)).not.toHaveProperty("floorPlan");
  });
});

describe("revert", () => {
  it("restores the captured before-state byte-exact through the same surface", async () => {
    const { adapter, fake } = makeAdapter();
    const write = seoTitleWrite("San Diego Homes for Sale | GG Realty");
    await adapter.apply(write);
    expect(fake.page(PAGE_ID).seoData.title).toBe(write.after);

    await adapter.revert(write);
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(patches[1].body ?? "")).toEqual({
      page: { seoData: { title: ORIGINAL_SEO_TITLE } },
    });
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
/* Page-SEO non-target verification — the merge-semantics guard        */
/* ------------------------------------------------------------------ */

describe("page-SEO non-target verification (merge-semantics guard)", () => {
  it("under MERGE semantics (the modeled, assumed behavior — first-live-write canary) a single-key write passes with an UNSET sibling staying unset", async () => {
    const { adapter, fake } = makeAdapter();
    // The set-sibling merge case is proven by the apply suite above; this is
    // the UNSET case — the About page's description is unset (inherits the
    // site's SEO pattern) and must still be unset in the echo.
    await adapter.apply({
      target: {
        url: PAGE_URL,
        locator: wixLocators.pageSeoTitle(UNSET_PAGE_ID),
      },
      before: "About GG Realty",
      after: "About GG Realty | San Diego",
      ctx: CTX,
    });
    expect(fake.page(UNSET_PAGE_ID).seoData.title).toBe(
      "About GG Realty | San Diego",
    );
    expect(fake.page(UNSET_PAGE_ID).seoData.description).toBeUndefined();
  });

  it("under REPLACE semantics a single-key title write WIPES the description — write_verification_failed, never a silent success (apply direction)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.simulateSeoDataReplaceSemantics();
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("New Title")),
      "write_verification_failed",
    );
    expect(error.message).toContain("seo.description");
    expect(error.message).toContain("not approved to change");
    // The loss is REAL on the live site — which is exactly why the failure
    // must be loud instead of a recorded success the operator would trust.
    expect(fake.page(PAGE_ID).seoData.description).toBeUndefined();
  });

  it("the guard covers the REVERT direction too — a restore that wipes the sibling is reported, never a false 'reverted'", async () => {
    const { adapter, fake } = makeAdapter();
    const write = seoTitleWrite("New Title");
    await adapter.apply(write);
    expect(fake.page(PAGE_ID).seoData.description).toBe(ORIGINAL_SEO_DESC);
    // The vendor's PATCH semantics change under us between apply and revert
    // (the canary counterfactual).
    fake.simulateSeoDataReplaceSemantics();
    const error = await expectFailure(
      adapter.revert(write),
      "write_verification_failed",
    );
    expect(error.message).toContain("seo.description");
    expect(fake.page(PAGE_ID).seoData.description).toBeUndefined();
  });

  it("an UNSET sibling must STAY unset: an echo materializing it as empty string fails (unset≠empty — Wix renders them differently)", async () => {
    // ScriptedFetch, not FakeWix: the GET shows the description UNSET; the
    // PATCH echo materializes it as "" — a server that "helpfully" fills a
    // wiped key with an empty string must still be caught, because unset
    // inherits the site's SEO pattern and empty does not.
    const scripted = new ScriptedFetch()
      .on("GET", /site-pages/, () =>
        jsonResponse(200, {
          page: {
            id: UNSET_PAGE_ID,
            name: "About",
            seoData: { title: "About GG Realty" },
          },
        }),
      )
      .on("PATCH", /site-pages/, () =>
        jsonResponse(200, {
          page: {
            id: UNSET_PAGE_ID,
            name: "About",
            seoData: { title: "About | GG", description: "" },
          },
        }),
      );
    const { adapter } = makeAdapter({ fetch: scripted.port });
    const error = await expectFailure(
      adapter.apply({
        target: {
          url: PAGE_URL,
          locator: wixLocators.pageSeoTitle(UNSET_PAGE_ID),
        },
        before: "About GG Realty",
        after: "About | GG",
        ctx: CTX,
      }),
      "write_verification_failed",
    );
    expect(error.message).toContain("seo.description");
  });
});

/* ------------------------------------------------------------------ */
/* The data-write GET→PUT concurrent-edit window — ACCEPTED RESIDUAL   */
/* (gate-dispositioned: Orchestrator + Code Review, 2026-07-09)        */
/* ------------------------------------------------------------------ */

describe("data-write GET→PUT concurrent-edit window — ACCEPTED RESIDUAL (gate-dispositioned)", () => {
  it("ACCEPTED RESIDUAL (gate-dispositioned 2026-07-09): an edit landing INSIDE the GET→PUT window is silently overwritten — the pipeline records 'applied' with NO warning", async () => {
    // This test PINS the accepted residual; it does not defend a fix. Wix
    // Data v2's update is last-writer-wins full replace (no revision field,
    // no conditional or partial update), so an edit landing between the
    // adapter's fresh pre-write GET and its PUT is overwritten with the
    // re-carried pre-edit values, the echo matches what we sent byte-exact,
    // and NOTHING can flag it. Boundary cases, both proven elsewhere in this
    // file: an edit landing BEFORE the fresh read IS re-carried intact (the
    // next test), and a divergence the server introduces IS caught at the
    // echo (the sibling-normalization test in the apply suite). If this test
    // ever fails, the residual has changed shape — re-open the disposition.
    const { adapter, fake } = makeAdapter();
    const clock = steppingClock("2026-07-09T12:00:00.000Z");
    const store = new InMemoryChangeStore({ clock });
    const manager = new ChangeManager({
      store,
      adapters: new MapAdapterRegistry([adapter]),
      clock,
    });
    const tenantCtx: TenantContext = {
      tenantId: "t1",
      actor: { id: "user-op", role: "operator" },
    };

    const preview = await manager.preview(
      {
        tenantId: "t1",
        clientId: "c1",
        propertyId: "prop-1",
        method: "wix",
        changeType: "content",
        target: {
          url: PAGE_URL,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "summary"),
        },
        before: ORIGINAL_SUMMARY,
        after: "New summary",
      },
      tenantCtx,
    );

    // The client-staff CMS edit lands at the exact instant the apply's PUT
    // arrives: AFTER the adapter's fresh pre-write GET (which re-carried the
    // pre-edit name), BEFORE the full replace processes.
    fake.editDataItemOnNextPut(COLLECTION_ID, ITEM_ID, {
      name: "Casa Uno — staff renamed mid-write",
    });

    const outcome = await manager.apply(
      preview.change.id,
      { approvedBy: "user-admin" },
      tenantCtx,
    );

    // The pipeline saw NOTHING: applied, zero warnings, clean verified write.
    expect(outcome.change.status).toBe("applied");
    expect(outcome.warnings).toEqual([]);
    // And the staff rename is GONE — overwritten with the re-carried
    // pre-edit value. This is the operator-facing consequence the adapter
    // header documents: a CMS edit made in the same instant as an auto-fix
    // apply or rollback on the same item can be lost, silently.
    expect(fake.item(COLLECTION_ID, ITEM_ID).name).toBe("Casa Uno");
    expect(fake.item(COLLECTION_ID, ITEM_ID).summary).toBe("New summary");
  });

  it("boundary (NOT the residual): an edit landing BEFORE the fresh read IS re-carried intact — only the in-window slice is exposed", async () => {
    const { adapter, fake } = makeAdapter();
    // The staff edit lands at rest, before our write begins.
    fake.editDataItem(COLLECTION_ID, ITEM_ID, {
      name: "Casa Uno — staff renamed",
    });
    await adapter.apply(summaryWrite("New summary"));
    // The fresh pre-write GET picked the rename up; the full-replace PUT
    // re-carried it byte-exact alongside the one approved field change.
    expect(fake.item(COLLECTION_ID, ITEM_ID).name).toBe(
      "Casa Uno — staff renamed",
    );
    expect(fake.item(COLLECTION_ID, ITEM_ID).summary).toBe("New summary");
  });
});

/* ------------------------------------------------------------------ */
/* Failure honesty — the typed error contract                          */
/* ------------------------------------------------------------------ */

describe("failure modes", () => {
  const readTitle = (adapter: WixAdapter) =>
    adapter.readCurrent(
      { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
      CTX,
    );

  it("401 → credential_rejected (rotated/revoked key), with the NESTED vendor slug sanitized out of the envelope", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rotateKey("IST.rotated-away");
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(401);
    expect(error.vendorCode).toBe("UNAUTHENTICATED");
    expect(error.message).toContain("reconnect the property");
  });

  it("403 → credential_rejected (missing permissions, not identity)", async () => {
    const { adapter, fake } = makeAdapter();
    fake.failNextWith(403, "PERMISSION_DENIED");
    const error = await expectFailure(readTitle(adapter), "credential_rejected");
    expect(error.httpStatus).toBe(403);
    expect(error.vendorCode).toBe("PERMISSION_DENIED");
  });

  it("404 → target_missing (deleted since the audit), scoped to the pinned site", async () => {
    const { adapter, fake } = makeAdapter();
    fake.removePage(PAGE_ID);
    const error = await expectFailure(readTitle(adapter), "target_missing");
    expect(error.httpStatus).toBe(404);
    expect(error.vendorCode).toBe("PAGE_NOT_FOUND");
    expect(error.message).toContain("connected Wix site");
  });

  it("HTML instead of JSON (a CDN/WAF interstitial) → unexpected_response, named honestly, body never echoed", async () => {
    const { adapter, fake } = makeAdapter();
    fake.simulateHtmlInterstitial();
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("New")),
      "unexpected_response",
    );
    expect(error.message).toContain("HTML page instead of an API response");
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
    fake.failNextWriteWith(500, "INTERNAL_ERROR");
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("New")),
      "vendor_failure",
    );
    expect(error.httpStatus).toBe(500);
    expect(error.vendorCode).toBe("INTERNAL_ERROR");
    // The envelope's free-text message is NOT trusted into ours.
    expect(error.message).not.toContain("The request failed");
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
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
    expect(error.message).toContain("https://www.wixapis.com");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("10.0.0.5");
  });
});

/* ------------------------------------------------------------------ */
/* 429 — honest rate-limit mapping (nothing retries automatically)     */
/* ------------------------------------------------------------------ */

describe("rate limiting", () => {
  const readTitle = (adapter: WixAdapter) =>
    adapter.readCurrent(
      { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
      CTX,
    );

  it("429 → rate_limited with the whitelisted Retry-After and retryable interface-voice semantics", async () => {
    const { adapter, fake } = makeAdapter();
    fake.rateLimitNext(30);
    const error = await expectFailure(readTitle(adapter), "rate_limited");
    expect(error.httpStatus).toBe(429);
    expect(error.vendorCode).toBe("RATE_LIMIT_EXCEEDED");
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
    expect(
      fake.requests.filter((r) => r.method === "PATCH" || r.method === "PUT"),
    ).toHaveLength(0);
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
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
          { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
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

  it("scopes EVERY request to the pinned site: the wix-site-id header always carries the construction pin — the locator has no site slot to override it", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(seoTitleWrite("New Title"));
    await adapter.apply(summaryWrite("New summary"));
    expect(fake.requests.length).toBeGreaterThanOrEqual(4);
    for (const req of fake.requests) {
      expect(req.headers["wix-site-id"]).toBe(SITE_ID);
    }
  });

  it("an adapter pinned to a DIFFERENT site cannot see this site's content — the pin (not the target) scopes the request, and the write never lands", async () => {
    // The account API key could reach every site in the account; the pin is
    // the isolation boundary. Pinning the adapter to another site id proves
    // the header travels from the pin: the fake's site is not visible inside
    // that scope, so the read/write fails honestly and nothing is written.
    const fake = makeFake();
    const resolver = makeResolver();
    const adapter = new WixAdapter({
      site: { ...SITE, siteId: OTHER_SITE_ID },
      secrets: resolver,
      authRef: "vault://wix/prop-1",
      fetch: fake.port,
    });
    const error = await expectFailure(
      adapter.apply(seoTitleWrite("Ours now")),
      "target_missing",
    );
    expect(error.vendorCode).toBe("SITE_NOT_FOUND");
    // The request that left carried the PIN, not anything target-derived.
    expect(fake.requests[0].headers["wix-site-id"]).toBe(OTHER_SITE_ID);
    expect(
      fake.requests.filter((r) => r.method === "PATCH" || r.method === "PUT"),
    ).toHaveLength(0);
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
  });

  it("refuses a userinfo-bearing target URL pre-network WITHOUT echoing it", async () => {
    const { adapter, fake } = makeAdapter();
    const url = "https://wix-admin:sekrit-target@ggrealty.example/listings";
    const error = await expectFailure(
      adapter.apply({
        ...seoTitleWrite("New"),
        target: { url, locator: wixLocators.pageSeoTitle(PAGE_ID) },
      }),
      "unsupported_operation",
    );
    expect(error.message).toContain("embeds credentials");
    expect(error.message).not.toContain("sekrit-target");
    expect(error.message).not.toContain("wix-admin");
    await expectFailure(
      adapter.readCurrent(
        { url, locator: wixLocators.pageSeoTitle(PAGE_ID) },
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
        { url, locator: wixLocators.pageSeoTitle(PAGE_ID) },
        CTX,
      ),
      "unsupported_operation",
    );
    expect(error.message).toContain("not parseable");
    expect(error.message).not.toContain("sekrit-url");
    expect(fake.requests).toHaveLength(0);
  });

  it("pins the API host outright: any custom base URL that is not https://www.wixapis.com is refused at construction, never echoed", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    const build = (apiBaseUrl?: string) =>
      new WixAdapter({
        site: SITE,
        secrets: resolver,
        authRef: "vault://wix/prop-1",
        fetch: fake.port,
        apiBaseUrl,
      });
    // The only legal values.
    expect(() => build()).not.toThrow();
    expect(() => build("https://www.wixapis.com")).not.toThrow();
    expect(() => build("https://www.wixapis.com/")).not.toThrow();
    // Everything else is refused — including the SSRF/cleartext classes and
    // the ?token=... echo class the shared helper exists for.
    for (const bad of [
      "https://evil.example",
      "http://www.wixapis.com", // cleartext — the key would egress unencrypted
      "https://www.wixapis.com:8443",
      "https://www.wixapis.com/wix-data", // paths are the adapter's business
      "https://www.wixapis.com.evil.example",
      "https://wixapis.com", // apex is not the API host
      "https://user:sekrit-base@www.wixapis.com",
      "https://www.wixapis.com/?token=sekrit-base",
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
      // The rejected value is NEVER echoed (it can carry a credential) — and
      // the shared helper says why, in one voice.
      expect(error.message).not.toContain(bad);
      expect(error.message).not.toContain("sekrit-base");
      expect(error.message).toContain("not echoed here");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an unusable Wix site id at construction without echoing it (a metaSiteId is a lowercase GUID)", () => {
    const resolver = makeResolver();
    const fake = makeFake();
    for (const bad of [
      SITE_ID.toUpperCase(),
      SITE_ID.replace(/-/g, ""),
      "683f07d9aa4b5c8d2e1f0a3b", // a Webflow-shaped id is not a Wix site id
      "not-a-site-id",
      "",
    ]) {
      let thrown: unknown;
      try {
        new WixAdapter({
          site: { ...SITE, siteId: bad },
          secrets: resolver,
          authRef: "vault://wix/prop-1",
          fetch: fake.port,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      const error = thrown as WriteMethodError;
      expect(error.code).toBe("misconfigured");
      if (bad !== "") expect(error.message).not.toContain(bad);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Credential containment (doc 04 §5 + the 1.2 leak-check discipline)  */
/* ------------------------------------------------------------------ */

describe("credential containment", () => {
  it("the key's ONLY egress is the bare Authorization header of requests to the pinned host", async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.apply(seoTitleWrite("New Title"));
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const req of fake.requests) {
      expect(req.headers.authorization).toBe(SECRET);
      expect(req.url).not.toContain(SECRET);
      expect(req.url).not.toContain(SECRET_B64);
      expect(req.body ?? "").not.toContain(SECRET);
      expect(req.body ?? "").not.toContain(SECRET_B64);
    }
  });

  it("no failure-mode error carries the key (raw or encoded) on any surface", async () => {
    const errors: WriteMethodError[] = [];

    // 401 while the real key is resolved (account rotated it away).
    const { adapter: a401, fake: fake401 } = makeAdapter();
    fake401.rotateKey("IST.someone-elses-key");
    errors.push(
      await expectFailure(
        a401.readCurrent(
          { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
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
    fakeVendor.failNextWriteWith(502, "BAD_GATEWAY");
    errors.push(
      await expectFailure(aVendor.apply(seoTitleWrite("N")), "vendor_failure"),
    );
    const { adapter: aNet, fake: fakeNet } = makeAdapter();
    fakeNet.http.failNext();
    errors.push(
      await expectFailure(
        aNet.readCurrent(
          { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
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
      { url: PAGE_URL, locator: `wix:page/${PAGE_ID}/seo.title` },
      CTX,
    );
  });
});
