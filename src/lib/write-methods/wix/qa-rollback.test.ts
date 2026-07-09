/**
 * QA ROLLBACK GATE — independent adversarial verification of the WIX write
 * method (method 3/4) against the change-management rollback contract
 * (doc 04 §2: "every change reversible by one action, via the same method
 * that applied it"; doc 07 gate 1.3). Written and owned by qa-testing — NOT a
 * re-run of the build agent's tests. Adapter source is never modified here;
 * defects are proven by failing tests.
 *
 * What this suite proves, end-to-end through the REAL ChangeManager pipeline
 * (never by calling the adapter directly, except the malformed-response sweep
 * where the pipeline cannot produce the input):
 *
 *  1. ROUND-TRIP PROPERTY, EXHAUSTIVELY — for EVERY locator kind the grammar
 *     exposes (page seo.title / seo.description × data field) and for edge
 *     value shapes (empty string, unicode/emoji/ZWJ/RTL, HTML entities kept
 *     literal, markup + control whitespace, NFD non-normalization, ~64 KiB
 *     strings; for data fields additionally every JSON type the adapter
 *     accepts — numbers, booleans, arrays, nested objects; top-level null is
 *     refused BY DESIGN in both directions): preview → apply → verify stored →
 *     rollback → the LIVE site is BYTE-EXACT the original capture, siblings
 *     untouched. A completeness pin ties the tested kinds to the grammar so a
 *     new locator kind fails this suite until it is covered. Every request is
 *     checked against a POSITIVE route/method whitelist — the EXACT endpoint
 *     set this method uses (GET+PATCH on one Pages route, GET+PUT on one Data
 *     route); Wix has NO publish-class endpoint to blacklist, so the
 *     whitelist IS the assertion that nothing else is ever called.
 *  2. FULL-REPLACE SAFETY — the headline Wix risk: Update Data Item REPLACES
 *     the item. Sibling fields (nested objects, arrays, unicode keys) survive
 *     apply AND revert byte-exact; a concurrent sibling edit landing between
 *     the pipeline's capture and the adapter's fresh read is re-carried; a
 *     concurrent sibling edit landing between the adapter's fresh read and
 *     its PUT is silently overwritten — originally this suite's DEFECT
 *     WIX-QA-2 failing proofs, DISPOSITIONED as an ACCEPTED RESIDUAL
 *     (Orchestrator + Code Review, 2026-07-09: Wix Data v2 is
 *     last-writer-wins with no conditional/partial update, so the window
 *     cannot be closed at the transport; adapter header carries the residual
 *     section + operator-facing framing). The two proofs are re-scoped below
 *     as PINS of the exact dispositioned behavior, red-sensitive to any
 *     future change in EITHER direction. Every echo-VISIBLE divergence stays
 *     loud (write_verification_failed) — including the page-SEO non-target
 *     guard (a seoData merge-PATCH behaving as a replace fails, both
 *     directions); system fields (_updatedDate etc.) never block
 *     verification and are never written.
 *  3. LIVE-IMMEDIATE SEMANTICS — there is no staged layer: the fake's SINGLE
 *     state is the live site and it is mutated the moment apply returns
 *     (which is why before-capture + verified revert is the entire safety
 *     story for this method). The QA-1 crash windows re-proven through THIS
 *     adapter: DB crash after the live write → retry keeps the persisted
 *     before via resumed_after_partial_apply; double-crash loop; crash after
 *     the revert reconciles idempotently.
 *  4. ROLLBACK UNDER ADVERSITY — item/page deleted after apply; API key
 *     rotated mid-revert (401, no secret anywhere); 429 in BOTH directions
 *     (truthful statuses, the same action re-run completes); the unset-SEO
 *     pattern-inheritance refusal in both directions with ZERO writes,
 *     including the derived-value flip landing between capture and apply;
 *     server-side normalization; HTML interstitial; network failure. In
 *     every case the row status stays TRUTHFUL — 'reverted' is never
 *     recorded without byte-exact proof.
 *  5. AUTO-ROLLBACK INTEGRATION — off / flag / execute through this adapter
 *     (an execute revert is LIVE the moment it lands); threshold boundary;
 *     failed auto-revert honest; no double fire; no credential in any alert.
 *  6. PARTIAL BATCH — a mixed page+data batch whose MIDDLE member fails
 *     (429, and separately a write-verification failure): exact prefix
 *     accounting, the tail never requested, the applied prefix rolls back
 *     byte-exact, and a batch re-run completes once the limit lifts.
 *  7. NO-SILENT-FAILURE SWEEP — every response-shape branch and catch in the
 *     adapter surfaces a typed error (nothing swallowed, nothing defaulted),
 *     every grammar refusal happens at plan time with ZERO HTTP, and every
 *     construction refusal is loud and echo-free.
 *
 * All HTTP is the injected FakeWix (ScriptedFetch) — zero live network.
 */

import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  steppingClock,
  type AlertDraft,
  type AutoRollbackPolicy,
  type ChangePatch,
  type DesiredChange,
  type MonitoredMetric,
  type MonitoringSignal,
  type TenantContext,
} from "@/lib/change-management";
import { VendorCredential, type SecretsResolver } from "@/lib/connectors";
import type { Json, SiteChangeRow, SiteChangeType } from "@/lib/types/db";
import {
  isWriteMethodError,
  type WriteMethodError,
  type WriteMethodErrorCode,
} from "../shared/errors";
import type { FetchPort } from "../shared/http";
import {
  jsonResponse,
  ScriptedFetch,
  textResponse,
} from "../shared/http-harness";
import { WIX_API_HOST, WixAdapter } from "./adapter";
import { FakeWix, type FakeWixSeed } from "./fake-wix";
import { wixLocators } from "./target";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const SECRET = "IST.qa-wix-api-key.Adversaria1.5ecretT0ken";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const SITE_ID = "7f3e2a10-9b8c-4d5e-8f01-23456789abcd";
const FOREIGN_SITE_ID = "00000000-1111-4222-8333-444455556666";
const PAGE_ID = "qapg1";
const PAGE2_ID = "qapg2";
const COLLECTION_ID = "Listings";
const ITEM_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-qa", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

/** Sentinel sibling values — collateral-damage detection on every round-trip. */
const SIBLING_SEO_TITLE = "sibling seo.title (must never change)";
const SIBLING_SEO_DESC = "sibling seo.description (must never change)";
const TARGET_FIELD = "qaTarget";

/**
 * Rich sibling set for the full-replace surface — nested objects, arrays,
 * unicode keys, an empty string, numbers, booleans, and an inner null. Every
 * one of these is re-carried by the adapter's read-fresh → swap-one-field →
 * PUT discipline, so every one is a potential clobber victim; the round-trip
 * asserts them byte-exact after apply AND after revert.
 */
const RICH_SIBLINGS: Record<string, Json> = {
  name: "Casa QA",
  price: 985000,
  featured: true,
  tags: ["pool", "garage", ""],
  address: {
    street: "123 Ocean View",
    geo: { lat: 32.7157, lng: -117.1611 },
    unit: null,
  },
  "名前🚀": "unicode-key sibling (must never change)",
  emptyNote: "",
};

/**
 * An InMemoryChangeStore whose NEXT update() throws AFTER the site write has
 * already happened — the QA-1 crash window. Test-only subclass; adapter and
 * pipeline source untouched.
 */
class CrashOnUpdateStore extends InMemoryChangeStore {
  crashNextUpdate = false;
  override async update(
    id: string,
    patch: ChangePatch,
    ctx: TenantContext,
  ): Promise<SiteChangeRow> {
    if (this.crashNextUpdate) {
      this.crashNextUpdate = false;
      throw new Error("qa: database unavailable after the site write");
    }
    return super.update(id, patch, ctx);
  }
}

interface Harness {
  fake: FakeWix;
  manager: ChangeManager;
  store: InMemoryChangeStore;
  alerts: AlertDraft[];
}

function harness(opts?: {
  seed?: Omit<FakeWixSeed, "apiKey" | "siteId">;
  policy?: AutoRollbackPolicy;
  store?: InMemoryChangeStore;
  /** Wrap the fake's port — mid-flight fault injection between requests. */
  wrapPort?: (port: FetchPort, fake: FakeWix) => FetchPort;
}): Harness {
  const fake = new FakeWix({
    apiKey: SECRET,
    siteId: SITE_ID,
    ...(opts?.seed ?? {}),
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const adapter = new WixAdapter({
    site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId: SITE_ID },
    secrets,
    authRef: "vault://wix/prop-1",
    fetch: opts?.wrapPort ? opts.wrapPort(fake.port, fake) : fake.port,
  });
  const clock = steppingClock("2026-07-09T12:00:00.000Z");
  const store = opts?.store ?? new InMemoryChangeStore({ clock });
  const alerts: AlertDraft[] = [];
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([adapter]),
    clock,
    policyResolver: () =>
      opts?.policy ?? {
        mode: "flag",
        thresholds: { traffic: 25, ranking: 30, visibility: 30 },
      },
    alertSink: { emit: (a) => void alerts.push(a) },
  });
  return { fake, manager, store, alerts };
}

function desired(
  spec: { changeType: SiteChangeType; locator?: string; propertyId?: string },
  before: Json,
  after: Json,
): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: spec.propertyId ?? "prop-1",
    method: "wix",
    changeType: spec.changeType,
    target: { url: "https://qa-client.example/listings", locator: spec.locator },
    before,
    after,
  };
}

function writeRequests(fake: FakeWix) {
  return fake.requests.filter((r) => r.method === "PATCH" || r.method === "PUT");
}

/* The EXACT endpoint set this method may use — nothing else exists for it. */
const PAGE_ROUTE_RE =
  /^https:\/\/www\.wixapis\.com\/site-pages\/v1\/pages\/[A-Za-z0-9_-]+$/;
const ITEM_READ_RE =
  /^https:\/\/www\.wixapis\.com\/wix-data\/v2\/items\/[A-Za-z0-9_-]+\?dataCollectionId=[A-Za-z0-9_-]+$/;
const ITEM_WRITE_RE =
  /^https:\/\/www\.wixapis\.com\/wix-data\/v2\/items\/[A-Za-z0-9_-]+$/;

/**
 * The POSITIVE traffic contract: every request this method emits is a GET or
 * PATCH on the ONE Pages route, or a GET (collection-scoped) or PUT on the
 * ONE Data-items route — always on the pinned host, always scoped by the
 * pinned `wix-site-id` header, always with the BARE API key (no Bearer/Basic
 * scheme), always with `redirect: "error"`. Wix has no publish endpoint to
 * blacklist — this whitelist IS the "exact endpoint set" assertion: a new
 * route or verb fails this suite until it is reviewed.
 */
function expectPinnedTraffic(fake: FakeWix): void {
  for (const req of fake.requests) {
    expect(req.url.startsWith(`${WIX_API_HOST}/`)).toBe(true);
    expect(req.url).not.toContain("publish");
    if (req.method === "GET") {
      expect(
        PAGE_ROUTE_RE.test(req.url) || ITEM_READ_RE.test(req.url),
        `GET escaped the endpoint whitelist: ${req.url}`,
      ).toBe(true);
    } else if (req.method === "PATCH") {
      expect(
        PAGE_ROUTE_RE.test(req.url),
        `PATCH escaped the Pages route: ${req.url}`,
      ).toBe(true);
    } else if (req.method === "PUT") {
      expect(
        ITEM_WRITE_RE.test(req.url),
        `PUT escaped the Data-items route: ${req.url}`,
      ).toBe(true);
    } else {
      throw new Error(`unexpected verb left the adapter: ${req.method} ${req.url}`);
    }
    // The pin IS the request scope: every call names the pinned site.
    expect(req.headers["wix-site-id"]).toBe(SITE_ID);
    // Bare-key auth — no borrowed Bearer/Basic scheme.
    expect(req.headers["authorization"]).toBe(SECRET);
    expect(req.redirect).toBe("error");
  }
}

async function expectFailure(
  p: Promise<unknown>,
  code: WriteMethodErrorCode,
): Promise<WriteMethodError> {
  let thrown: unknown = null;
  let resolved = false;
  try {
    await p;
    resolved = true;
  } catch (err) {
    thrown = err;
  }
  if (resolved) {
    throw new Error(`expected WriteMethodError '${code}', but the call resolved`);
  }
  if (!isWriteMethodError(thrown)) {
    throw new Error(
      `expected WriteMethodError '${code}', got: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  expect(thrown.code).toBe(code);
  expect(thrown.method).toBe("wix");
  return thrown;
}

function signal(metric: MonitoredMetric, deltaPct: number): MonitoringSignal {
  return {
    metric,
    deltaPct,
    windowDays: 7,
    observedAt: "2026-07-09T13:00:00.000Z",
    detail: "qa:scripted",
  };
}

function wixErrorBody(code: string): Json {
  return {
    message: "The request failed. See the application error for details.",
    details: { applicationError: { code, description: "See documentation." } },
  };
}

/*
 * Concurrent item edits now travel through FakeWix's OFFICIAL hooks —
 * `editDataItem` (at rest, between our calls) and `editDataItemOnNextPut`
 * (inside the GET→PUT window) — added with the WIX-QA-2 disposition; this
 * suite's original private-store reach-in helper is retired (the same
 * pattern as the Webflow gate's setMirror reach-in retirement, carry β).
 */

/** Model the site owner RESETTING a page SEO field to "inherit the pattern". */
function unsetPageSeoField(
  fake: FakeWix,
  pageId: string,
  attr: "title" | "description",
): void {
  const pages = (
    fake as unknown as {
      pages: Map<string, { seoData: { title?: string; description?: string } }>;
    }
  ).pages;
  const page = pages.get(pageId);
  if (!page) throw new Error(`qa harness: no page ${pageId}`);
  delete page.seoData[attr];
}

/** Model the site owner setting a page SEO field out-of-band (Editor save). */
function setPageSeoField(
  fake: FakeWix,
  pageId: string,
  attr: "title" | "description",
  value: string,
): void {
  const pages = (
    fake as unknown as {
      pages: Map<string, { seoData: { title?: string; description?: string } }>;
    }
  ).pages;
  const page = pages.get(pageId);
  if (!page) throw new Error(`qa harness: no page ${pageId}`);
  page.seoData[attr] = value;
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

function pageSeed(overrides: {
  seoTitle?: string;
  seoDescription?: string;
}): Omit<FakeWixSeed, "apiKey" | "siteId"> {
  return {
    pages: {
      [PAGE_ID]: {
        name: "QA Listings",
        seoData: {
          title: overrides.seoTitle ?? SIBLING_SEO_TITLE,
          description: overrides.seoDescription ?? SIBLING_SEO_DESC,
        },
      },
    },
  };
}

function itemSeed(value: Json): Omit<FakeWixSeed, "apiKey" | "siteId"> {
  return {
    collections: {
      [COLLECTION_ID]: {
        items: {
          [ITEM_ID]: { ...RICH_SIBLINGS, [TARGET_FIELD]: value },
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. Round-trip property, exhaustively                                */
/* ------------------------------------------------------------------ */

interface KindSpec {
  kind: string;
  domain: "page" | "data";
  changeType: SiteChangeType;
  locator: string;
  /** The exact absolute URL BOTH write calls must travel. */
  writeUrl: string;
  writeVerb: "PATCH" | "PUT";
  /** The EXACT write body a write of `value` must produce. */
  bodyFor(value: Json): Json;
  seed(value: Json): Omit<FakeWixSeed, "apiKey" | "siteId">;
  /** LIVE value at the target — the fake's single state IS the live site. */
  read(fake: FakeWix): Json;
  /** Fields the change must NOT touch — asserted identical after the cycle. */
  collateral(fake: FakeWix): Json;
  collateralExpected: Json;
}

function pageKind(attr: "title" | "description"): KindSpec {
  const seedKey = attr === "title" ? "seoTitle" : "seoDescription";
  const siblingAttr = attr === "title" ? "description" : "title";
  const siblingValue = attr === "title" ? SIBLING_SEO_DESC : SIBLING_SEO_TITLE;
  return {
    kind: `page/seo.${attr}`,
    domain: "page",
    changeType: attr === "title" ? "title" : "meta",
    locator:
      attr === "title"
        ? wixLocators.pageSeoTitle(PAGE_ID)
        : wixLocators.pageSeoDescription(PAGE_ID),
    writeUrl: `${WIX_API_HOST}/site-pages/v1/pages/${PAGE_ID}`,
    writeVerb: "PATCH",
    bodyFor: (value) => ({ page: { seoData: { [attr]: value } } }),
    seed: (value) => pageSeed({ [seedKey]: value as string }),
    read: (f) => f.page(PAGE_ID).seoData[attr] ?? null,
    collateral: (f) => {
      const page = f.page(PAGE_ID);
      return { name: page.name, [siblingAttr]: page.seoData[siblingAttr] ?? null };
    },
    collateralExpected: { name: "QA Listings", [siblingAttr]: siblingValue },
  };
}

const DATA_SPEC: KindSpec = {
  kind: "data/field",
  domain: "data",
  changeType: "content",
  locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, TARGET_FIELD),
  writeUrl: `${WIX_API_HOST}/wix-data/v2/items/${ITEM_ID}`,
  writeVerb: "PUT",
  // FULL REPLACE: the body must re-carry EVERY sibling byte-exact and must
  // never contain a system (underscore) field.
  bodyFor: (value) => ({
    dataCollectionId: COLLECTION_ID,
    dataItem: { data: { ...RICH_SIBLINGS, [TARGET_FIELD]: value } },
  }),
  seed: (value) => itemSeed(value),
  read: (f) => f.item(COLLECTION_ID, ITEM_ID)[TARGET_FIELD] ?? null,
  collateral: (f) => {
    const user = f.item(COLLECTION_ID, ITEM_ID);
    const siblings: Record<string, Json> = { ...user };
    delete siblings[TARGET_FIELD];
    return siblings;
  },
  collateralExpected: { ...RICH_SIBLINGS },
};

const KINDS: KindSpec[] = [pageKind("title"), pageKind("description"), DATA_SPEC];
const PAGE_TITLE_SPEC = KINDS[0];
const PAGE_DESC_SPEC = KINDS[1];

/** Edge string shapes — each must survive a byte-exact (code-point) round-trip. */
const STRING_SHAPES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "empty string", value: "" },
  {
    label: "unicode + emoji + ZWJ family + RTL",
    value: "Café “señor” — 🚀👩‍👩‍👧‍👦 ∑π≈3.14 中文 العربية",
  },
  {
    label: "HTML entities kept literal (never decoded)",
    value: "Ben &amp; Jerry&#8217;s &lt;homes&gt; &copy; 2026 &nbsp;",
  },
  {
    label: "markup + quotes + backslashes + control whitespace",
    value: '<div class="x" data-a=\'y\'>\\path\\to\t"q"\r\nline2\n</div>',
  },
  {
    label: "NFD combining form (normalization must NOT be applied)",
    value: "Café menu résumé".normalize("NFD"),
  },
  {
    label: "very long (~64 KiB, multibyte + emoji tail)",
    value: "A宿".repeat(16384) + "🚀",
  },
];

/** Every JSON type the data surface accepts (top-level null refused by design). */
const DATA_SHAPES: ReadonlyArray<{ label: string; value: Json }> = [
  ...STRING_SHAPES.map(({ label, value }) => ({
    label: `string: ${label}`,
    value: value as Json,
  })),
  { label: "zero", value: 0 },
  { label: "negative float", value: -273.15 },
  { label: "max safe integer", value: 9007199254740991 },
  { label: "false", value: false },
  { label: "true", value: true },
  { label: "empty array", value: [] },
  {
    label: "nested heterogeneous array (incl. inner null)",
    value: ["a", 0, false, ["b", { c: null }], ""],
  },
  { label: "empty object", value: {} },
  {
    label: "nested object (JSON-LD-like, unicode key, inner null)",
    value: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "名前🚀": { deep: [true, null, "x"] },
      n: 1.5,
    },
  },
];

const NEUTRAL_STRING_BEFORE = "QA neutral original value";
const NEUTRAL_STRING_AFTER = "QA neutral approved value";
const NEUTRAL_DATA_BEFORE: Json = { qa: "neutral-original" };
const NEUTRAL_DATA_AFTER: Json = { qa: "neutral-approved" };

/**
 * One full pipeline round-trip on the LIVE-IMMEDIATE surface: preview →
 * human-approved apply (the fake's single state — the live site — holds
 * `after` the moment apply returns; the audit row captured `original`) →
 * one-click rollback (the live site is byte-exact `original` again, sibling
 * fields identical, exactly two writes down the pinned route with the exact
 * single-field/full-replace bodies, zero traffic outside the endpoint
 * whitelist, and — for the data kind — system fields never written and never
 * blocking verification).
 */
async function runRoundTrip(spec: KindSpec, original: Json, after: Json) {
  const h = harness({ seed: spec.seed(original) });
  const systemBefore =
    spec.domain === "data" ? h.fake.itemSystem(COLLECTION_ID, ITEM_ID) : null;

  const preview = await h.manager.preview(desired(spec, original, after), CTX);
  expect(preview.change.status).toBe("previewed");
  expect(h.fake.requests).toHaveLength(0); // preview never touches the site

  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(applied.warnings).toEqual([]); // seeded live state matches preview
  expect(applied.change.status).toBe("applied");
  // LIVE-IMMEDIATE: the fake's single state IS the site visitors see, and it
  // holds the after-value the moment apply returns — no publish gate exists.
  expect(spec.read(h.fake)).toEqual(after);
  // The audit row carries the byte-exact captured baseline.
  expect(applied.change.diff.before).toEqual(original);
  expect(applied.change.diff.after).toEqual(after);

  const reverted = await h.manager.rollback(
    applied.change.id,
    { reason: "qa: round-trip proof" },
    CTX,
  );
  expect(reverted.change.status).toBe("reverted");

  const restored = spec.read(h.fake);
  expect(restored).toEqual(original);
  if (typeof original === "string") {
    // Code-point identity for string surfaces — BYTE-EXACT, not "similar".
    expect(restored).toBe(original);
  }
  // No collateral damage: sibling fields identical after the full cycle.
  expect(spec.collateral(h.fake)).toEqual(spec.collateralExpected);

  // Exactly two writes (apply + revert), both down the pinned route, with the
  // EXACT bodies: after on the way in, the byte-exact original back out (for
  // the data kind, the full-replace body re-carries every sibling both ways).
  const writes = writeRequests(h.fake);
  expect(writes).toHaveLength(2);
  for (const w of writes) {
    expect(w.method).toBe(spec.writeVerb);
    expect(w.url).toBe(spec.writeUrl);
  }
  expect(JSON.parse(writes[0].body ?? "")).toEqual(spec.bodyFor(after));
  expect(JSON.parse(writes[1].body ?? "")).toEqual(spec.bodyFor(original));

  if (spec.domain === "data" && systemBefore) {
    // System fields were NEVER in a write body...
    for (const w of writes) {
      const data = (JSON.parse(w.body ?? "") as { dataItem: { data: Record<string, Json> } })
        .dataItem.data;
      expect(Object.keys(data).filter((k) => k.startsWith("_"))).toEqual([]);
    }
    // ...the server-managed ones the site keeps are untouched, and the
    // always-advancing _updatedDate never blocked verification (both writes
    // verified despite it changing on each).
    const systemAfter = h.fake.itemSystem(COLLECTION_ID, ITEM_ID);
    expect(systemAfter._createdDate).toBe(systemBefore._createdDate);
    expect(systemAfter._owner).toBe(systemBefore._owner);
    expect(systemAfter._updatedDate).not.toBe(systemBefore._updatedDate);
  }
  expectPinnedTraffic(h.fake);
}

describe("QA gate 1 — round-trip property across EVERY supported locator kind", () => {
  it("the QA matrix covers every locator kind the grammar exposes (completeness pin)", () => {
    // If a new locator builder ships, this fails until the matrix covers it.
    expect(Object.keys(wixLocators).sort()).toEqual(
      ["dataField", "pageSeoDescription", "pageSeoTitle"].sort(),
    );
    expect(KINDS.map((k) => k.kind).sort()).toEqual(
      ["data/field", "page/seo.description", "page/seo.title"].sort(),
    );
    // And every builder's output is literally one of the tested locators.
    expect(KINDS.map((k) => k.locator).sort()).toEqual(
      [
        wixLocators.pageSeoTitle(PAGE_ID),
        wixLocators.pageSeoDescription(PAGE_ID),
        wixLocators.dataField(COLLECTION_ID, ITEM_ID, TARGET_FIELD),
      ].sort(),
    );
  });

  for (const spec of KINDS.filter((k) => k.domain === "page")) {
    describe(`${spec.kind} — string edge shapes`, () => {
      it.each(STRING_SHAPES)(
        `restores a "$label" ORIGINAL byte-exact after rollback`,
        async ({ value }) => {
          await runRoundTrip(spec, value, NEUTRAL_STRING_AFTER);
        },
      );
      it.each(STRING_SHAPES)(
        `installs a "$label" AFTER verifiably, then rolls back byte-exact`,
        async ({ value }) => {
          await runRoundTrip(spec, NEUTRAL_STRING_BEFORE, value);
        },
      );
    });
  }

  describe("data/field — every accepted JSON type + string edge shapes", () => {
    it.each(DATA_SHAPES)(
      `restores a "$label" ORIGINAL after rollback`,
      async ({ value }) => {
        await runRoundTrip(DATA_SPEC, value, NEUTRAL_DATA_AFTER);
      },
    );
    it.each(DATA_SHAPES)(
      `installs a "$label" AFTER verifiably, then rolls back`,
      async ({ value }) => {
        await runRoundTrip(DATA_SPEC, NEUTRAL_DATA_BEFORE, value);
      },
    );
  });

  it("preserves the exact unicode normalization form on restore (NFD stays NFD) — page and data", async () => {
    const nfd = "Café menu".normalize("NFD"); // decomposed
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc); // the test is sensitive to the difference

    for (const spec of [PAGE_TITLE_SPEC, DATA_SPEC]) {
      const h = harness({ seed: spec.seed(nfd) });
      const preview = await h.manager.preview(desired(spec, nfd, nfc), CTX);
      const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
      expect(spec.read(h.fake)).toBe(nfc);
      await h.manager.rollback(applied.change.id, { reason: "qa: nfd" }, CTX);
      expect(spec.read(h.fake)).toBe(nfd);
      expect(spec.read(h.fake)).not.toBe(nfc);
      expect(applied.change.diff.before).toBe(nfd);
    }
  });

  it("a stale null PREVIEWED before cannot poison the rollback baseline — re-baselined to the live capture, drift surfaced", async () => {
    const h = harness({ seed: itemSeed("live-value") });
    const preview = await h.manager.preview(desired(DATA_SPEC, null, "x"), CTX);

    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBe("live-value");
    expect(DATA_SPEC.read(h.fake)).toBe("x");

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(DATA_SPEC.read(h.fake)).toBe("live-value");
  });

  it("refuses a non-string page AFTER at plan time (null / number / object) — zero writes, row stays previewed", async () => {
    for (const after of [null, 42, { title: "x" }] as Json[]) {
      const h = harness({ seed: pageSeed({ seoTitle: "Original" }) });
      const preview = await h.manager.preview(
        desired(PAGE_TITLE_SPEC, "Original", after),
        CTX,
      );
      await expectFailure(
        h.manager.apply(preview.change.id, APPROVAL, CTX),
        "invalid_value",
      );
      expect(writeRequests(h.fake)).toHaveLength(0);
      expect(PAGE_TITLE_SPEC.read(h.fake)).toBe("Original");
      expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    }
  });

  it("refuses a LIVE-unset page field at before-capture — a first-ever SEO value cannot round-trip to 'inherit the pattern'", async () => {
    // seo.description never set on the page: it INHERITS the site-level SEO
    // pattern, so the change is refused BEFORE any write, at capture time.
    const h = harness({
      seed: {
        pages: {
          [PAGE_ID]: { name: "QA Listings", seoData: { title: SIBLING_SEO_TITLE } },
        },
      },
    });
    const preview = await h.manager.preview(
      desired(PAGE_DESC_SPEC, "stale", "new"),
      CTX,
    );
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(err.message).toContain("unset");
    expect(err.message).toContain("pattern");
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses a null data AFTER at plan time — Wix Data's explicit-null is unrepresentable in the diff, by design", async () => {
    const h = harness({ seed: itemSeed("live-value") });
    const preview = await h.manager.preview(
      desired(DATA_SPEC, "live-value", null),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(DATA_SPEC.read(h.fake)).toBe("live-value");
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses an EXPLICITLY-null live data field at before-capture — null and absent are indistinguishable in the persisted diff", async () => {
    const h = harness({ seed: itemSeed(null) });
    const preview = await h.manager.preview(desired(DATA_SPEC, "stale", "new"), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(err.message).toContain("null");
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses a data field ABSENT from the item at before-capture (never valued / no such field) — target_missing, zero writes", async () => {
    const h = harness({
      seed: {
        collections: {
          [COLLECTION_ID]: {
            items: { [ITEM_ID]: { ...RICH_SIBLINGS } }, // TARGET_FIELD never valued
          },
        },
      },
    });
    const preview = await h.manager.preview(desired(DATA_SPEC, "stale", "new"), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "target_missing",
    );
    expect(err.message).toContain(TARGET_FIELD);
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Full-replace safety — the headline Wix risk                      */
/* ------------------------------------------------------------------ */

const ORIGINAL_VALUE = "Original summary — café 🚀";
const APPROVED_VALUE = "Approved summary | QA";

async function applyDataChange(h: Harness) {
  const preview = await h.manager.preview(
    desired(DATA_SPEC, ORIGINAL_VALUE, APPROVED_VALUE),
    CTX,
  );
  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(DATA_SPEC.read(h.fake)).toBe(APPROVED_VALUE);
  return applied.change;
}

describe("QA gate 2 — full-replace safety: siblings survive, nothing is silently clobbered", () => {
  it("rich siblings (nested objects, arrays, unicode keys, empty string, inner null) survive apply AND revert byte-exact", async () => {
    // The dedicated proof for doc 04 §2 on a full-replace surface — the
    // round-trip helper asserts collateral, exact PUT bodies re-carrying
    // every sibling in BOTH directions, and the system-field discipline.
    await runRoundTrip(
      DATA_SPEC,
      ORIGINAL_VALUE,
      "New value that must not disturb any sibling",
    );
  });

  it("a sibling edited BETWEEN the pipeline's capture and the adapter's fresh read is RE-CARRIED — the fresh read catches it and the edit survives apply", async () => {
    let itemGets = 0;
    const h = harness({
      seed: itemSeed(ORIGINAL_VALUE),
      // The concurrent editor's save lands right after the pipeline's
      // before-capture read — BEFORE the adapter's own fresh read.
      wrapPort: (port, fake) => async (url, init) => {
        const res = await port(url, init);
        if (init.method === "GET" && ITEM_READ_RE.test(url) && ++itemGets === 1) {
          fake.editDataItem(COLLECTION_ID, ITEM_ID, {
            name: "Edited concurrently by the owner",
          });
        }
        return res;
      },
    });
    const preview = await h.manager.preview(
      desired(DATA_SPEC, ORIGINAL_VALUE, APPROVED_VALUE),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.change.status).toBe("applied");
    expect(DATA_SPEC.read(h.fake)).toBe(APPROVED_VALUE);
    // The concurrent sibling edit SURVIVED the full-replace write.
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(
      "Edited concurrently by the owner",
    );
    // And the PUT body proves it was the fresh read that carried it.
    const put = writeRequests(h.fake)[0];
    const data = (JSON.parse(put.body ?? "") as { dataItem: { data: Record<string, Json> } })
      .dataItem.data;
    expect(data.name).toBe("Edited concurrently by the owner");
  });

  it("ACCEPTED RESIDUAL pin (gate-dispositioned 2026-07-09, APPLY direction; ex-DEFECT WIX-QA-2): a sibling edited inside the GET→PUT window is overwritten with the re-carried values — clean 'applied', ZERO warnings", async () => {
    // Originally this suite's failing DEFECT proof: the honest contract
    // (re-carry or truthful failure) is NOT met in this window, and CANNOT
    // be — Wix Data v2 is last-writer-wins with no conditional/partial
    // update. Orchestrator + Code Review dispositioned the behavior as an
    // ACCEPTED RESIDUAL (adapter header carries the residual section + the
    // operator-facing correlation guidance). This pin asserts the EXACT
    // dispositioned behavior, so it turns red on any future change in
    // EITHER direction: a loud failure appearing, a warning appearing, or
    // the edit starting to survive all force this pin — and the disposition
    // — back to review.
    const CONCURRENT = "Edited concurrently inside the write window";
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    // The official one-shot hook: the edit lands when the apply's PUT
    // arrives — AFTER the adapter's fresh pre-write GET, BEFORE the full
    // replace processes.
    h.fake.editDataItemOnNextPut(COLLECTION_ID, ITEM_ID, { name: CONCURRENT });

    const preview = await h.manager.preview(
      desired(DATA_SPEC, ORIGINAL_VALUE, APPROVED_VALUE),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);

    // The dispositioned residual, exactly: the change applies clean...
    expect(applied.change.status).toBe("applied");
    expect(applied.warnings).toEqual([]);
    expect(applied.change.diff.before).toBe(ORIGINAL_VALUE);
    expect(DATA_SPEC.read(h.fake)).toBe(APPROVED_VALUE);
    // ...and the concurrent edit is GONE, replaced by the stale re-carried
    // value, with no trace on the change row.
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(RICH_SIBLINGS.name);
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).not.toBe(CONCURRENT);

    // The residual does not corrupt the rollback contract: the one-click
    // revert still restores the captured target byte-exact (the lost edit
    // stays lost — that IS the residual, not a rollback failure).
    const reverted = await h.manager.rollback(
      applied.change.id,
      { reason: "qa: residual pin — rollback still sound" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(DATA_SPEC.read(h.fake)).toBe(ORIGINAL_VALUE);
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(RICH_SIBLINGS.name);
  });

  it("ACCEPTED RESIDUAL pin (gate-dispositioned 2026-07-09, REVERT direction; ex-DEFECT WIX-QA-2): the same window during rollback — clean 'reverted', edit overwritten, target restored byte-exact", async () => {
    const CONCURRENT = "Edited concurrently inside the revert window";
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    const change = await applyDataChange(h);

    // Armed AFTER the apply completed, so the one-shot edit lands at the
    // REVERT's PUT — inside its GET→PUT window.
    h.fake.editDataItemOnNextPut(COLLECTION_ID, ITEM_ID, { name: CONCURRENT });

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: residual pin (revert direction)" },
      CTX,
    );
    // The dispositioned residual, exactly: the revert completes clean and
    // byte-exact on the TARGET...
    expect(reverted.change.status).toBe("reverted");
    expect(reverted.warnings).toEqual([]);
    expect(DATA_SPEC.read(h.fake)).toBe(ORIGINAL_VALUE);
    // ...while the in-window sibling edit is overwritten with the stale
    // re-carried value — silently (the accepted residual).
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(RICH_SIBLINGS.name);
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).not.toBe(CONCURRENT);
  });

  it("a sibling edited AFTER apply survives the revert — the revert's fresh read re-carries it while restoring only the target", async () => {
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    const change = await applyDataChange(h);

    // Owner edits siblings between apply and rollback (at rest, not racing).
    h.fake.editDataItem(COLLECTION_ID, ITEM_ID, {
      name: "Owner's newer sibling edit",
      tags: ["pool", "garage", "solar"],
    });

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo without collateral" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    // Target restored byte-exact; the owner's newer sibling edits SURVIVE.
    expect(DATA_SPEC.read(h.fake)).toBe(ORIGINAL_VALUE);
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(
      "Owner's newer sibling edit",
    );
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).tags).toEqual([
      "pool",
      "garage",
      "solar",
    ]);
  });

  it("an echo-visible sibling divergence (server rewrites a re-carried sibling) is write_verification_failed — NEVER silent", async () => {
    // A sibling carries double spaces; the vendor normalizes whitespace on
    // write. The full-replace PUT re-writes the sibling, the echo comes back
    // altered — the adapter must refuse to call this write clean.
    const h = harness({
      seed: {
        collections: {
          [COLLECTION_ID]: {
            items: {
              [ITEM_ID]: {
                ...RICH_SIBLINGS,
                name: "Casa Uno:  a name with  odd spacing",
                [TARGET_FIELD]: ORIGINAL_VALUE,
              },
            },
          },
        },
      },
    });
    h.fake.mutateWrites((v) => v.replace(/ {2,}/g, " "));
    const preview = await h.manager.preview(
      desired(DATA_SPEC, ORIGINAL_VALUE, "New clean value"),
      CTX,
    );
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("OTHER fields");
    // Truthful status: the row never claimed 'applied' though the LIVE site
    // now holds the altered sibling — the honest mess is surfaced, not hidden.
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.item(COLLECTION_ID, ITEM_ID).name).toBe(
      "Casa Uno: a name with odd spacing",
    );
  });

  it("page-SEO merge-semantics guard (APPLY): a seoData PATCH behaving as a REPLACE (wiping the other attribute) is write_verification_failed — live data loss is never silent", async () => {
    // Code Review Major 2 surface, proven through the REAL pipeline: the
    // adapter assumes the single-key PATCH merges; the fake's counterfactual
    // flips it to replace semantics, so the write wipes seo.description.
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    h.fake.simulateSeoDataReplaceSemantics();
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("seo.description");
    expect(err.message).toContain("not approved to change");
    // TRUTHFUL: the row never claimed 'applied', though the LIVE page has
    // already lost its description — the honest mess surfaced, not hidden.
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.page(PAGE_ID).seoData.description).toBeUndefined();
  });

  it("page-SEO merge-semantics guard (REVERT): a restore that wipes the other attribute is reported — the row stays 'applied', never a false 'reverted'", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);
    expect(h.fake.page(PAGE_ID).seoData.description).toBe(SIBLING_SEO_DESC);

    // The vendor's PATCH semantics change between apply and rollback.
    h.fake.simulateSeoDataReplaceSemantics();
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("seo.description");
    const row = h.store.peek(change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
  });

  it("a page whose OTHER SEO attribute is UNSET round-trips cleanly — unset stays unset (never materialized as empty) through apply AND rollback", async () => {
    const h = harness({
      seed: {
        pages: {
          [PAGE_ID]: {
            name: "QA Listings",
            seoData: { title: ORIGINAL_TITLE }, // description UNSET (inherits)
          },
        },
      },
    });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings).toEqual([]);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
    expect(h.fake.page(PAGE_ID).seoData.description).toBeUndefined();

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
    // The non-target guard's unset≠empty discipline held both directions.
    expect(h.fake.page(PAGE_ID).seoData.description).toBeUndefined();
    expectPinnedTraffic(h.fake);
  });

  it("system fields are structurally unwritable: a locator naming one is refused at plan time with ZERO HTTP", async () => {
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    for (const field of ["_updatedDate", "_id", "_owner", "_createdDate"]) {
      const preview = await h.manager.preview(
        desired(
          {
            changeType: "content",
            locator: `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/${field}`,
          },
          "old",
          "new",
        ),
        CTX,
      );
      await expectFailure(
        h.manager.apply(preview.change.id, APPROVAL, CTX),
        "unsupported_operation",
      );
      expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    }
    expect(h.fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Live-immediate semantics + the QA-1 crash windows                 */
/* ------------------------------------------------------------------ */

const ORIGINAL_TITLE = "Original título — café 🚀";
const APPROVED_TITLE = "Approved Title | QA";

async function applyTitleChange(h: Harness) {
  const preview = await h.manager.preview(
    desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
    CTX,
  );
  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  return applied.change;
}

describe("QA gate 3 — live-immediate semantics: applies are LIVE; the QA-1 crash windows hold through this adapter", () => {
  it("the fake's SINGLE state is the live site and it is mutated at apply — no staged accessor exists, and the exact page endpoint sequence is pinned", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    // Model pin: FakeWix deliberately has NO staged/published split — the
    // accessors a staged model would need do not exist on it.
    expect((h.fake as unknown as Record<string, unknown>).livePage).toBeUndefined();
    expect((h.fake as unknown as Record<string, unknown>).liveItem).toBeUndefined();

    const change = await applyTitleChange(h);
    // Mutated AT apply: the state read here is what visitors/crawlers see.
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
    await h.manager.rollback(change.id, { reason: "qa: undo" }, CTX);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);

    // The EXACT endpoint sequence of a page lifecycle — capture read,
    // pre-write gate read, write; then the revert's gate read and write.
    // There is no publish-class call because none exists for this method.
    const route = `${WIX_API_HOST}/site-pages/v1/pages/${PAGE_ID}`;
    expect(h.fake.requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", route],
      ["GET", route],
      ["PATCH", route],
      ["GET", route],
      ["PATCH", route],
    ]);
    expectPinnedTraffic(h.fake);
  });

  it("the exact data-item endpoint sequence is pinned the same way (collection-scoped reads, bare-item PUTs)", async () => {
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    const change = await applyDataChange(h);
    await h.manager.rollback(change.id, { reason: "qa: undo" }, CTX);
    expect(DATA_SPEC.read(h.fake)).toBe(ORIGINAL_VALUE);

    const readUrl = `${WIX_API_HOST}/wix-data/v2/items/${ITEM_ID}?dataCollectionId=${COLLECTION_ID}`;
    const writeUrl = `${WIX_API_HOST}/wix-data/v2/items/${ITEM_ID}`;
    expect(h.fake.requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", readUrl],
      ["GET", readUrl],
      ["PUT", writeUrl],
      ["GET", readUrl],
      ["PUT", writeUrl],
    ]);
    expectPinnedTraffic(h.fake);
  });

  it("QA-1 RE-VERIFICATION (page): DB crash AFTER the live write → retry keeps the ORIGINAL rollback baseline (resumed_after_partial_apply); rollback restores it byte-exact", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }), store });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );

    // Crash window: the LIVE site write lands, the DB row update fails. On a
    // live-immediate method visitors are ALREADY seeing the after-value while
    // the row still reads 'previewed' — the worst version of this window.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE); // live, half-applied
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // Documented recovery: retry the apply against the same row. The manager
    // fix must hold through THIS adapter: baseline = the ORIGINAL pre-change
    // state, never the adapter's re-read of our own half-applied write.
    const retried = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retried.change.status).toBe("applied");
    expect(retried.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(retried.change.diff.before).toBe(ORIGINAL_TITLE);

    const reverted = await h.manager.rollback(
      retried.change.id,
      { reason: "qa: undo after crash-recovery" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });

  it("QA-1 RE-VERIFICATION (data, double crash): crash → retry → crash AGAIN → retry: the original JSON baseline survives every cycle; rollback restores it", async () => {
    const ORIGINAL_SCHEMA: Json = { "@type": "FAQPage", rev: 1, note: "original 🚀" };
    const AFTER_SCHEMA: Json = { "@type": "FAQPage", rev: 2, note: "approved" };
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: itemSeed(ORIGINAL_SCHEMA), store });
    const preview = await h.manager.preview(
      desired(DATA_SPEC, ORIGINAL_SCHEMA, AFTER_SCHEMA),
      CTX,
    );

    // Crash window #1.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(DATA_SPEC.read(h.fake)).toEqual(AFTER_SCHEMA); // live already
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // Crash window #2: the RETRY takes the resumed branch, then crashes too.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
    expect(store.peek(preview.change.id)?.diff.before).toEqual(ORIGINAL_SCHEMA);

    // Third attempt completes — original baseline intact.
    const retried = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retried.change.status).toBe("applied");
    expect(retried.change.diff.before).toEqual(ORIGINAL_SCHEMA);
    expect(retried.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    // And the siblings were re-carried through every crash cycle.
    expect(DATA_SPEC.collateral(h.fake)).toEqual(DATA_SPEC.collateralExpected);

    const reverted = await h.manager.rollback(
      retried.change.id,
      { reason: "qa: undo after double-crash recovery" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(DATA_SPEC.read(h.fake)).toEqual(ORIGINAL_SCHEMA);
  });

  it("DB crash AFTER the site revert: row truthfully stays 'applied' (the LIVE site is already restored); retry reconciles idempotently", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }), store });
    const change = await applyTitleChange(h);

    store.crashNextUpdate = true;
    await expect(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
    ).rejects.toThrow("database unavailable");

    // Safe direction: the LIVE site is restored, but the row never claims
    // 'reverted' until the DB confirms it.
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
    expect(store.peek(change.id)?.status).toBe("applied");
    expect(store.peek(change.id)?.reverted_at).toBeNull();

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Rollback under adversity — statuses stay TRUTHFUL                */
/* ------------------------------------------------------------------ */

describe("QA gate 4 — rollback under adversity (row status stays TRUTHFUL)", () => {
  it("item deleted after apply: revert fails target_missing, row STAYS applied, never a false 'reverted'; retry stays honest", async () => {
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    const change = await applyDataChange(h);

    h.fake.removeItem(COLLECTION_ID, ITEM_ID);
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: regressed" }, CTX),
      "target_missing",
    );
    const row = h.store.peek(change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(row?.reverted_reason).toBeNull();

    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: retry" }, CTX),
      "target_missing",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
  });

  it("page deleted after apply: revert fails target_missing (scoped to the pinned site), row stays applied", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.removePage(PAGE_ID);
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "target_missing",
    );
    expect(err.message).toContain("pinned site");
    expect(h.store.peek(change.id)?.status).toBe("applied");
  });

  it("API key rotated mid-revert (401): row stays applied, no credential in the error; reconnect + retry completes byte-exact", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.rotateKey("IST.rotated-away");
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "credential_rejected",
    );
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(SECRET_B64);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE); // untouched

    h.fake.rotateKey(SECRET); // property reconnected
    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });

  it("429 at the before-capture read on APPLY: rate_limited with the whitelisted Retry-After, ZERO writes, row previewed; the same action re-run completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    h.fake.rateLimitNext(30);

    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.retryAfterSeconds).toBe(30);
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);

    const retry = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  });

  it("429 on the apply WRITE itself: rate_limited, row stays previewed, the LIVE site untouched; retry completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    h.fake.failNextWriteWith(429, "RATE_LIMIT_EXCEEDED");

    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.httpStatus).toBe(429);
    expect(err.vendorCode).toBe("RATE_LIMIT_EXCEEDED");
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);

    const retry = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  });

  it("429 mid-REVERT: row stays applied (truthful), the LIVE site keeps the after-state; retry once the limit lifts restores byte-exact", async () => {
    const h = harness({ seed: itemSeed(ORIGINAL_VALUE) });
    const change = await applyDataChange(h);

    h.fake.failNextWriteWith(429, "RATE_LIMIT_EXCEEDED");
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "rate_limited",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(DATA_SPEC.read(h.fake)).toBe(APPROVED_VALUE);

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(DATA_SPEC.read(h.fake)).toBe(ORIGINAL_VALUE);
    expect(DATA_SPEC.collateral(h.fake)).toEqual(DATA_SPEC.collateralExpected);
  });

  it("a garbage Retry-After header is dropped — never parsed, never echoed", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    h.fake.rateLimitNext("soon™ maybe; rm -rf /");

    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.message).not.toContain("soon™");
    expect(err.message).not.toContain("rm -rf");
  });

  it("DERIVED-VALUE FLIP between capture and apply: the owner resets the field to 'inherit' after the capture read — the pre-write gate refuses (invalid_value), ZERO writes; re-set → the same action completes", async () => {
    let pageGets = 0;
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      // Unset the field right after the FIRST page GET (the pipeline's
      // capture) — the adapter's own pre-write GET must catch the flip.
      wrapPort: (port, fake) => async (url, init) => {
        const res = await port(url, init);
        if (init.method === "GET" && PAGE_ROUTE_RE.test(url) && ++pageGets === 1) {
          unsetPageSeoField(fake, PAGE_ID, "title");
        }
        return res;
      },
    });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(err.message).toContain("inherits");
    expect(writeRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");

    // The owner sets the field again → the same action completes.
    setPageSeoField(h.fake, PAGE_ID, "title", ORIGINAL_TITLE);
    const retry = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  });

  it("UNSET-SEO refusal on the REVERT direction: the owner resets the field to 'inherit' after apply — revert refuses pre-write (invalid_value), row stays applied; re-set → rollback restores byte-exact", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);
    const writesBefore = writeRequests(h.fake).length;

    unsetPageSeoField(h.fake, PAGE_ID, "title");
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "invalid_value",
    );
    expect(err.message).toContain("inherits");
    expect(writeRequests(h.fake)).toHaveLength(writesBefore); // zero new writes
    expect(h.store.peek(change.id)?.status).toBe("applied");

    setPageSeoField(h.fake, PAGE_ID, "title", "owner re-set value");
    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });

  it("server-side normalization on revert (page): write_verification_failed, row stays applied — honest mess surfaced; fixed retry restores byte-exact", async () => {
    const original = "Casa Uno:  a title with  odd spacing";
    const h = harness({ seed: pageSeed({ seoTitle: original }) });
    const preview = await h.manager.preview(
      desired(PAGE_TITLE_SPEC, original, "New tight title"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);

    h.fake.mutateWrites((v) => v.replace(/ {2,}/g, " "));
    const err = await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("stored a different value");

    // TRUTHFUL: still 'applied' — 'reverted' was NOT recorded without
    // byte-exact proof, even though the LIVE site now holds a third state.
    const row = h.store.peek(applied.change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(
      "Casa Uno: a title with odd spacing",
    );

    // Normalization gone → the retry restores byte-exact, only then 'reverted'.
    h.fake.mutateWrites((v) => v);
    const reverted = await h.manager.rollback(
      applied.change.id,
      { reason: "qa: undo (normalization fixed)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(original);
  });

  it("network failure mid-revert: row stays applied; retry completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.http.failNext(
      Object.assign(new Error("socket hang up at https://internal-proxy.local"), {
        code: "ECONNRESET",
      }),
    );
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "network_failure",
    );
    // Whitelisted transport detail only — never the raw error text.
    expect(err.message).toContain("ECONNRESET");
    expect(err.message).not.toContain("internal-proxy");
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);

    await h.manager.rollback(change.id, { reason: "qa: undo (retry)" }, CTX);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
    expect(h.store.peek(change.id)?.status).toBe("reverted");
  });

  it("HTML interstitial (CDN/WAF challenge) mid-revert: honest unexpected_response, row stays applied, markup never echoed", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.simulateHtmlInterstitial();
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "unexpected_response",
    );
    expect(err.message).toContain("HTML page instead of an API response");
    expect(err.message).not.toContain("Checking your browser");
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Auto-rollback integration through THIS adapter                   */
/* ------------------------------------------------------------------ */

describe("QA gate 5 — auto-rollback fires through the Wix adapter, live-immediate, respecting mode flags", () => {
  const THRESHOLDS = { traffic: 25, ranking: 30, visibility: 30 };

  it("mode 'off': a breaching signal is recorded but NEVER evaluated — no revert, no flag", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "off", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = writeRequests(h.fake).length;

    const evaluation = await h.manager.monitor(change.id, [signal("traffic", -99)], CTX);
    expect(evaluation.action).toBe("none");
    expect(evaluation.breaches).toEqual([]);
    expect(writeRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
  });

  it("mode 'flag': a breach is surfaced for a HUMAN to revert — the site is not touched; the human one-click revert then works", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "flag", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = writeRequests(h.fake).length;

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("visibility", -45)],
      CTX,
    );
    expect(evaluation.action).toBe("flagged");
    expect(evaluation.breaches.map((b) => b.metric)).toEqual(["visibility"]);
    expect(writeRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");

    await h.manager.rollback(change.id, { reason: "qa: flagged breach" }, CTX);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });

  it("mode 'execute': a monitored regression AUTO-reverts byte-exact — LIVE the moment it lands — with an honest alert that never carries the credential", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("traffic", -40), signal("ranking", -10)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_reverted");
    expect(evaluation.breaches.map((b) => b.metric)).toEqual(["traffic"]);

    // The revert went THROUGH the Wix adapter to the pinned route, and the
    // LIVE site holds the original again the moment monitor() returned.
    const writes = writeRequests(h.fake);
    expect(writes).toHaveLength(2);
    expect(writes[1].url).toBe(`${WIX_API_HOST}/site-pages/v1/pages/${PAGE_ID}`);
    expect(JSON.parse(writes[1].body ?? "")).toEqual({
      page: { seoData: { title: ORIGINAL_TITLE } },
    });
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
    expectPinnedTraffic(h.fake);

    const row = h.store.peek(change.id);
    expect(row?.status).toBe("auto_reverted");
    expect(row?.reverted_reason).toMatch(
      /^auto-rollback: traffic -40%.*25% drop threshold/,
    );
    expect(row?.reverted_at).not.toBeNull();

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      tenantId: "t1",
      clientId: "c1",
      type: "auto_rollback_fired",
      severity: "critical",
    });
    expect(JSON.stringify(h.alerts)).not.toContain(SECRET);
    expect(JSON.stringify(h.alerts)).not.toContain(SECRET_B64);
  });

  it("threshold boundary: exactly -threshold fires; one tenth inside does not; improvement never fires", async () => {
    const atEdge = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeA = await applyTitleChange(atEdge);
    const evalA = await atEdge.manager.monitor(changeA.id, [signal("traffic", -25)], CTX);
    expect(evalA.action).toBe("auto_reverted");
    expect(atEdge.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);

    const inside = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeB = await applyTitleChange(inside);
    const evalB = await inside.manager.monitor(changeB.id, [signal("traffic", -24.9)], CTX);
    expect(evalB.action).toBe("none");
    expect(inside.store.peek(changeB.id)?.status).toBe("applied");
    expect(inside.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);

    const evalC = await inside.manager.monitor(changeB.id, [signal("traffic", 40)], CTX);
    expect(evalC.action).toBe("none");
  });

  it("execute-mode revert failure (503): action 'auto_revert_failed', row stays applied, NO alert claims a revert; retry completes and only then alerts", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(503, "SERVICE_UNAVAILABLE");
    const failed = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(failed.action).toBe("auto_revert_failed");
    if (!isWriteMethodError(failed.error)) {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(failed.error.code).toBe("vendor_failure");
    expect(h.store.peek(change.id)?.status).toBe("applied"); // TRUTHFUL
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(APPROVED_TITLE);
    expect(h.alerts).toHaveLength(0);

    const retried = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(retried.action).toBe("auto_reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    expect(h.alerts).toHaveLength(1);
  });

  it("execute-mode revert rate-limited (429): auto_revert_failed with rate_limited, honest status; retry after the limit lifts completes", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(429, "RATE_LIMIT_EXCEEDED");
    const failed = await h.manager.monitor(change.id, [signal("traffic", -50)], CTX);
    expect(failed.action).toBe("auto_revert_failed");
    if (!isWriteMethodError(failed.error)) {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(failed.error.code).toBe("rate_limited");
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.alerts).toHaveLength(0);

    const retried = await h.manager.monitor(change.id, [signal("traffic", -50)], CTX);
    expect(retried.action).toBe("auto_reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_TITLE);
  });

  it("execute-mode revert against a DELETED item reports auto_revert_failed honestly — never 'auto_reverted'", async () => {
    const h = harness({
      seed: itemSeed(ORIGINAL_VALUE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyDataChange(h);
    h.fake.removeItem(COLLECTION_ID, ITEM_ID);

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("traffic", -80)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_revert_failed");
    if (!isWriteMethodError(evaluation.error)) {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(evaluation.error.code).toBe("target_missing");
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.alerts).toHaveLength(0);
  });

  it("auto-rollback never fires twice: a terminal auto_reverted row evaluates to 'none'", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    await h.manager.monitor(change.id, [signal("traffic", -60)], CTX);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    const writes = writeRequests(h.fake).length;

    const again = await h.manager.monitor(change.id, [signal("traffic", -60)], CTX);
    expect(again.action).toBe("none");
    expect(writeRequests(h.fake)).toHaveLength(writes);
    expect(h.alerts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Partial batch — mixed page+data, MIDDLE member fails             */
/* ------------------------------------------------------------------ */

const BATCH_P1_ORIGINAL = "Page One — original title";
const BATCH_ITEM_ORIGINAL = "Item — original value 🚀";
const BATCH_P3_ORIGINAL = "Page Two — original title";

function batchSeed(): Omit<FakeWixSeed, "apiKey" | "siteId"> {
  return {
    pages: {
      [PAGE_ID]: {
        name: "QA Listings",
        seoData: { title: BATCH_P1_ORIGINAL, description: SIBLING_SEO_DESC },
      },
      [PAGE2_ID]: {
        name: "QA About",
        seoData: { title: BATCH_P3_ORIGINAL, description: SIBLING_SEO_DESC },
      },
    },
    collections: itemSeed(BATCH_ITEM_ORIGINAL).collections,
  };
}

function batchMembers(itemAfter: string): DesiredChange[] {
  return [
    desired(
      { changeType: "title", locator: wixLocators.pageSeoTitle(PAGE_ID) },
      BATCH_P1_ORIGINAL,
      "Page One | Approved",
    ),
    desired(
      { changeType: "content", locator: DATA_SPEC.locator },
      BATCH_ITEM_ORIGINAL,
      itemAfter,
    ),
    desired(
      { changeType: "title", locator: wixLocators.pageSeoTitle(PAGE2_ID) },
      BATCH_P3_ORIGINAL,
      "Page Two | Approved",
    ),
  ];
}

describe("QA gate 6 — partial batch: the MIDDLE member fails, prefix accounting is exact", () => {
  it("mixed page+data batch, the middle (data) member 429s ON ITS PUT: exact prefix accounting, tail never requested, applied prefix rolls back byte-exact", async () => {
    const h = harness({
      seed: batchSeed(),
      // The batch's only PUT belongs to the middle (data) member — rate-limit
      // it; the page PATCHes pass through untouched.
      wrapPort: (port) => async (url, init) => {
        if (init.method === "PUT") {
          return jsonResponse(429, wixErrorBody("RATE_LIMIT_EXCEEDED"), {
            "retry-after": "7",
          });
        }
        return port(url, init);
      },
    });

    const batch = await h.manager.previewBatch(batchMembers("Item | Approved"), CTX);
    const [m1, m2, m3] = batch.members.map((m) => m.change.id);
    const report = await h.manager.applyBatch(batch, APPROVAL, CTX);

    // EXACT accounting: applied prefix / failed member / untouched tail.
    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([m1]);
    expect(report.failed?.changeId).toBe(m2);
    if (!isWriteMethodError(report.failed?.error)) {
      throw new Error("expected the failed member to carry a WriteMethodError");
    }
    expect(report.failed.error.code).toBe("rate_limited");
    expect(report.failed.error.retryAfterSeconds).toBe(7);
    expect(report.notAttempted).toEqual([m3]);

    // Statuses truthful for all three members.
    expect(h.store.peek(m1)?.status).toBe("applied");
    expect(h.store.peek(m2)?.status).toBe("previewed"); // 429: op did NOT happen
    expect(h.store.peek(m3)?.status).toBe("previewed");

    // The tail was NEVER attempted — no request even names page 2.
    expect(h.fake.requests.some((r) => r.url.includes(PAGE2_ID))).toBe(false);

    // The LIVE site matches the report exactly.
    expect(h.fake.page(PAGE_ID).seoData.title).toBe("Page One | Approved");
    expect(DATA_SPEC.read(h.fake)).toBe(BATCH_ITEM_ORIGINAL);
    expect(h.fake.page(PAGE2_ID).seoData.title).toBe(BATCH_P3_ORIGINAL);

    // The applied prefix rolls back byte-exact through the same adapter.
    const reverted = await h.manager.rollback(
      m1,
      { reason: "qa: batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.store.peek(m2)?.status).toBe("previewed");
    expect(h.store.peek(m3)?.status).toBe("previewed");
  });

  it("the SAME batch re-run after the limit lifts completes: prefix reported previouslyApplied, remaining members apply, then every member rolls back byte-exact", async () => {
    let limited = true;
    const h = harness({
      seed: batchSeed(),
      wrapPort: (port) => async (url, init) => {
        if (limited && init.method === "PUT") {
          return jsonResponse(429, wixErrorBody("RATE_LIMIT_EXCEEDED"));
        }
        return port(url, init);
      },
    });

    const batch = await h.manager.previewBatch(batchMembers("Item | Approved"), CTX);
    const [m1, m2, m3] = batch.members.map((m) => m.change.id);
    const first = await h.manager.applyBatch(batch, APPROVAL, CTX);
    expect(first.complete).toBe(false);
    expect(first.failed?.changeId).toBe(m2);

    // The rate-limit window passes; the SAME batch action re-runs.
    limited = false;
    const second = await h.manager.applyBatch(batch, APPROVAL, CTX);
    expect(second.complete).toBe(true);
    expect(second.previouslyApplied).toEqual([m1]); // never re-applied
    expect(second.applied.map((a) => a.change.id)).toEqual([m2, m3]);
    expect(second.failed).toBeUndefined();
    expect(second.notAttempted).toEqual([]);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe("Page One | Approved");
    expect(DATA_SPEC.read(h.fake)).toBe("Item | Approved");
    expect(h.fake.page(PAGE2_ID).seoData.title).toBe("Page Two | Approved");

    // Every member is individually revertible, byte-exact, live-immediate.
    for (const [id, reason] of [
      [m1, "qa: revert member 1"],
      [m2, "qa: revert member 2"],
      [m3, "qa: revert member 3"],
    ] as const) {
      const reverted = await h.manager.rollback(id, { reason }, CTX);
      expect(reverted.change.status).toBe("reverted");
    }
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(BATCH_P1_ORIGINAL);
    expect(DATA_SPEC.read(h.fake)).toBe(BATCH_ITEM_ORIGINAL);
    expect(h.fake.page(PAGE2_ID).seoData.title).toBe(BATCH_P3_ORIGINAL);
    expect(DATA_SPEC.collateral(h.fake)).toEqual(DATA_SPEC.collateralExpected);
    expectPinnedTraffic(h.fake);
  });

  it("middle member fails WRITE VERIFICATION (server strips a zero-width space): exact accounting, the honest mess surfaced, prefix rolls back byte-exact", async () => {
    const h = harness({ seed: batchSeed() });
    // The vendor strips zero-width spaces on write; ONLY member 2's approved
    // value carries one, so members 1 and 3 are unaffected.
    h.fake.mutateWrites((v) => v.replace(/\u200B/g, ""));
    const itemAfterWithZwsp = "Item |\u200B Approved";

    const batch = await h.manager.previewBatch(batchMembers(itemAfterWithZwsp), CTX);
    const [m1, m2, m3] = batch.members.map((m) => m.change.id);
    const report = await h.manager.applyBatch(batch, APPROVAL, CTX);

    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([m1]);
    expect(report.failed?.changeId).toBe(m2);
    if (!isWriteMethodError(report.failed?.error)) {
      throw new Error("expected the failed member to carry a WriteMethodError");
    }
    expect(report.failed.error.code).toBe("write_verification_failed");
    expect(report.notAttempted).toEqual([m3]);

    // Truthful statuses: m2 never claimed applied, though the LIVE item now
    // holds the stripped variant — the honest mess is surfaced, not hidden.
    expect(h.store.peek(m1)?.status).toBe("applied");
    expect(h.store.peek(m2)?.status).toBe("previewed");
    expect(h.store.peek(m3)?.status).toBe("previewed");
    expect(DATA_SPEC.read(h.fake)).toBe("Item | Approved"); // ZWSP stripped, live
    expect(h.fake.requests.some((r) => r.url.includes(PAGE2_ID))).toBe(false);

    // The applied prefix rolls back byte-exact (its values carry no ZWSP, so
    // the still-active normalization cannot corrupt the restore).
    await h.manager.rollback(
      m1,
      { reason: "qa: batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(h.fake.page(PAGE_ID).seoData.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.store.peek(m1)?.status).toBe("reverted");
  });
});

/* ------------------------------------------------------------------ */
/* 7. No-silent-failure sweep — every branch surfaces a typed error     */
/* ------------------------------------------------------------------ */

function scriptedAdapter(handler: Parameters<ScriptedFetch["on"]>[2]) {
  const scripted = new ScriptedFetch().on("*", /./, handler);
  return new WixAdapter({
    site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId: SITE_ID },
    secrets: { resolve: async () => new VendorCredential(SECRET) },
    authRef: "vault://wix/prop-1",
    fetch: scripted.port,
  });
}

const ADAPTER_CTX = { tenantId: "t1", clientId: "c1", propertyId: "prop-1" };

describe("QA gate 7 — no-silent-failure sweep of the adapter's branches", () => {
  const MALFORMED_CASES: ReadonlyArray<{
    label: string;
    locator: string;
    respond: Parameters<ScriptedFetch["on"]>[2];
    code: WriteMethodErrorCode;
    msgPart: string;
  }> = [
    {
      label: "JSON scalar where an entity was promised",
      locator: PAGE_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, "ok"),
      code: "unexpected_response",
      msgPart: "not an object",
    },
    {
      label: "payload without a page object",
      locator: PAGE_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, { id: PAGE_ID }),
      code: "unexpected_response",
      msgPart: "no page object",
    },
    {
      label: "page without a seoData object",
      locator: PAGE_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, { page: { id: PAGE_ID, name: "x" } }),
      code: "unexpected_response",
      msgPart: "no seoData object",
    },
    {
      label: "page whose seoData is an array",
      locator: PAGE_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, { page: { id: PAGE_ID, seoData: ["x"] } }),
      code: "unexpected_response",
      msgPart: "no seoData object",
    },
    {
      label: "payload without a dataItem object",
      locator: DATA_SPEC.locator,
      respond: () => jsonResponse(200, { id: ITEM_ID }),
      code: "unexpected_response",
      msgPart: "no dataItem object",
    },
    {
      label: "dataItem without a data object",
      locator: DATA_SPEC.locator,
      respond: () => jsonResponse(200, { dataItem: { id: ITEM_ID } }),
      code: "unexpected_response",
      msgPart: "no dataItem.data object",
    },
    {
      label: "dataItem whose data is an array",
      locator: DATA_SPEC.locator,
      respond: () => jsonResponse(200, { dataItem: { data: ["x"] } }),
      code: "unexpected_response",
      msgPart: "no dataItem.data object",
    },
    {
      label: "non-JSON garbage where the API was promised",
      locator: PAGE_TITLE_SPEC.locator,
      respond: () => textResponse(200, "PROXY ERROR :: upstream sadness"),
      code: "unexpected_response",
      msgPart: "not valid JSON",
    },
  ];

  it.each(MALFORMED_CASES)(
    "$label → typed '$code', coordinates named, nothing swallowed",
    async ({ locator, respond, code, msgPart }) => {
      const adapter = scriptedAdapter(respond);
      const err = await expectFailure(
        adapter.readCurrent(
          { url: "https://qa-client.example/listings", locator },
          ADAPTER_CTX,
        ),
        code,
      );
      expect(err.message).toContain(msgPart);
      expect(err.message).not.toContain(SECRET);
      // The vendor body's free text never leaks into the interface voice.
      expect(err.message).not.toContain("upstream sadness");
    },
  );

  it("an echo that silently DROPS the written target field is write_verification_failed — never a false success", async () => {
    // The pipeline cannot script an echo shape, so this drives the adapter
    // directly: fresh read shows the field set; the PUT echo omits it.
    const adapter = scriptedAdapter((req) =>
      req.method === "GET"
        ? jsonResponse(200, {
            dataItem: { data: { _id: ITEM_ID, [TARGET_FIELD]: "old", name: "x" } },
          })
        : jsonResponse(200, { dataItem: { data: { _id: ITEM_ID, name: "x" } } }),
    );
    const err = await expectFailure(
      adapter.apply({
        target: { url: "https://qa-client.example/x", locator: DATA_SPEC.locator },
        before: "old",
        after: "new",
        ctx: ADAPTER_CTX,
      }),
      "write_verification_failed",
    );
    expect(err.message).toContain("stored a different value");
  });

  it("vendor_failure carries ONLY status + sanitized slug — nested envelope code extracted, free text and injection shapes dropped", async () => {
    // Nested applicationError code (the real Wix envelope) survives...
    const nested = scriptedAdapter(() =>
      jsonResponse(500, wixErrorBody("WDE0053_INTERNAL")),
    );
    const err1 = await expectFailure(
      nested.readCurrent(
        { url: "https://qa-client.example/x", locator: DATA_SPEC.locator },
        ADAPTER_CTX,
      ),
      "vendor_failure",
    );
    expect(err1.vendorCode).toBe("WDE0053_INTERNAL");
    expect(err1.message).toContain("WDE0053_INTERNAL");
    expect(err1.message).not.toContain("See the application error");

    // ...a non-string / injection-shaped code is dropped, not echoed...
    for (const code of [
      123,
      "with spaces <script>alert(1)</script>",
      { evil: true },
    ] as Json[]) {
      const adapter = scriptedAdapter(() =>
        jsonResponse(500, { message: "boom", details: { applicationError: { code } } }),
      );
      const err = await expectFailure(
        adapter.readCurrent(
          { url: "https://qa-client.example/x", locator: DATA_SPEC.locator },
          ADAPTER_CTX,
        ),
        "vendor_failure",
      );
      expect(err.vendorCode).toBeUndefined();
      expect(err.message).not.toContain("script");
      expect(err.message).not.toContain("boom");
    }

    // ...and an array/scalar error body never crashes the sanitizer.
    const weird = scriptedAdapter(() => jsonResponse(502, ["bad", "gateway"]));
    const err2 = await expectFailure(
      weird.readCurrent(
        { url: "https://qa-client.example/x", locator: PAGE_TITLE_SPEC.locator },
        ADAPTER_CTX,
      ),
      "vendor_failure",
    );
    expect(err2.vendorCode).toBeUndefined();
    expect(err2.httpStatus).toBe(502);
  });

  it("misconfiguration is refused LOUDLY at construction — every hostile base URL and site id, never echoed, zero requests", () => {
    const secrets: SecretsResolver = {
      resolve: async () => new VendorCredential(SECRET),
    };
    const fake = new FakeWix({ apiKey: SECRET, siteId: SITE_ID });
    const HOSTILE_BASE_URLS = [
      "http://www.wixapis.com", // cleartext
      "https://evil.example", // foreign host
      "https://www.wixapis.com.evil.example", // suffix confusion
      "https://www.wixapis.com:8443", // port
      "https://www.wixapis.com/proxy", // path
      `https://www.wixapis.com?token=${SECRET}`, // query-embedded secret
      `https://user:${SECRET}@www.wixapis.com`, // userinfo-embedded secret
      "not a url at all", // unparseable
    ];
    for (const apiBaseUrl of HOSTILE_BASE_URLS) {
      let thrown: unknown = null;
      try {
        new WixAdapter({
          site: {
            tenantId: "t1",
            clientId: "c1",
            propertyId: "prop-1",
            siteId: SITE_ID,
          },
          secrets,
          authRef: "vault://wix/prop-1",
          fetch: fake.port,
          apiBaseUrl,
        });
      } catch (err) {
        thrown = err;
      }
      if (!isWriteMethodError(thrown)) {
        throw new Error(
          `expected a loud WriteMethodError at construction for base URL case: ${apiBaseUrl}`,
        );
      }
      expect(thrown.code).toBe("misconfigured");
      // Refuse WITHOUT echo: neither the URL nor the secret it may embed.
      expect(thrown.message).not.toContain(SECRET);
      expect(thrown.message).not.toContain("evil.example");
      expect(thrown.message).not.toContain("8443");
      expect(thrown.message).toContain("not echoed");
    }

    for (const siteId of [
      "NOT-A-GUID",
      SITE_ID.toUpperCase(), // uppercase GUID — not the canonical form
      `{${SITE_ID}}`, // braced GUID
      "", // empty
    ]) {
      let thrown: unknown = null;
      try {
        new WixAdapter({
          site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId },
          secrets,
          authRef: "vault://wix/prop-1",
          fetch: fake.port,
        });
      } catch (err) {
        thrown = err;
      }
      if (!isWriteMethodError(thrown)) {
        throw new Error(`expected a loud WriteMethodError for site id: ${siteId}`);
      }
      expect(thrown.code).toBe("misconfigured");
      expect(thrown.message).not.toContain(siteId || "??");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("the ONLY accepted base URLs are the pinned host itself (with or without a trailing slash)", () => {
    const secrets: SecretsResolver = {
      resolve: async () => new VendorCredential(SECRET),
    };
    const fake = new FakeWix({ apiKey: SECRET, siteId: SITE_ID });
    for (const apiBaseUrl of [undefined, WIX_API_HOST, `${WIX_API_HOST}/`]) {
      const adapter = new WixAdapter({
        site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId: SITE_ID },
        secrets,
        authRef: "vault://wix/prop-1",
        fetch: fake.port,
        apiBaseUrl,
      });
      expect(adapter.method).toBe("wix");
    }
  });

  it("every irreversible/unrepresentable locator is refused at PLAN time with ZERO HTTP — even from a persisted preview row", async () => {
    const REFUSED_LOCATORS: ReadonlyArray<{ label: string; locator?: string }> = [
      { label: "missing locator", locator: undefined },
      { label: "page uri (URL-changing)", locator: `wix:page/${PAGE_ID}/uri` },
      { label: "page rename", locator: `wix:page/${PAGE_ID}/name` },
      {
        label: "noIndex flag (indexing state machine)",
        locator: `wix:page/${PAGE_ID}/seo.noIndex`,
      },
      {
        label: "uppercase attr alias (seo.Title)",
        locator: `wix:page/${PAGE_ID}/seo.Title`,
      },
      {
        label: "structured-data tag list",
        locator: `wix:page/${PAGE_ID}/seo.tags`,
      },
      {
        label: "publish-shaped locator (no publish exists on this method)",
        locator: `wix:site/${SITE_ID}/publish`,
      },
      {
        label: "system field (underscore namespace)",
        locator: `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_updatedDate`,
      },
      {
        label: "app collection (slash-namespaced)",
        locator: `wix:data/Stores/Products/${ITEM_ID}/field/price`,
      },
      {
        label: "hyphenated field key (outside the field grammar)",
        locator: `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/bad-key`,
      },
      {
        label: "path smuggling",
        locator: `wix:page/../${PAGE_ID}/seo.title`,
      },
      {
        label: "item creation (no before-state exists)",
        locator: `wix:data/${COLLECTION_ID}/new/create`,
      },
      {
        label: "collection id starting with a digit",
        locator: `wix:data/1col/${ITEM_ID}/field/summary`,
      },
      {
        label: "empty field key",
        locator: `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/`,
      },
    ];

    const h = harness({
      seed: { ...pageSeed({ seoTitle: "Original" }), ...itemSeed("Original") },
    });
    for (const { label, locator } of REFUSED_LOCATORS) {
      const preview = await h.manager.preview(
        desired({ changeType: "content", locator }, "old", "new"),
        CTX,
      );
      await expectFailure(
        h.manager.apply(preview.change.id, APPROVAL, CTX),
        "unsupported_operation",
      );
      expect(
        h.store.peek(preview.change.id)?.status,
        `refused locator must leave its row previewed: ${label}`,
      ).toBe("previewed");
    }
    // Not one of them produced a single HTTP request.
    expect(h.fake.requests).toHaveLength(0);
    expect(h.fake.page(PAGE_ID).seoData.title).toBe("Original");
    expect(DATA_SPEC.read(h.fake)).toBe("Original");
  });

  it("a credential-bearing or unparseable TARGET URL is refused pre-network, through the pipeline, without echoing it", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: "Original" }) });
    for (const url of [
      `https://qa:${SECRET}@client.example/listings`,
      "http://[unparseable",
    ]) {
      const preview = await h.manager.preview(
        {
          ...desired(PAGE_TITLE_SPEC, "Original", "New"),
          target: { url, locator: PAGE_TITLE_SPEC.locator },
        },
        CTX,
      );
      const err = await expectFailure(
        h.manager.apply(preview.change.id, APPROVAL, CTX),
        "unsupported_operation",
      );
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("client.example");
      expect(err.message).not.toContain("unparseable");
      expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    }
    expect(h.fake.requests).toHaveLength(0);
  });

  it("a change routed for a DIFFERENT property is refused (property_mismatch) with ZERO HTTP — the pin is checked before any request", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: "Original" }) });
    const preview = await h.manager.preview(
      desired(
        {
          changeType: "title",
          locator: PAGE_TITLE_SPEC.locator,
          propertyId: "prop-2",
        },
        "Original",
        "New",
      ),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "property_mismatch",
    );
    expect(h.fake.requests).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("an adapter pinned to a FOREIGN site cannot see this site's content: the wix-site-id header scopes every call, and the miss is an honest target_missing", async () => {
    const fake = new FakeWix({
      apiKey: SECRET,
      siteId: SITE_ID,
      ...pageSeed({ seoTitle: "Original" }),
    });
    const adapter = new WixAdapter({
      site: {
        tenantId: "t1",
        clientId: "c1",
        propertyId: "prop-1",
        siteId: FOREIGN_SITE_ID, // valid GUID, wrong site
      },
      secrets: { resolve: async () => new VendorCredential(SECRET) },
      authRef: "vault://wix/prop-1",
      fetch: fake.port,
    });
    const err = await expectFailure(
      adapter.readCurrent(
        { url: "https://qa-client.example/listings", locator: PAGE_TITLE_SPEC.locator },
        ADAPTER_CTX,
      ),
      "target_missing",
    );
    expect(err.vendorCode).toBe("SITE_NOT_FOUND");
    expect(err.message).toContain("pinned site");
    // The request went out scoped to the FOREIGN pin — never the fake's site.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers["wix-site-id"]).toBe(FOREIGN_SITE_ID);
    // And nothing on the real site moved.
    expect(fake.page(PAGE_ID).seoData.title).toBe("Original");
  });

  it("403 is credential_rejected (permissions, not identity) and 404 within the pinned scope is target_missing — statuses never conflated", async () => {
    const h403 = harness({ seed: pageSeed({ seoTitle: "Original" }) });
    h403.fake.failNextWith(403, "FORBIDDEN");
    const preview = await h403.manager.preview(
      desired(PAGE_TITLE_SPEC, "Original", "New"),
      CTX,
    );
    const err = await expectFailure(
      h403.manager.apply(preview.change.id, APPROVAL, CTX),
      "credential_rejected",
    );
    expect(err.httpStatus).toBe(403);
    expect(h403.store.peek(preview.change.id)?.status).toBe("previewed");

    const h404 = harness(); // no pages seeded at all
    const preview404 = await h404.manager.preview(
      desired(PAGE_TITLE_SPEC, "Original", "New"),
      CTX,
    );
    const err404 = await expectFailure(
      h404.manager.apply(preview404.change.id, APPROVAL, CTX),
      "target_missing",
    );
    expect(err404.httpStatus).toBe(404);
    expect(err404.vendorCode).toBe("PAGE_NOT_FOUND");
  });
});
