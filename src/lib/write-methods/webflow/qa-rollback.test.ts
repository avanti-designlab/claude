/**
 * QA ROLLBACK GATE — independent adversarial verification of the WEBFLOW
 * write method (method 2/4) against the change-management rollback contract
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
 *     exposes (page seo.title / seo.description / og.title / og.description ×
 *     item field) and for edge value shapes (empty string, unicode/emoji/ZWJ/
 *     RTL, HTML entities kept literal, markup + control whitespace, NFD
 *     non-normalization, ~64 KiB strings; for item fields additionally every
 *     JSON type the adapter accepts — numbers, booleans, arrays, nested
 *     objects): preview → apply → verify stored → rollback → the STAGED site
 *     is BYTE-EXACT the original capture, siblings untouched. A completeness
 *     pin ties the tested kinds to the grammar so a new locator kind fails
 *     this suite until it is covered.
 *  2. THE STAGED/PUBLISHED BOUNDARY — this method's core safety claim: apply,
 *     revert, partial batch, and auto-rollback never touch the PUBLISHED
 *     snapshot and never emit publish traffic (proven by a positive route
 *     whitelist, not just a publish blacklist). Includes the unpublished-
 *     drift case: when the published state already differs from staged, a
 *     rollback restores the ORIGINAL STAGED capture — never the published
 *     value, and never by publishing.
 *  3. ROLLBACK UNDER ADVERSITY — item deleted after apply; token rotated
 *     mid-revert (401); server-side normalization on revert (the slug-class
 *     divergence); 429 mid-apply and mid-revert (truthful status, retry
 *     completes once the limit lifts); the OG mirror flag flipped between
 *     capture and apply AND inside the write window itself; network failure;
 *     HTML interstitial; and the QA-1 crash-window scenarios (DB crash after
 *     the site write → resumed_after_partial_apply keeps the original
 *     baseline; double-crash loop) re-verified through THIS adapter. In every
 *     case the row status stays TRUTHFUL — 'reverted' is never recorded
 *     without byte-exact proof.
 *  4. AUTO-ROLLBACK INTEGRATION — off / flag / execute through this adapter;
 *     execute auto-reverts byte-exact and staged-only; threshold boundary;
 *     failed auto-revert honest; no double fire.
 *  5. PARTIAL BATCH — a mixed page+item batch whose MIDDLE member fails (429,
 *     and separately a write-verification failure): exact prefix accounting,
 *     later members never requested, the applied prefix rolls back byte-exact,
 *     and a batch retry completes once the limit lifts.
 *  6. NO-SILENT-FAILURE SWEEP — every response-shape branch and catch in the
 *     adapter surfaces a typed error (nothing swallowed, nothing defaulted),
 *     and every grammar refusal happens at plan time with ZERO HTTP.
 *
 * All HTTP is the injected FakeWebflow (ScriptedFetch) — zero live network.
 */

import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  steppingClock,
  type AlertDraft,
  type AlertSink,
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
import { bearerAuthHeader, type FetchPort } from "../shared/http";
import {
  jsonResponse,
  ScriptedFetch,
  textResponse,
} from "../shared/http-harness";
import { WebflowAdapter } from "./adapter";
import { FakeWebflow, type FakeWebflowSeed } from "./fake-webflow";
import { webflowLocators } from "./target";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const SECRET = "wf-pat-Qa5ecret.Adversaria1.T0ken";
const API = "https://api.webflow.com/v2";

const wfid = (tail: string) => tail.padStart(24, "0");
const SITE_ID = wfid("5eed");
const PAGE_ID = wfid("9a01");
const PAGE2_ID = wfid("9a02");
const COLLECTION_ID = wfid("c001");
const ITEM_ID = wfid("11e1");

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-qa", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

/** Sentinel sibling values — collateral-damage detection on every round-trip. */
const SIBLING_SEO_TITLE = "sibling seo.title (must never change)";
const SIBLING_SEO_DESC = "sibling seo.description (must never change)";
const SIBLING_OG_TITLE = "sibling og.title (must never change)";
const SIBLING_OG_DESC = "sibling og.description (must never change)";
const TARGET_FIELD = "qa-target";
const SIBLING_FIELD = "qa-sibling";
const SIBLING_FIELD_VALUE = "sibling item field (must never change)";

/**
 * An InMemoryChangeStore whose NEXT update() throws AFTER the site write has
 * already happened — the crash window the manager's ordering comments reason
 * about. Test-only subclass; adapter and pipeline source untouched.
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
  fake: FakeWebflow;
  manager: ChangeManager;
  store: InMemoryChangeStore;
  alerts: AlertDraft[];
  rotateSecret(next: string): void;
}

function harness(opts?: {
  seed?: Omit<FakeWebflowSeed, "token" | "siteId">;
  policy?: AutoRollbackPolicy;
  alertSink?: AlertSink;
  store?: InMemoryChangeStore;
  /** Wrap the fake's port — mid-flight fault injection between requests. */
  wrapPort?: (port: FetchPort, fake: FakeWebflow) => FetchPort;
}): Harness {
  const fake = new FakeWebflow({
    token: SECRET,
    siteId: SITE_ID,
    ...(opts?.seed ?? {}),
  });
  let vaultValue = SECRET;
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(vaultValue),
  };
  const adapter = new WebflowAdapter({
    site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId: SITE_ID },
    secrets,
    authRef: "vault://webflow/prop-1",
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
    alertSink: opts?.alertSink ?? { emit: (a) => void alerts.push(a) },
  });
  return {
    fake,
    manager,
    store,
    alerts,
    rotateSecret: (next) => {
      vaultValue = next;
    },
  };
}

function desired(
  spec: { changeType: SiteChangeType; locator?: string },
  before: Json,
  after: Json,
): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "webflow",
    changeType: spec.changeType,
    target: { url: "https://qa-client.example/listings", locator: spec.locator },
    before,
    after,
  };
}

function patchRequests(fake: FakeWebflow) {
  return fake.requests.filter((r) => r.method === "PATCH");
}

/**
 * The POSITIVE staged-only traffic contract: every request this method emits
 * is one of the three content routes (page metadata, the pinned site's own
 * collection list, one item) — never a publish, never `/items/{id}/live`,
 * never anything else. A whitelist is stronger than a publish blacklist: a
 * new endpoint fails this suite until it is reviewed.
 */
const ALLOWED_ROUTES = [
  /^https:\/\/api\.webflow\.com\/v2\/pages\/[0-9a-f]{24}$/,
  new RegExp(`^https://api\\.webflow\\.com/v2/sites/${SITE_ID}/collections$`),
  /^https:\/\/api\.webflow\.com\/v2\/collections\/[0-9a-f]{24}\/items\/[0-9a-f]{24}$/,
];

function expectStagedOnlyTraffic(fake: FakeWebflow): void {
  for (const req of fake.requests) {
    expect(req.url).not.toContain("publish");
    expect(req.url).not.toMatch(/\/live(\?|$)/);
    expect(["GET", "PATCH"]).toContain(req.method);
    expect(
      ALLOWED_ROUTES.some((route) => route.test(req.url)),
      `request escaped the staged content-route whitelist: ${req.method} ${req.url}`,
    ).toBe(true);
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
  expect(thrown.method).toBe("webflow");
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

/**
 * Model the SITE OWNER editing staged content out-of-band (Designer edit,
 * never published) — a plain authenticated PATCH through the fake's own API
 * surface, exactly what the Designer's save produces. Journaled like any
 * request; tests slice the journal after calling this.
 */
async function ownerStagedEdit(
  fake: FakeWebflow,
  route: string,
  body: Json,
): Promise<void> {
  const res = await fake.port(`${API}/${route}`, {
    method: "PATCH",
    headers: {
      accept: "application/json",
      authorization: bearerAuthHeader(SECRET),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (res.status !== 200) {
    throw new Error(`qa harness: owner staged edit failed (HTTP ${res.status})`);
  }
}

/**
 * Model the site owner toggling a page's OG mirror ("same as SEO field") in
 * the Designer between our calls. FakeWebflow exposes no toggle, so this
 * reaches into its private staged store at runtime — QA-harness reach-in
 * only; adapter and fake source stay untouched.
 */
function setMirror(
  fake: FakeWebflow,
  pageId: string,
  attr: "title" | "description",
  on: boolean,
): void {
  const pages = (
    fake as unknown as {
      pages: Map<
        string,
        { og: { titleCopied: boolean; descriptionCopied: boolean } }
      >;
    }
  ).pages;
  const page = pages.get(pageId);
  if (!page) throw new Error(`qa harness: no staged page ${pageId}`);
  if (attr === "title") page.og.titleCopied = on;
  else page.og.descriptionCopied = on;
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

/** One fully-populated page: all four fields set, BOTH mirror flags explicitly
 * OFF — every field independently writable and restorable. */
function pageEntry(
  overrides: Partial<{
    seoTitle: Json;
    seoDescription: Json;
    ogTitle: Json;
    ogDescription: Json;
  }> = {},
) {
  return {
    name: "QA Listings",
    seo: {
      title: (overrides.seoTitle ?? SIBLING_SEO_TITLE) as string,
      description: (overrides.seoDescription ?? SIBLING_SEO_DESC) as string,
    },
    openGraph: {
      title: (overrides.ogTitle ?? SIBLING_OG_TITLE) as string,
      description: (overrides.ogDescription ?? SIBLING_OG_DESC) as string,
      titleCopied: false,
      descriptionCopied: false,
    },
  };
}

function pageSeed(
  overrides: Parameters<typeof pageEntry>[0],
): Omit<FakeWebflowSeed, "token" | "siteId"> {
  return { pages: { [PAGE_ID]: pageEntry(overrides) } };
}

function itemSeed(value: Json): Omit<FakeWebflowSeed, "token" | "siteId"> {
  return {
    collections: {
      [COLLECTION_ID]: {
        fields: [TARGET_FIELD, SIBLING_FIELD],
        items: {
          [ITEM_ID]: {
            name: "Casa QA",
            slug: "casa-qa",
            [TARGET_FIELD]: value,
            [SIBLING_FIELD]: SIBLING_FIELD_VALUE,
          },
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
  domain: "page" | "item";
  changeType: SiteChangeType;
  locator: string;
  /** Pinned Data API route (relative to /v2) both writes must travel. */
  route: string;
  /** The EXACT single-field PATCH body a write of `value` must produce. */
  bodyFor(value: Json): Json;
  seed(value: Json): Omit<FakeWebflowSeed, "token" | "siteId">;
  /** STAGED value at the target. */
  read(fake: FakeWebflow): Json;
  /** Full PUBLISHED entity view — byte-identity asserted at every step. */
  live(fake: FakeWebflow): unknown;
  /** Fields the change must NOT touch — asserted identical after the cycle. */
  collateral(fake: FakeWebflow): Json;
  collateralExpected: Json;
}

function pageKind(
  group: "seo" | "og",
  attr: "title" | "description",
): KindSpec {
  const seedKey = (
    group === "seo"
      ? attr === "title"
        ? "seoTitle"
        : "seoDescription"
      : attr === "title"
        ? "ogTitle"
        : "ogDescription"
  ) as "seoTitle" | "seoDescription" | "ogTitle" | "ogDescription";
  const locator =
    group === "seo"
      ? attr === "title"
        ? webflowLocators.pageSeoTitle(PAGE_ID)
        : webflowLocators.pageSeoDescription(PAGE_ID)
      : attr === "title"
        ? webflowLocators.pageOgTitle(PAGE_ID)
        : webflowLocators.pageOgDescription(PAGE_ID);
  const groupKey = group === "seo" ? "seo" : "openGraph";
  const sentinels: Record<string, string> = {
    seoTitle: SIBLING_SEO_TITLE,
    seoDescription: SIBLING_SEO_DESC,
    ogTitle: SIBLING_OG_TITLE,
    ogDescription: SIBLING_OG_DESC,
  };
  const collateralKeys = (
    ["seoTitle", "seoDescription", "ogTitle", "ogDescription"] as const
  ).filter((k) => k !== seedKey);
  return {
    kind: `page/${group}.${attr}`,
    domain: "page",
    changeType: group === "seo" && attr === "title" ? "title" : "meta",
    locator,
    route: `pages/${PAGE_ID}`,
    bodyFor: (value) => ({ [groupKey]: { [attr]: value } }),
    seed: (value) => pageSeed({ [seedKey]: value }),
    read: (f) => {
      const page = f.page(PAGE_ID);
      return group === "seo" ? page.seo[attr] : page.openGraph[attr];
    },
    live: (f) => f.livePage(PAGE_ID),
    collateral: (f) => {
      const page = f.page(PAGE_ID);
      const view: Record<string, Json> = {
        seoTitle: page.seo.title,
        seoDescription: page.seo.description,
        ogTitle: page.openGraph.title,
        ogDescription: page.openGraph.description,
      };
      return Object.fromEntries(collateralKeys.map((k) => [k, view[k]]));
    },
    collateralExpected: Object.fromEntries(
      collateralKeys.map((k) => [k, sentinels[k]]),
    ),
  };
}

const KINDS: KindSpec[] = [
  pageKind("seo", "title"),
  pageKind("seo", "description"),
  pageKind("og", "title"),
  pageKind("og", "description"),
  {
    kind: "item/field",
    domain: "item",
    changeType: "content",
    locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, TARGET_FIELD),
    route: `collections/${COLLECTION_ID}/items/${ITEM_ID}`,
    bodyFor: (value) => ({ fieldData: { [TARGET_FIELD]: value } }),
    seed: (value) => itemSeed(value),
    read: (f) => f.item(COLLECTION_ID, ITEM_ID)[TARGET_FIELD],
    live: (f) => f.liveItem(COLLECTION_ID, ITEM_ID),
    collateral: (f) => {
      const item = f.item(COLLECTION_ID, ITEM_ID);
      return { name: item.name, slug: item.slug, sibling: item[SIBLING_FIELD] };
    },
    collateralExpected: {
      name: "Casa QA",
      slug: "casa-qa",
      sibling: SIBLING_FIELD_VALUE,
    },
  },
];

const PAGE_SEO_TITLE_SPEC = KINDS.find((k) => k.kind === "page/seo.title")!;
const PAGE_OG_TITLE_SPEC = KINDS.find((k) => k.kind === "page/og.title")!;
const ITEM_SPEC = KINDS.find((k) => k.kind === "item/field")!;

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

/** Every JSON type the item surface accepts (top-level null refused by design). */
const ITEM_SHAPES: ReadonlyArray<{ label: string; value: Json }> = [
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
const NEUTRAL_ITEM_BEFORE: Json = { qa: "neutral-original" };
const NEUTRAL_ITEM_AFTER: Json = { qa: "neutral-approved" };

/**
 * One full pipeline round-trip: preview → human-approved apply (assert the
 * STAGED site stored `after`, the PUBLISHED site is byte-untouched, and the
 * audit row captured `original`) → one-click rollback (assert the staged site
 * is byte-exact `original` again, published still untouched, collateral
 * fields identical, exactly two single-field PATCHes down the pinned route,
 * and zero traffic outside the staged content-route whitelist).
 */
async function runRoundTrip(spec: KindSpec, original: Json, after: Json) {
  const h = harness({ seed: spec.seed(original) });
  const publishedBefore = spec.live(h.fake);

  const preview = await h.manager.preview(desired(spec, original, after), CTX);
  expect(preview.change.status).toBe("previewed");
  expect(h.fake.requests).toHaveLength(0); // preview never touches the site

  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(applied.warnings).toEqual([]); // seeded live staged state matches preview
  expect(applied.change.status).toBe("applied");
  // Verify stored: the STAGED site now holds exactly the approved after-state.
  expect(spec.read(h.fake)).toEqual(after);
  // The audit row carries the byte-exact captured baseline.
  expect(applied.change.diff.before).toEqual(original);
  expect(applied.change.diff.after).toEqual(after);
  // The PUBLISHED site is byte-identical to before the apply.
  expect(spec.live(h.fake)).toEqual(publishedBefore);

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
  // The published site never moved in either direction.
  expect(spec.live(h.fake)).toEqual(publishedBefore);

  // Exactly two writes (apply + revert), both down the pinned route, each a
  // SINGLE-field body: after on the way in, the byte-exact original back out.
  const patches = patchRequests(h.fake);
  expect(patches).toHaveLength(2);
  for (const p of patches) {
    expect(p.url).toBe(`${API}/${spec.route}`);
  }
  expect(JSON.parse(patches[0].body ?? "")).toEqual(spec.bodyFor(after));
  expect(JSON.parse(patches[1].body ?? "")).toEqual(spec.bodyFor(original));
  expectStagedOnlyTraffic(h.fake);
}

describe("QA gate 1 — round-trip property across EVERY supported locator kind", () => {
  it("the QA matrix covers every locator kind the grammar exposes (completeness pin)", () => {
    // If a new locator builder ships, this fails until the matrix covers it.
    expect(Object.keys(webflowLocators).sort()).toEqual(
      [
        "itemField",
        "pageOgDescription",
        "pageOgTitle",
        "pageSeoDescription",
        "pageSeoTitle",
      ].sort(),
    );
    expect(KINDS.map((k) => k.kind).sort()).toEqual(
      [
        "item/field",
        "page/og.description",
        "page/og.title",
        "page/seo.description",
        "page/seo.title",
      ].sort(),
    );
    // And every builder's output is literally one of the tested locators.
    expect(KINDS.map((k) => k.locator).sort()).toEqual(
      [
        webflowLocators.pageSeoTitle(PAGE_ID),
        webflowLocators.pageSeoDescription(PAGE_ID),
        webflowLocators.pageOgTitle(PAGE_ID),
        webflowLocators.pageOgDescription(PAGE_ID),
        webflowLocators.itemField(COLLECTION_ID, ITEM_ID, TARGET_FIELD),
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

  describe("item/field — every accepted JSON type + string edge shapes", () => {
    it.each(ITEM_SHAPES)(
      `restores a "$label" ORIGINAL after rollback`,
      async ({ value }) => {
        await runRoundTrip(ITEM_SPEC, value, NEUTRAL_ITEM_AFTER);
      },
    );
    it.each(ITEM_SHAPES)(
      `installs a "$label" AFTER verifiably, then rolls back`,
      async ({ value }) => {
        await runRoundTrip(ITEM_SPEC, NEUTRAL_ITEM_BEFORE, value);
      },
    );
  });

  it("preserves the exact unicode normalization form on restore (NFD stays NFD) — page and item", async () => {
    const nfd = "Café menu".normalize("NFD"); // decomposed
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc); // the test is sensitive to the difference

    for (const spec of [PAGE_SEO_TITLE_SPEC, ITEM_SPEC]) {
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

  it("a stale null PREVIEWED before cannot poison the rollback baseline — re-baselined to the live staged capture, drift surfaced", async () => {
    const h = harness({ seed: itemSeed("live-staged-value") });
    const preview = await h.manager.preview(desired(ITEM_SPEC, null, "x"), CTX);

    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBe("live-staged-value");
    expect(ITEM_SPEC.read(h.fake)).toBe("x");

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(ITEM_SPEC.read(h.fake)).toBe("live-staged-value");
  });

  it("refuses a null page AFTER at plan time — the PATCH schema installs strings only", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: "Original" }) });
    const preview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, "Original", null),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(PAGE_SEO_TITLE_SPEC.read(h.fake)).toBe("Original");
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses a LIVE-unset page field at before-capture — a first-ever SEO field cannot round-trip to 'unset'", async () => {
    // seo.description never set on the page: live reads null → the change is
    // refused BEFORE any write, at capture time, not at rollback time.
    const h = harness({
      seed: {
        pages: {
          [PAGE_ID]: {
            name: "QA",
            seo: { title: "present" },
            openGraph: {
              title: SIBLING_OG_TITLE,
              description: SIBLING_OG_DESC,
              titleCopied: false,
              descriptionCopied: false,
            },
          },
        },
      },
    });
    const spec = KINDS.find((k) => k.kind === "page/seo.description")!;
    const preview = await h.manager.preview(desired(spec, "stale", "new"), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(err.message).toContain("unset");
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses a null item AFTER at plan time — clearing a field cannot round-trip", async () => {
    const h = harness({ seed: itemSeed("live-value") });
    const preview = await h.manager.preview(
      desired(ITEM_SPEC, "live-value", null),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(ITEM_SPEC.read(h.fake)).toBe("live-value");
  });

  it("refuses an item field ABSENT from fieldData at before-capture (never valued / undeclared) — target_missing, zero writes", async () => {
    const h = harness({
      seed: {
        collections: {
          [COLLECTION_ID]: {
            fields: [TARGET_FIELD, SIBLING_FIELD],
            items: {
              [ITEM_ID]: {
                name: "Casa QA",
                slug: "casa-qa",
                // TARGET_FIELD deliberately never valued.
                [SIBLING_FIELD]: SIBLING_FIELD_VALUE,
              },
            },
          },
        },
      },
    });
    const preview = await h.manager.preview(desired(ITEM_SPEC, "stale", "new"), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "target_missing",
    );
    expect(err.message).toContain(TARGET_FIELD);
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });
});

/* ------------------------------------------------------------------ */
/* 2. The staged/published boundary — the method's core safety claim   */
/* ------------------------------------------------------------------ */

describe("QA gate 2 — staged writes NEVER touch the published snapshot, never emit publish traffic", () => {
  it("UNPUBLISHED DRIFT (page): rollback restores the original STAGED capture — never the published value, never via a publish", async () => {
    const PUBLISHED = "Published Headline — live since last publish";
    const STAGED_DRAFT = "Owner's staged draft (never published) — café 🚀";
    const APPROVED = "AEO Optimized Title | QA";

    // The published snapshot is the state at last publish; the owner then
    // edits staged content WITHOUT publishing → published ≠ staged.
    const h = harness({ seed: pageSeed({ seoTitle: PUBLISHED }) });
    await ownerStagedEdit(h.fake, `pages/${PAGE_ID}`, {
      seo: { title: STAGED_DRAFT },
    });
    expect(h.fake.page(PAGE_ID).seo.title).toBe(STAGED_DRAFT);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(PUBLISHED); // model sanity
    const reqOffset = h.fake.requests.length;

    const preview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, STAGED_DRAFT, APPROVED),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings).toEqual([]);
    // The rollback baseline is the STAGED capture — not the published value.
    expect(applied.change.diff.before).toBe(STAGED_DRAFT);
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(PUBLISHED);

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    // Byte-exact to the STAGED capture, even though published differs.
    expect(h.fake.page(PAGE_ID).seo.title).toBe(STAGED_DRAFT);
    expect(h.fake.page(PAGE_ID).seo.title).not.toBe(PUBLISHED);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(PUBLISHED);

    for (const req of h.fake.requests.slice(reqOffset)) {
      expect(req.url).not.toContain("publish");
      expect(req.url).not.toMatch(/\/live(\?|$)/);
    }
    expectStagedOnlyTraffic(h.fake); // the owner edit itself is also a content route
  });

  it("UNPUBLISHED DRIFT (item): same proof through the Items API", async () => {
    const PUBLISHED: Json = { "@type": "FAQPage", rev: "published" };
    const STAGED_DRAFT: Json = { "@type": "FAQPage", rev: "staged-draft 🚀" };
    const APPROVED: Json = { "@type": "FAQPage", rev: "qa-approved" };

    const h = harness({ seed: itemSeed(PUBLISHED) });
    await ownerStagedEdit(h.fake, `collections/${COLLECTION_ID}/items/${ITEM_ID}`, {
      fieldData: { [TARGET_FIELD]: STAGED_DRAFT },
    });
    expect(ITEM_SPEC.read(h.fake)).toEqual(STAGED_DRAFT);
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toEqual(PUBLISHED);

    const preview = await h.manager.preview(
      desired(ITEM_SPEC, STAGED_DRAFT, APPROVED),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.change.diff.before).toEqual(STAGED_DRAFT);
    expect(ITEM_SPEC.read(h.fake)).toEqual(APPROVED);

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(ITEM_SPEC.read(h.fake)).toEqual(STAGED_DRAFT); // staged capture, not published
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toEqual(PUBLISHED);
    expectStagedOnlyTraffic(h.fake);
  });

  it("a full mixed lifecycle (apply page + item, execute-mode auto-rollback, manual rollback) stays on the content-route whitelist; published byte-identical throughout", async () => {
    const h = harness({
      seed: {
        ...pageSeed({ seoTitle: "Original Page Title" }),
        ...itemSeed("Original item value"),
      },
      policy: { mode: "execute", thresholds: { traffic: 25 } },
    });
    const publishedPage = h.fake.livePage(PAGE_ID);
    const publishedItem = h.fake.liveItem(COLLECTION_ID, ITEM_ID);

    const pagePreview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, "Original Page Title", "New Page Title"),
      CTX,
    );
    const itemPreview = await h.manager.preview(
      desired(ITEM_SPEC, "Original item value", "New item value"),
      CTX,
    );
    const pageApplied = await h.manager.apply(pagePreview.change.id, APPROVAL, CTX);
    const itemApplied = await h.manager.apply(itemPreview.change.id, APPROVAL, CTX);

    // Auto-rollback (execute) reverts the page change; manual reverts the item.
    const evaluation = await h.manager.monitor(
      pageApplied.change.id,
      [signal("traffic", -60)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_reverted");
    await h.manager.rollback(itemApplied.change.id, { reason: "qa: undo" }, CTX);

    expect(h.fake.page(PAGE_ID).seo.title).toBe("Original Page Title");
    expect(ITEM_SPEC.read(h.fake)).toBe("Original item value");
    // Published snapshots byte-identical after the whole lifecycle...
    expect(h.fake.livePage(PAGE_ID)).toEqual(publishedPage);
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)).toEqual(publishedItem);
    // ...and not one request left the staged content-route whitelist.
    expectStagedOnlyTraffic(h.fake);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Rollback under adversity — statuses stay TRUTHFUL                */
/* ------------------------------------------------------------------ */

const ORIGINAL_TITLE = "Original título — café 🚀";
const APPROVED_TITLE = "Approved Title | QA";

async function applyTitleChange(h: Harness) {
  const preview = await h.manager.preview(
    desired(PAGE_SEO_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
    CTX,
  );
  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);
  return applied.change;
}

describe("QA gate 3 — rollback under adversity (row status stays TRUTHFUL)", () => {
  it("item deleted after apply: revert fails target_missing, row STAYS applied, never a false 'reverted'; retry stays honest", async () => {
    const h = harness({ seed: itemSeed("Original summary") });
    const preview = await h.manager.preview(
      desired(ITEM_SPEC, "Original summary", "Approved summary"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);

    h.fake.removeItem(COLLECTION_ID, ITEM_ID);
    await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: regressed" }, CTX),
      "target_missing",
    );
    const row = h.store.peek(applied.change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(row?.reverted_reason).toBeNull();

    await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: retry" }, CTX),
      "target_missing",
    );
    expect(h.store.peek(applied.change.id)?.status).toBe("applied");
    // The published item never moved (removeItem is staged-only in the model).
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toBe(
      "Original summary",
    );
  });

  it("token rotated mid-revert (401): row stays applied, no credential in the error; reconnect + retry completes byte-exact", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.rotateToken("wf-pat-rotated-away");
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "credential_rejected",
    );
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain(SECRET);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE); // untouched by the failed revert

    h.fake.rotateToken(SECRET); // property reconnected
    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });

  it("server-side normalization on revert (the slug-class divergence): write_verification_failed, row stays applied — honest mess surfaced; fixed retry restores byte-exact", async () => {
    const original = "Casa Uno:  a summary with  odd spacing";
    const h = harness({ seed: itemSeed(original) });
    const preview = await h.manager.preview(
      desired(ITEM_SPEC, original, "New tight summary"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);

    // The vendor starts normalizing writes between apply and rollback; the
    // captured before has double spaces, so the restore comes back altered.
    h.fake.mutateWrites((v) => v.replace(/\s+/g, " "));
    const err = await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("stored a different value");

    // TRUTHFUL: still 'applied' — 'reverted' was NOT recorded without
    // byte-exact proof, even though the site now holds a third state.
    const row = h.store.peek(applied.change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(ITEM_SPEC.read(h.fake)).toBe("Casa Uno: a summary with odd spacing");

    // Normalization gone → the retry restores byte-exact, only then 'reverted'.
    h.fake.mutateWrites((v) => v);
    const reverted = await h.manager.rollback(
      applied.change.id,
      { reason: "qa: undo (normalization fixed)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(ITEM_SPEC.read(h.fake)).toBe(original);
  });

  it("429 on the apply WRITE itself: rate_limited, row stays previewed, staged+published untouched; the same action re-run completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const preview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    h.fake.failNextWriteWith(429, "too_many_requests");

    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.httpStatus).toBe(429);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);

    // The limit lifts; the SAME action re-runs and completes.
    const retry = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);
  });

  it("429 at the before-capture read: rate_limited with the whitelisted Retry-After, ZERO writes, row previewed; retry completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const preview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    h.fake.rateLimitNext(30);

    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.retryAfterSeconds).toBe(30);
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");

    const retry = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
  });

  it("429 mid-revert: row stays applied (truthful), site keeps the after-state; retry once the limit lifts restores byte-exact", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(429, "too_many_requests");
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "rate_limited",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });

  it("OG mirror flipped ON between preview and apply: refused pre-write (unsupported_operation), zero PATCH; and flipped ON between apply and rollback: revert refused the same way — both honest, both recoverable", async () => {
    const OG_ORIGINAL = "OG Original — GG Realty";
    const h = harness({ seed: pageSeed({ ogTitle: OG_ORIGINAL }) });
    const preview = await h.manager.preview(
      desired(PAGE_OG_TITLE_SPEC, OG_ORIGINAL, "New OG Title"),
      CTX,
    );

    // Owner re-enables "same as SEO title" in the Designer before the apply.
    setMirror(h.fake, PAGE_ID, "title", true);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "unsupported_operation",
    );
    expect(err.message).toContain("MIRRORS");
    expect(err.message).toContain("titleCopied");
    expect(patchRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");

    // Mirror back off → the same action completes.
    setMirror(h.fake, PAGE_ID, "title", false);
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(h.fake.page(PAGE_ID).openGraph.title).toBe("New OG Title");

    // Mirror flips ON again before the rollback → revert refused pre-write,
    // row stays TRUTHFULLY applied.
    setMirror(h.fake, PAGE_ID, "title", true);
    await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX),
      "unsupported_operation",
    );
    expect(h.store.peek(applied.change.id)?.status).toBe("applied");

    // Mirror off → rollback restores byte-exact.
    setMirror(h.fake, PAGE_ID, "title", false);
    await h.manager.rollback(applied.change.id, { reason: "qa: undo (retry)" }, CTX);
    expect(h.fake.page(PAGE_ID).openGraph.title).toBe(OG_ORIGINAL);
    expect(h.store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("OG mirror flipped INSIDE the write window (after the pre-write check, before the PATCH): the accepted-and-ignored write is reported write_verification_failed — never a false 'applied'", async () => {
    const OG_ORIGINAL = "OG Original — GG Realty";
    let pageGets = 0;
    const h = harness({
      seed: pageSeed({ ogTitle: OG_ORIGINAL }),
      // Flip the mirror after the SECOND page GET — i.e. after apply's own
      // pre-write flag check passed, immediately before the PATCH leaves.
      wrapPort: (port, fake) => async (url, init) => {
        const res = await port(url, init);
        if (
          init.method === "GET" &&
          url === `${API}/pages/${PAGE_ID}` &&
          ++pageGets === 2
        ) {
          setMirror(fake, PAGE_ID, "title", true);
        }
        return res;
      },
    });
    const preview = await h.manager.preview(
      desired(PAGE_OG_TITLE_SPEC, OG_ORIGINAL, "New OG Title"),
      CTX,
    );
    // Webflow ACCEPTS AND IGNORES an OG write while the mirror is on — the
    // echo shows the mirror. The adapter must call that a failed write.
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("mirroring");
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    // The underlying OG value was never changed by the ignored write.
    setMirror(h.fake, PAGE_ID, "title", false);
    expect(h.fake.page(PAGE_ID).openGraph.title).toBe(OG_ORIGINAL);
    expect(h.fake.livePage(PAGE_ID).openGraph.title).toBe(OG_ORIGINAL);
  });

  it("network failure mid-revert: row stays applied; retry completes", async () => {
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }) });
    const change = await applyTitleChange(h);

    h.fake.http.failNext(new Error("ETIMEDOUT"));
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "network_failure",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);

    await h.manager.rollback(change.id, { reason: "qa: undo (retry)" }, CTX);
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
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
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);
  });

  it("QA-1 RE-VERIFICATION (page): DB crash AFTER the site apply → retry keeps the ORIGINAL rollback baseline (resumed_after_partial_apply); rollback restores it byte-exact", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }), store });
    const preview = await h.manager.preview(
      desired(PAGE_SEO_TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );

    // Crash window: the site write lands, the DB row update fails.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE); // half-applied
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
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });

  it("QA-1 RE-VERIFICATION (item, double crash): crash → retry → crash AGAIN → retry: the original JSON baseline survives every cycle; rollback restores it", async () => {
    const ORIGINAL_SCHEMA: Json = { "@type": "FAQPage", rev: 1, note: "original 🚀" };
    const AFTER_SCHEMA: Json = { "@type": "FAQPage", rev: 2, note: "approved" };
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: itemSeed(ORIGINAL_SCHEMA), store });
    const preview = await h.manager.preview(
      desired(ITEM_SPEC, ORIGINAL_SCHEMA, AFTER_SCHEMA),
      CTX,
    );

    // Crash window #1.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(ITEM_SPEC.read(h.fake)).toEqual(AFTER_SCHEMA);
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

    const reverted = await h.manager.rollback(
      retried.change.id,
      { reason: "qa: undo after double-crash recovery" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(ITEM_SPEC.read(h.fake)).toEqual(ORIGINAL_SCHEMA);
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toEqual(
      ORIGINAL_SCHEMA,
    );
  });

  it("DB crash AFTER the site revert: row truthfully stays 'applied' (site already restored); retry reconciles idempotently", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: pageSeed({ seoTitle: ORIGINAL_TITLE }), store });
    const change = await applyTitleChange(h);

    store.crashNextUpdate = true;
    await expect(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
    ).rejects.toThrow("database unavailable");

    // Safe direction: the SITE is restored, but the row never claims
    // 'reverted' until the DB confirms it.
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
    expect(store.peek(change.id)?.status).toBe("applied");
    expect(store.peek(change.id)?.reverted_at).toBeNull();

    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Auto-rollback integration through THIS adapter                   */
/* ------------------------------------------------------------------ */

describe("QA gate 4 — auto-rollback fires through the Webflow adapter, staged-only, respecting mode flags", () => {
  const THRESHOLDS = { traffic: 25, ranking: 30, visibility: 30 };

  it("mode 'off': a breaching signal is recorded but NEVER evaluated — no revert, no flag", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "off", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = patchRequests(h.fake).length;

    const evaluation = await h.manager.monitor(change.id, [signal("traffic", -99)], CTX);
    expect(evaluation.action).toBe("none");
    expect(evaluation.breaches).toEqual([]);
    expect(patchRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);
  });

  it("mode 'flag': a breach is surfaced for a HUMAN to revert — the site is not touched; the human one-click revert then works", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "flag", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = patchRequests(h.fake).length;

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("visibility", -45)],
      CTX,
    );
    expect(evaluation.action).toBe("flagged");
    expect(evaluation.breaches.map((b) => b.metric)).toEqual(["visibility"]);
    expect(patchRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");

    await h.manager.rollback(change.id, { reason: "qa: flagged breach" }, CTX);
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });

  it("mode 'execute': a monitored regression AUTO-reverts byte-exact, STAGED-ONLY, with an honest alert", async () => {
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

    // The revert went THROUGH the Webflow adapter to the pinned staged route.
    const patches = patchRequests(h.fake);
    expect(patches).toHaveLength(2);
    expect(patches[1].url).toBe(`${API}/pages/${PAGE_ID}`);
    expect(JSON.parse(patches[1].body ?? "")).toEqual({
      seo: { title: ORIGINAL_TITLE },
    });
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE); // byte-exact restore
    // Staged-only: the published site never moved; no publish traffic.
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
    expectStagedOnlyTraffic(h.fake);

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
  });

  it("threshold boundary: exactly -threshold fires; one tenth inside does not; improvement never fires", async () => {
    const atEdge = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeA = await applyTitleChange(atEdge);
    const evalA = await atEdge.manager.monitor(changeA.id, [signal("traffic", -25)], CTX);
    expect(evalA.action).toBe("auto_reverted");
    expect(atEdge.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);

    const inside = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeB = await applyTitleChange(inside);
    const evalB = await inside.manager.monitor(changeB.id, [signal("traffic", -24.9)], CTX);
    expect(evalB.action).toBe("none");
    expect(inside.store.peek(changeB.id)?.status).toBe("applied");
    expect(inside.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);

    const evalC = await inside.manager.monitor(changeB.id, [signal("traffic", 40)], CTX);
    expect(evalC.action).toBe("none");
  });

  it("execute-mode revert failure (503): action 'auto_revert_failed', row stays applied, NO alert claims a revert; retry completes and only then alerts", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(503, "service_unavailable");
    const failed = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(failed.action).toBe("auto_revert_failed");
    if (!isWriteMethodError(failed.error)) {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(failed.error.code).toBe("vendor_failure");
    expect(h.store.peek(change.id)?.status).toBe("applied"); // TRUTHFUL
    expect(h.fake.page(PAGE_ID).seo.title).toBe(APPROVED_TITLE);
    expect(h.alerts).toHaveLength(0);

    const retried = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(retried.action).toBe("auto_reverted");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    expect(h.alerts).toHaveLength(1);
  });

  it("execute-mode revert rate-limited (429): auto_revert_failed with rate_limited, honest status; retry after the limit lifts completes", async () => {
    const h = harness({
      seed: pageSeed({ seoTitle: ORIGINAL_TITLE }),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(429, "too_many_requests");
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
    expect(h.fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_TITLE);
  });

  it("execute-mode revert against a DELETED item reports auto_revert_failed honestly — never 'auto_reverted'", async () => {
    const h = harness({
      seed: itemSeed("Original summary"),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const preview = await h.manager.preview(
      desired(ITEM_SPEC, "Original summary", "Approved summary"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    h.fake.removeItem(COLLECTION_ID, ITEM_ID);

    const evaluation = await h.manager.monitor(
      applied.change.id,
      [signal("traffic", -80)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_revert_failed");
    if (!isWriteMethodError(evaluation.error)) {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(evaluation.error.code).toBe("target_missing");
    expect(h.store.peek(applied.change.id)?.status).toBe("applied");
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
    const writes = patchRequests(h.fake).length;

    const again = await h.manager.monitor(change.id, [signal("traffic", -60)], CTX);
    expect(again.action).toBe("none");
    expect(patchRequests(h.fake)).toHaveLength(writes);
    expect(h.alerts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Partial batch — mixed kinds, MIDDLE member fails                  */
/* ------------------------------------------------------------------ */

const BATCH_P1_ORIGINAL = "Page One — original title";
const BATCH_ITEM_ORIGINAL = "Item — original value 🚀";
const BATCH_P3_ORIGINAL = "Page Two — original title";

function batchSeed(): Omit<FakeWebflowSeed, "token" | "siteId"> {
  return {
    pages: {
      [PAGE_ID]: pageEntry({ seoTitle: BATCH_P1_ORIGINAL }),
      [PAGE2_ID]: pageEntry({ seoTitle: BATCH_P3_ORIGINAL }),
    },
    collections: itemSeed(BATCH_ITEM_ORIGINAL).collections,
  };
}

function batchMembers(itemAfter: string): DesiredChange[] {
  return [
    desired(
      { changeType: "title", locator: webflowLocators.pageSeoTitle(PAGE_ID) },
      BATCH_P1_ORIGINAL,
      "Page One | Approved",
    ),
    desired(
      { changeType: "content", locator: ITEM_SPEC.locator },
      BATCH_ITEM_ORIGINAL,
      itemAfter,
    ),
    desired(
      { changeType: "title", locator: webflowLocators.pageSeoTitle(PAGE2_ID) },
      BATCH_P3_ORIGINAL,
      "Page Two | Approved",
    ),
  ];
}

describe("QA gate 5 — partial batch: the MIDDLE member fails, prefix accounting is exact", () => {
  it("mixed page+item batch, middle member 429s MID-WRITE: exact prefix accounting, tail never requested, applied prefix rolls back byte-exact, published untouched", async () => {
    let patchCount = 0;
    const h = harness({
      seed: batchSeed(),
      // The item write (the batch's 2nd PATCH) is rate-limited; everything
      // else passes through untouched.
      wrapPort: (port) => async (url, init) => {
        if (init.method === "PATCH" && ++patchCount === 2) {
          return jsonResponse(
            429,
            { message: "Too Many Requests", code: "too_many_requests" },
            { "retry-after": "7" },
          );
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

    // Site state matches the report exactly; published untouched everywhere.
    expect(h.fake.page(PAGE_ID).seo.title).toBe("Page One | Approved");
    expect(ITEM_SPEC.read(h.fake)).toBe(BATCH_ITEM_ORIGINAL);
    expect(h.fake.page(PAGE2_ID).seo.title).toBe(BATCH_P3_ORIGINAL);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toBe(
      BATCH_ITEM_ORIGINAL,
    );
    expect(h.fake.livePage(PAGE2_ID).seo.title).toBe(BATCH_P3_ORIGINAL);
    expectStagedOnlyTraffic(h.fake);

    // The applied prefix rolls back byte-exact through the same adapter.
    const reverted = await h.manager.rollback(
      m1,
      { reason: "qa: batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.page(PAGE_ID).seo.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.store.peek(m2)?.status).toBe("previewed");
    expect(h.store.peek(m3)?.status).toBe("previewed");
  });

  it("the SAME batch re-run after the limit lifts completes: applied prefix reported previouslyApplied, remaining members apply, then every member rolls back byte-exact", async () => {
    let patchCount = 0;
    let limited = true;
    const h = harness({
      seed: batchSeed(),
      wrapPort: (port) => async (url, init) => {
        if (limited && init.method === "PATCH" && ++patchCount === 2) {
          return jsonResponse(429, {
            message: "Too Many Requests",
            code: "too_many_requests",
          });
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
    expect(h.fake.page(PAGE_ID).seo.title).toBe("Page One | Approved");
    expect(ITEM_SPEC.read(h.fake)).toBe("Item | Approved");
    expect(h.fake.page(PAGE2_ID).seo.title).toBe("Page Two | Approved");

    // Every member is individually revertible, byte-exact, staged-only.
    for (const [id, reason] of [
      [m1, "qa: revert member 1"],
      [m2, "qa: revert member 2"],
      [m3, "qa: revert member 3"],
    ] as const) {
      const reverted = await h.manager.rollback(id, { reason }, CTX);
      expect(reverted.change.status).toBe("reverted");
    }
    expect(h.fake.page(PAGE_ID).seo.title).toBe(BATCH_P1_ORIGINAL);
    expect(ITEM_SPEC.read(h.fake)).toBe(BATCH_ITEM_ORIGINAL);
    expect(h.fake.page(PAGE2_ID).seo.title).toBe(BATCH_P3_ORIGINAL);
    expect(h.fake.livePage(PAGE_ID).seo.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.fake.liveItem(COLLECTION_ID, ITEM_ID)[TARGET_FIELD]).toBe(
      BATCH_ITEM_ORIGINAL,
    );
    expect(h.fake.livePage(PAGE2_ID).seo.title).toBe(BATCH_P3_ORIGINAL);
    expectStagedOnlyTraffic(h.fake);
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

    // Truthful statuses: m2 never claimed applied, though the site now holds
    // the stripped variant — the honest mess is surfaced, not hidden.
    expect(h.store.peek(m1)?.status).toBe("applied");
    expect(h.store.peek(m2)?.status).toBe("previewed");
    expect(h.store.peek(m3)?.status).toBe("previewed");
    expect(ITEM_SPEC.read(h.fake)).toBe("Item | Approved"); // ZWSP stripped
    expect(h.fake.requests.some((r) => r.url.includes(PAGE2_ID))).toBe(false);

    // The applied prefix rolls back byte-exact (its values carry no ZWSP, so
    // the still-active normalization cannot corrupt the restore).
    await h.manager.rollback(
      m1,
      { reason: "qa: batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(h.fake.page(PAGE_ID).seo.title).toBe(BATCH_P1_ORIGINAL);
    expect(h.store.peek(m1)?.status).toBe("reverted");
  });
});

/* ------------------------------------------------------------------ */
/* 6. No-silent-failure sweep — every branch surfaces a typed error     */
/* ------------------------------------------------------------------ */

function scriptedAdapter(handler: Parameters<ScriptedFetch["on"]>[2]) {
  const scripted = new ScriptedFetch().on("*", /./, handler);
  return new WebflowAdapter({
    site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", siteId: SITE_ID },
    secrets: { resolve: async () => new VendorCredential(SECRET) },
    authRef: "vault://webflow/prop-1",
    fetch: scripted.port,
  });
}

const ADAPTER_CTX = { tenantId: "t1", clientId: "c1", propertyId: "prop-1" };

describe("QA gate 6 — no-silent-failure sweep of the adapter's branches", () => {
  const MALFORMED_CASES: ReadonlyArray<{
    label: string;
    locator: string;
    respond: Parameters<ScriptedFetch["on"]>[2];
    code: WriteMethodErrorCode;
    msgPart: string;
  }> = [
    {
      label: "JSON scalar where an entity was promised",
      locator: PAGE_SEO_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, "ok"),
      code: "unexpected_response",
      msgPart: "not an object",
    },
    {
      label: "page entity without a siteId (pin unverifiable)",
      locator: PAGE_SEO_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, { id: PAGE_ID, seo: { title: "x" } }),
      code: "unexpected_response",
      msgPart: "no siteId",
    },
    {
      label: "page entity claiming a FOREIGN site",
      locator: PAGE_SEO_TITLE_SPEC.locator,
      respond: () =>
        jsonResponse(200, {
          id: PAGE_ID,
          siteId: wfid("baddad"),
          seo: { title: "x" },
        }),
      code: "cross_site_target",
      msgPart: "different Webflow site",
    },
    {
      label: "page entity without the seo group",
      locator: PAGE_SEO_TITLE_SPEC.locator,
      respond: () => jsonResponse(200, { id: PAGE_ID, siteId: SITE_ID }),
      code: "unexpected_response",
      msgPart: "no seo object",
    },
    {
      label: "og group missing its mirror flag",
      locator: PAGE_OG_TITLE_SPEC.locator,
      respond: () =>
        jsonResponse(200, {
          id: PAGE_ID,
          siteId: SITE_ID,
          openGraph: { title: "x" },
        }),
      code: "unexpected_response",
      msgPart: "no titleCopied flag",
    },
    {
      label: "collections response without a collections list",
      locator: ITEM_SPEC.locator,
      respond: () => jsonResponse(200, {}),
      code: "unexpected_response",
      msgPart: "no collections list",
    },
    {
      label: "item response without fieldData",
      locator: ITEM_SPEC.locator,
      respond: (req) =>
        req.url.endsWith("/collections")
          ? jsonResponse(200, { collections: [{ id: COLLECTION_ID }] })
          : jsonResponse(200, { id: ITEM_ID }),
      code: "unexpected_response",
      msgPart: "no fieldData object",
    },
    {
      label: "non-JSON garbage where the API was promised",
      locator: PAGE_SEO_TITLE_SPEC.locator,
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

  it("misconfiguration is refused LOUDLY at construction (bad base URL, bad site id) — never a deferred/silent failure", () => {
    const secrets: SecretsResolver = {
      resolve: async () => new VendorCredential(SECRET),
    };
    const fake = new FakeWebflow({ token: SECRET, siteId: SITE_ID });
    for (const config of [
      { apiBaseUrl: "https://evil.example" },
      { siteId: "NOT-A-SITE-ID" },
    ]) {
      let thrown: unknown = null;
      try {
        new WebflowAdapter({
          site: {
            tenantId: "t1",
            clientId: "c1",
            propertyId: "prop-1",
            siteId: config.siteId ?? SITE_ID,
          },
          secrets,
          authRef: "vault://webflow/prop-1",
          fetch: fake.port,
          apiBaseUrl: config.apiBaseUrl,
        });
      } catch (err) {
        thrown = err;
      }
      if (!isWriteMethodError(thrown)) {
        throw new Error("expected a loud WriteMethodError at construction");
      }
      expect(thrown.code).toBe("misconfigured");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("every irreversible/unrepresentable locator is refused at PLAN time with ZERO HTTP — even from a persisted preview row", async () => {
    const REFUSED_LOCATORS: ReadonlyArray<{ label: string; locator?: string }> = [
      { label: "site publish", locator: `webflow:site/${SITE_ID}/publish` },
      {
        label: "item live publish",
        locator: `webflow:item/${COLLECTION_ID}/${ITEM_ID}/live`,
      },
      {
        label: "page name (designer-facing title)",
        locator: `webflow:page/${PAGE_ID}/title`,
      },
      { label: "page slug (URL-changing)", locator: `webflow:page/${PAGE_ID}/slug` },
      {
        label: "item slug field (server-normalized + URL-changing)",
        locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "slug"),
      },
      {
        label: "locale-parameterized field",
        locator: `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/summary@fr`,
      },
      {
        label: "uppercase hex id (would alias the same id)",
        locator: `webflow:page/${PAGE_ID.toUpperCase()}/seo.title`,
      },
      { label: "path smuggling", locator: "webflow:page/../../site-x/seo.title" },
      {
        label: "isDraft flip (state transition)",
        locator: `webflow:item/${COLLECTION_ID}/${ITEM_ID}/isDraft`,
      },
      { label: "missing locator", locator: undefined },
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
    expect(h.fake.page(PAGE_ID).seo.title).toBe("Original");
    expect(ITEM_SPEC.read(h.fake)).toBe("Original");
  });
});
