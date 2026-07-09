/**
 * QA ROLLBACK GATE — independent adversarial verification of the WordPress
 * write method against the change-management rollback contract (doc 04 §2:
 * "every change reversible by one action, via the same method that applied
 * it"; doc 07 gate 1.3). Written and owned by qa-testing — NOT a re-run of the
 * build agent's tests.
 *
 * What this suite proves, end-to-end through the REAL ChangeManager pipeline
 * (never by calling the adapter directly):
 *
 *  1. ROUND-TRIP PROPERTY, EXHAUSTIVELY — for EVERY locator kind the adapter's
 *     grammar accepts (post/page × title|content|meta-key, media alt_text) and
 *     for edge value shapes (empty string, unicode/emoji/ZWJ, HTML entities,
 *     mixed normalization forms, control characters, 64 KiB strings, and every
 *     JSON type the meta surface accepts): apply → verify stored → revert →
 *     the site is BYTE-EXACT the original capture. A completeness check pins
 *     the tested kinds to the grammar so a new locator kind fails this suite
 *     until it is covered.
 *  2. ROLLBACK UNDER ADVERSITY — entity deleted after apply; credentials
 *     rotated mid-revert (401); kses-style write mutation breaking byte-exact
 *     verification; network failure; login-redirect interception. In every
 *     case the row status stays TRUTHFUL: applied stays applied, the error is
 *     surfaced, retry is possible, and 'reverted' is NEVER recorded without
 *     byte-exact proof.
 *  3. AUTO-ROLLBACK INTEGRATION — a monitored regression drives the manager's
 *     monitor() through THIS adapter, respecting the per-client policy mode
 *     (off / flag / execute), threshold boundaries, the automation_level
 *     flags, alert emission, failure honesty, and the no-double-fire terminal
 *     states.
 *  4. PARTIAL-BATCH ROLLBACK — a 3-member mixed-kind batch whose middle member
 *     fails mid-write: the applied prefix rolls back byte-exact, the tail is
 *     never attempted, and every status is truthful throughout.
 *
 * All HTTP is the injected FakeWordPress (ScriptedFetch) — zero live network.
 */

import { describe, expect, it } from "vitest";
import {
  AutomationLevelError,
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  RollbackReasonRequiredError,
  steppingClock,
  type AlertDraft,
  type AutoRollbackPolicy,
  type DesiredChange,
  type MonitoredMetric,
  type MonitoringSignal,
  type TenantContext,
} from "@/lib/change-management";
import { VendorCredential, type SecretsResolver } from "@/lib/connectors";
import type { ChangePatch } from "@/lib/change-management";
import type { Json, SiteChangeRow, SiteChangeType } from "@/lib/types/db";
import { isWriteMethodError, type WriteMethodErrorCode } from "../shared/errors";
import { WordPressAdapter } from "./adapter";
import { FakeWordPress, type FakeWordPressSeed } from "./fake-wp";
import { wordpressLocators } from "./target";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const SECRET = "qa-operator:QaQa BbBb CcCc DdDd";
const BASE = "https://client-a.example";
const REST = `${BASE}/wp-json/wp/v2`;

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-qa", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

const POST_ID = 1;
const PAGE_ID = 4;
const MEDIA_ID = 7;

/** Sentinel sibling values — collateral-damage detection on every round-trip. */
const SIBLING_TITLE = "sibling-title (must never change)";
const SIBLING_CONTENT = "<p>sibling-content (must never change)</p>";
const SIBLING_META_KEY = "qa_untouched_key";
const SIBLING_META_VALUE = "sibling-meta (must never change)";
const TARGET_META_KEY = "qa_target_key";

/**
 * An InMemoryChangeStore whose NEXT update() throws AFTER the site write has
 * already happened — the crash window the manager's ordering comments reason
 * about ("site write BEFORE the DB row update"). Test-only subclass; adapter
 * and pipeline source untouched.
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
  fake: FakeWordPress;
  manager: ChangeManager;
  store: InMemoryChangeStore;
  alerts: AlertDraft[];
  rotateSecret(next: string): void;
}

function harness(opts?: {
  seed?: Omit<FakeWordPressSeed, "credential">;
  policy?: AutoRollbackPolicy;
  alertSink?: { emit(alert: AlertDraft): void | Promise<void> };
  store?: InMemoryChangeStore;
}): Harness {
  const fake = new FakeWordPress({ credential: SECRET, ...(opts?.seed ?? {}) });
  let vaultValue = SECRET;
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(vaultValue),
  };
  const adapter = new WordPressAdapter({
    site: { tenantId: "t1", clientId: "c1", propertyId: "prop-1", baseUrl: BASE },
    secrets,
    authRef: "vault://wp/prop-1",
    fetch: fake.port,
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
  spec: { changeType: SiteChangeType; locator: string },
  before: Json,
  after: Json,
  automationLevel?: DesiredChange["automationLevel"],
): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "wordpress",
    changeType: spec.changeType,
    automationLevel,
    target: { url: `${BASE}/qa-page`, locator: spec.locator },
    before,
    after,
  };
}

function postRequests(fake: FakeWordPress) {
  return fake.requests.filter((r) => r.method === "POST");
}

async function expectFailure(
  p: Promise<unknown>,
  code: WriteMethodErrorCode,
): Promise<InstanceType<typeof Error> & { code: string; httpStatus?: number }> {
  const err: unknown = await p.then(
    () => {
      throw new Error(`expected a rejection with WriteMethodError '${code}'`);
    },
    (e: unknown) => e,
  );
  if (!isWriteMethodError(err)) {
    throw new Error(
      `expected WriteMethodError '${code}', got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  expect(err.code).toBe(code);
  return err;
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

/* ------------------------------------------------------------------ */
/* 1. Round-trip property, exhaustively                                */
/* ------------------------------------------------------------------ */

interface KindSpec {
  kind: string;
  domain: "string" | "meta";
  changeType: SiteChangeType;
  locator: string;
  route: string;
  seed(value: Json): Omit<FakeWordPressSeed, "credential">;
  read(fake: FakeWordPress): Json;
  /** Fields the change must NOT touch — asserted identical after the cycle. */
  collateral(fake: FakeWordPress): Json;
  collateralExpected: Json;
}

const contentSeed = (
  overrides: Partial<{ title: Json; content: Json; metaValue: Json }>,
) => ({
  title: (overrides.title ?? SIBLING_TITLE) as string,
  content: (overrides.content ?? SIBLING_CONTENT) as string,
  meta: {
    // `=== undefined`, not `??` — a seeded null LIVE value must stay null.
    [TARGET_META_KEY]:
      overrides.metaValue === undefined ? "meta-default" : overrides.metaValue,
    [SIBLING_META_KEY]: SIBLING_META_VALUE,
  },
});

const KINDS: KindSpec[] = [
  {
    kind: "post/title",
    domain: "string",
    changeType: "title",
    locator: wordpressLocators.postTitle(POST_ID),
    route: `posts/${POST_ID}`,
    seed: (v) => ({ posts: { [POST_ID]: contentSeed({ title: v }) } }),
    read: (f) => f.post(POST_ID).title,
    collateral: (f) => ({
      content: f.post(POST_ID).content,
      meta: f.post(POST_ID).meta,
    }),
    collateralExpected: {
      content: SIBLING_CONTENT,
      meta: { [TARGET_META_KEY]: "meta-default", [SIBLING_META_KEY]: SIBLING_META_VALUE },
    },
  },
  {
    kind: "post/content",
    domain: "string",
    changeType: "content",
    locator: wordpressLocators.postContent(POST_ID),
    route: `posts/${POST_ID}`,
    seed: (v) => ({ posts: { [POST_ID]: contentSeed({ content: v }) } }),
    read: (f) => f.post(POST_ID).content,
    collateral: (f) => ({ title: f.post(POST_ID).title, meta: f.post(POST_ID).meta }),
    collateralExpected: {
      title: SIBLING_TITLE,
      meta: { [TARGET_META_KEY]: "meta-default", [SIBLING_META_KEY]: SIBLING_META_VALUE },
    },
  },
  {
    kind: "post/meta",
    domain: "meta",
    changeType: "meta",
    locator: wordpressLocators.postMeta(POST_ID, TARGET_META_KEY),
    route: `posts/${POST_ID}`,
    seed: (v) => ({ posts: { [POST_ID]: contentSeed({ metaValue: v }) } }),
    read: (f) => f.post(POST_ID).meta[TARGET_META_KEY],
    collateral: (f) => ({
      title: f.post(POST_ID).title,
      content: f.post(POST_ID).content,
      siblingMeta: f.post(POST_ID).meta[SIBLING_META_KEY],
    }),
    collateralExpected: {
      title: SIBLING_TITLE,
      content: SIBLING_CONTENT,
      siblingMeta: SIBLING_META_VALUE,
    },
  },
  {
    kind: "page/title",
    domain: "string",
    changeType: "title",
    locator: wordpressLocators.pageTitle(PAGE_ID),
    route: `pages/${PAGE_ID}`,
    seed: (v) => ({ pages: { [PAGE_ID]: contentSeed({ title: v }) } }),
    read: (f) => f.page(PAGE_ID).title,
    collateral: (f) => ({ content: f.page(PAGE_ID).content, meta: f.page(PAGE_ID).meta }),
    collateralExpected: {
      content: SIBLING_CONTENT,
      meta: { [TARGET_META_KEY]: "meta-default", [SIBLING_META_KEY]: SIBLING_META_VALUE },
    },
  },
  {
    kind: "page/content",
    domain: "string",
    changeType: "content",
    locator: wordpressLocators.pageContent(PAGE_ID),
    route: `pages/${PAGE_ID}`,
    seed: (v) => ({ pages: { [PAGE_ID]: contentSeed({ content: v }) } }),
    read: (f) => f.page(PAGE_ID).content,
    collateral: (f) => ({ title: f.page(PAGE_ID).title, meta: f.page(PAGE_ID).meta }),
    collateralExpected: {
      title: SIBLING_TITLE,
      meta: { [TARGET_META_KEY]: "meta-default", [SIBLING_META_KEY]: SIBLING_META_VALUE },
    },
  },
  {
    kind: "page/meta",
    domain: "meta",
    changeType: "meta",
    locator: wordpressLocators.pageMeta(PAGE_ID, TARGET_META_KEY),
    route: `pages/${PAGE_ID}`,
    seed: (v) => ({ pages: { [PAGE_ID]: contentSeed({ metaValue: v }) } }),
    read: (f) => f.page(PAGE_ID).meta[TARGET_META_KEY],
    collateral: (f) => ({
      title: f.page(PAGE_ID).title,
      content: f.page(PAGE_ID).content,
      siblingMeta: f.page(PAGE_ID).meta[SIBLING_META_KEY],
    }),
    collateralExpected: {
      title: SIBLING_TITLE,
      content: SIBLING_CONTENT,
      siblingMeta: SIBLING_META_VALUE,
    },
  },
  {
    kind: "media/alt_text",
    domain: "string",
    changeType: "alt",
    locator: wordpressLocators.mediaAltText(MEDIA_ID),
    route: `media/${MEDIA_ID}`,
    seed: (v) => ({ media: { [MEDIA_ID]: { altText: v as string } } }),
    read: (f) => f.media(MEDIA_ID).altText,
    collateral: () => ({}),
    collateralExpected: {},
  },
];

/** Edge string shapes — each must survive a byte-exact (code-point) round-trip. */
const STRING_SHAPES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "empty string", value: "" },
  {
    label: "unicode + emoji + ZWJ family + RTL",
    value: "Café “señor” — 🚀👩‍👩‍👧‍👦 ∑π≈3.14 中文 العربية",
  },
  {
    label: "HTML entities kept literal (never decoded)",
    value: "Ben &amp; Jerry&#8217;s &lt;deals&gt; &copy; 2026 &nbsp;",
  },
  {
    label: "markup + quotes + backslashes + control whitespace",
    value: '<div class="x" data-a=\'y\'>\\path\\to\t"q"\r\nline2\n</div>',
  },
  {
    label: "NFD combining form (normalization must NOT be applied)",
    value: "Café menu résumé",
  },
  {
    label: "very long (~64 KiB, multibyte + emoji tail)",
    value: "A宿".repeat(16384) + "🚀",
  },
];

/** Every JSON type the meta surface accepts (top-level null is refused by design). */
const META_SHAPES: ReadonlyArray<{ label: string; value: Json }> = [
  { label: "empty string", value: "" },
  { label: "unicode string with entities", value: "…🚀 &amp; é" },
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
const NEUTRAL_META_BEFORE: Json = { qa: "neutral-original" };
const NEUTRAL_META_AFTER: Json = { qa: "neutral-approved" };

/**
 * One full pipeline round-trip: preview → human-approved apply (assert the
 * site stored `after` and the audit row captured `original`) → one-click
 * rollback (assert the site is byte-exact `original` again, collateral fields
 * untouched, statuses truthful, and both writes traveled the pinned route).
 */
async function runRoundTrip(spec: KindSpec, original: Json, after: Json) {
  const h = harness({ seed: spec.seed(original) });

  const preview = await h.manager.preview(
    desired(spec, original, after),
    CTX,
  );
  expect(preview.change.status).toBe("previewed");
  expect(h.fake.requests).toHaveLength(0); // preview never touches the site

  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(applied.warnings).toEqual([]); // seeded live state matches preview
  expect(applied.change.status).toBe("applied");
  // Verify stored: the site now holds exactly the approved after-state.
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
    // Code-point identity for the string surfaces — BYTE-EXACT, not "similar".
    expect(restored).toBe(original);
  }
  // No collateral damage: sibling fields identical after the full cycle.
  expect(spec.collateral(h.fake)).toEqual(spec.collateralExpected);

  // Exactly two writes (apply + revert), both through the pinned wp/v2 route.
  const posts = postRequests(h.fake);
  expect(posts).toHaveLength(2);
  for (const p of posts) {
    expect(p.url).toBe(`${REST}/${spec.route}?context=edit`);
  }
}

describe("QA gate 1 — round-trip property across EVERY supported locator kind", () => {
  it("the QA matrix covers every locator kind the adapter's grammar exposes (completeness pin)", () => {
    // If a new locator builder ships, this fails until the matrix covers it.
    expect(Object.keys(wordpressLocators).sort()).toEqual(
      [
        "mediaAltText",
        "pageContent",
        "pageMeta",
        "pageTitle",
        "postContent",
        "postMeta",
        "postTitle",
      ].sort(),
    );
    expect(KINDS.map((k) => k.kind).sort()).toEqual(
      [
        "media/alt_text",
        "page/content",
        "page/meta",
        "page/title",
        "post/content",
        "post/meta",
        "post/title",
      ].sort(),
    );
  });

  for (const spec of KINDS.filter((k) => k.domain === "string")) {
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

  for (const spec of KINDS.filter((k) => k.domain === "meta")) {
    describe(`${spec.kind} — every accepted JSON type`, () => {
      it.each(META_SHAPES)(
        `restores a "$label" ORIGINAL after rollback`,
        async ({ value }) => {
          await runRoundTrip(spec, value, NEUTRAL_META_AFTER);
        },
      );
      it.each(META_SHAPES)(
        `installs a "$label" AFTER verifiably, then rolls back`,
        async ({ value }) => {
          await runRoundTrip(spec, NEUTRAL_META_BEFORE, value);
        },
      );
    });
  }

  it("preserves the exact unicode normalization form on restore (NFD stays NFD)", async () => {
    const nfd = "Café menu"; // decomposed
    const nfc = nfd.normalize("NFC");
    expect(nfd).not.toBe(nfc); // test is sensitive to the difference
    const spec = KINDS[0]; // post/title
    const h = harness({ seed: spec.seed(nfd) });
    const preview = await h.manager.preview(desired(spec, nfd, nfc), CTX);
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(spec.read(h.fake)).toBe(nfc);
    await h.manager.rollback(applied.change.id, { reason: "qa: nfd proof" }, CTX);
    expect(spec.read(h.fake)).toBe(nfd);
    expect(spec.read(h.fake)).not.toBe(nfc);
    expect(applied.change.diff.before).toBe(nfd);
  });

  it("a stale null PREVIEWED before cannot poison the rollback baseline — re-baselined to the live capture, drift surfaced, round-trip intact", async () => {
    // The pipeline's rollback baseline is the LIVE before-capture, never the
    // (possibly wrong) previewed value: a null previewed before is replaced
    // with the restorable live value and the drift is surfaced, not swallowed.
    const spec = KINDS.find((k) => k.kind === "post/meta")!;
    const h = harness({ seed: spec.seed("live-value") });
    const preview = await h.manager.preview(desired(spec, null, "x"), CTX);

    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBe("live-value"); // authoritative baseline
    expect(spec.read(h.fake)).toBe("x");

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(spec.read(h.fake)).toBe("live-value"); // byte-exact live restore
  });

  it("refuses a null meta AFTER at plan time — a delete cannot round-trip", async () => {
    const spec = KINDS.find((k) => k.kind === "page/meta")!;
    const h = harness({ seed: spec.seed("live-value") });
    const preview = await h.manager.preview(desired(spec, "live-value", null), CTX);
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(postRequests(h.fake)).toHaveLength(0);
    expect(spec.read(h.fake)).toBe("live-value");
  });

  it("refuses a LIVE null meta value at before-capture — an unrestorable baseline never applies", async () => {
    const spec = KINDS.find((k) => k.kind === "post/meta")!;
    const h = harness({ seed: spec.seed(null) });
    const preview = await h.manager.preview(desired(spec, "stale", "new"), CTX);
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(postRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("refuses a non-string title value at plan time (typed JSON cannot land on a string surface)", async () => {
    const spec = KINDS[0]; // post/title
    const h = harness({ seed: spec.seed("Original") });
    const preview = await h.manager.preview(
      desired(spec, "Original", { not: "a string" }),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(postRequests(h.fake)).toHaveLength(0);
    expect(spec.read(h.fake)).toBe("Original");
  });

  it("refuses an unsupported locator (slug) even after it was persisted as a preview row — zero HTTP", async () => {
    const h = harness({ seed: KINDS[0].seed("Original") });
    const preview = await h.manager.preview(
      desired({ changeType: "title", locator: `wp:post/${POST_ID}/slug` }, "a", "b"),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "unsupported_operation",
    );
    expect(h.fake.requests).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Rollback under adversity — statuses stay truthful                */
/* ------------------------------------------------------------------ */

const TITLE_SPEC = KINDS[0]; // post/title
const ORIGINAL_TITLE = "Original Title — café 🚀";
const APPROVED_TITLE = "Approved Title | QA";

async function applyTitleChange(h: Harness) {
  const preview = await h.manager.preview(
    desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
    CTX,
  );
  const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
  expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);
  return applied.change;
}

describe("QA gate 2 — rollback under adversity (row status stays TRUTHFUL)", () => {
  it("entity deleted after apply: revert fails target_missing, row STAYS applied, never a false 'reverted'", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const change = await applyTitleChange(h);

    h.fake.remove("posts", POST_ID);
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: regressed" }, CTX),
      "target_missing",
    );
    const row = h.store.peek(change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(row?.reverted_reason).toBeNull();

    // Retry is possible and stays honest — same typed error, status unchanged.
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: retry" }, CTX),
      "target_missing",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
  });

  it("credentials rotated mid-revert (401): row stays applied; reconnect + retry completes byte-exact", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const change = await applyTitleChange(h);

    h.rotateSecret("qa-operator:ROTATED WRONG PAIR");
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "credential_rejected",
    );
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain(SECRET);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE); // site untouched by the failed revert

    h.rotateSecret(SECRET); // property reconnected
    const reverted = await h.manager.rollback(change.id, { reason: "qa: undo (retry)" }, CTX);
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("kses-style mutation on revert: restoration cannot verify → write_verification_failed, applied stays applied; fixed retry restores byte-exact", async () => {
    const spec = KINDS.find((k) => k.kind === "post/content")!;
    const original = '<div onclick="track()">Legacy CTA</div>';
    const approved = "<div>Approved CTA</div>";
    const h = harness({ seed: spec.seed(original) });

    const preview = await h.manager.preview(desired(spec, original, approved), CTX);
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(h.fake.post(POST_ID).content).toBe(approved);

    // A capability-limited user / kses now strips event handlers on write.
    h.fake.mutateWrites((v) => v.replace(/ onclick="[^"]*"/g, ""));
    const err = await expectFailure(
      h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX),
      "write_verification_failed",
    );
    expect(err.message).toContain("stored a different value");

    // TRUTHFUL: the row is still 'applied' — 'reverted' was NOT recorded
    // without byte-exact proof, even though the site now holds a third state.
    const row = h.store.peek(applied.change.id);
    expect(row?.status).toBe("applied");
    expect(row?.reverted_at).toBeNull();
    expect(h.fake.post(POST_ID).content).toBe('<div>Legacy CTA</div>'); // the honest mess, surfaced

    // Capabilities fixed → the retry restores byte-exact and only then records 'reverted'.
    h.fake.mutateWrites((v) => v);
    const reverted = await h.manager.rollback(
      applied.change.id,
      { reason: "qa: undo (capabilities fixed)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(POST_ID).content).toBe(original);
  });

  it("network failure mid-revert: row stays applied; retry completes", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const change = await applyTitleChange(h);

    h.fake.http.failNext(new Error("ETIMEDOUT"));
    await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "network_failure",
    );
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);

    await h.manager.rollback(change.id, { reason: "qa: undo (retry)" }, CTX);
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
    expect(h.store.peek(change.id)?.status).toBe("reverted");
  });

  it("login-redirect interception mid-revert: honest unexpected_response, row stays applied", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const change = await applyTitleChange(h);

    h.fake.simulateLoginRedirect();
    const err = await expectFailure(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
      "unexpected_response",
    );
    expect(err.message).toContain("HTML page instead of a REST response");
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);
  });

  it("rollback without a reason is refused BEFORE any site write (audit trail is mandatory)", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const change = await applyTitleChange(h);
    const writesBefore = postRequests(h.fake).length;

    await expect(
      h.manager.rollback(change.id, { reason: "   " }, CTX),
    ).rejects.toBeInstanceOf(RollbackReasonRequiredError);
    expect(postRequests(h.fake)).toHaveLength(writesBefore);
    expect(h.store.peek(change.id)?.status).toBe("applied");
  });

  it("DB crash AFTER the site revert: row truthfully stays 'applied' (site already restored); retry reconciles idempotently", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE), store });
    const change = await applyTitleChange(h);

    store.crashNextUpdate = true;
    await expect(
      h.manager.rollback(change.id, { reason: "qa: undo" }, CTX),
    ).rejects.toThrow("database unavailable");

    // The documented safe direction: the SITE is already restored, but the row
    // never claims 'reverted' until the DB confirms it.
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
    expect(store.peek(change.id)?.status).toBe("applied");
    expect(store.peek(change.id)?.reverted_at).toBeNull();

    // Retry re-writes the same before-state (a verified no-op on the site) and
    // reconciles the row — eventual consistency, statuses truthful throughout.
    const reverted = await h.manager.rollback(
      change.id,
      { reason: "qa: undo (retry)" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("GATE FINDING QA-1 — DB crash AFTER the site APPLY, then retry: the rollback baseline must still be the ORIGINAL pre-change state", async () => {
    // doc 04 §2 hard requirement: every applied change is reversible by one
    // action to the state that existed BEFORE the change. This test crashes
    // the store AFTER the site write (the manager's documented crash window),
    // retries the apply (the manager's documented recovery path), and then
    // demands the recovered row can still roll the site back to the original.
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE), store });
    const preview = await h.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );

    // Crash window: site write lands, DB row update fails.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE); // half-applied
    expect(store.peek(preview.change.id)?.status).toBe("previewed"); // documented

    // Documented recovery: retry the apply against the same row.
    const retried = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retried.change.status).toBe("applied");

    // THE CONTRACT: the persisted rollback baseline must be the original
    // pre-change state — not the adapter's re-read of our own half-applied
    // write. If this is APPROVED_TITLE, the original is unrecoverable and
    // rollback below is a silent no-op.
    expect(retried.change.diff.before).toBe(ORIGINAL_TITLE);

    // One-click rollback must restore the pre-change site state.
    const reverted = await h.manager.rollback(
      retried.change.id,
      { reason: "qa: undo after crash-recovery" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Auto-rollback integration through THIS adapter                   */
/* ------------------------------------------------------------------ */

describe("QA gate 3 — auto-rollback fires through the WordPress adapter, respecting mode flags", () => {
  const THRESHOLDS = { traffic: 25, ranking: 30, visibility: 30 };

  it("mode 'off': a breaching signal is recorded but NEVER evaluated — no revert, no flag", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "off", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = postRequests(h.fake).length;

    const evaluation = await h.manager.monitor(change.id, [signal("traffic", -99)], CTX);
    expect(evaluation.action).toBe("none");
    expect(evaluation.breaches).toEqual([]);
    expect(postRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);
  });

  it("mode 'flag': a breach is surfaced for a HUMAN to revert — the site is not touched", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "flag", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    const writes = postRequests(h.fake).length;

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("visibility", -45)],
      CTX,
    );
    expect(evaluation.action).toBe("flagged");
    expect(evaluation.breaches.map((b) => b.metric)).toEqual(["visibility"]);
    expect(postRequests(h.fake)).toHaveLength(writes);
    expect(h.store.peek(change.id)?.status).toBe("applied");

    // ...and the human one-click revert then works through the same adapter.
    await h.manager.rollback(change.id, { reason: "qa: flagged breach" }, CTX);
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("mode 'execute': a monitored regression AUTO-reverts through this adapter, byte-exact, with an alert", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    const evaluation = await h.manager.monitor(
      change.id,
      [signal("traffic", -40), signal("ranking", -10)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_reverted");
    expect(evaluation.breaches.map((b) => b.metric)).toEqual(["traffic"]); // only the breach

    // The revert went THROUGH the WordPress adapter to the pinned route.
    const posts = postRequests(h.fake);
    expect(posts).toHaveLength(2);
    expect(posts[1].url).toBe(`${REST}/posts/${POST_ID}?context=edit`);
    expect(JSON.parse(posts[1].body ?? "")).toEqual({ title: ORIGINAL_TITLE });
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE); // byte-exact restore

    const row = h.store.peek(change.id);
    expect(row?.status).toBe("auto_reverted");
    expect(row?.reverted_reason).toMatch(/^auto-rollback: traffic -40%.*25% drop threshold/);
    expect(row?.reverted_at).not.toBeNull();

    // The alert surfaced the event (M17 seam) with honest coordinates.
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      tenantId: "t1",
      clientId: "c1",
      type: "auto_rollback_fired",
      severity: "critical",
    });
  });

  it("threshold boundary: exactly -threshold fires; one tenth above does not", async () => {
    // Exactly at the threshold → breach.
    const atEdge = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeA = await applyTitleChange(atEdge);
    const evalA = await atEdge.manager.monitor(changeA.id, [signal("traffic", -25)], CTX);
    expect(evalA.action).toBe("auto_reverted");
    expect(atEdge.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);

    // Just inside the threshold → no action, site keeps the approved state.
    const inside = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const changeB = await applyTitleChange(inside);
    const evalB = await inside.manager.monitor(changeB.id, [signal("traffic", -24.9)], CTX);
    expect(evalB.action).toBe("none");
    expect(inside.store.peek(changeB.id)?.status).toBe("applied");
    expect(inside.fake.post(POST_ID).title).toBe(APPROVED_TITLE);

    // Improvement is never a breach.
    const evalC = await inside.manager.monitor(changeB.id, [signal("traffic", 40)], CTX);
    expect(evalC.action).toBe("none");
  });

  it("execute-mode revert failure: action 'auto_revert_failed', row stays applied, error surfaced; retry succeeds", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);

    h.fake.failNextWriteWith(503, "service_unavailable");
    const failed = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(failed.action).toBe("auto_revert_failed");
    expect(isWriteMethodError(failed.error)).toBe(true);
    if (isWriteMethodError(failed.error)) {
      expect(failed.error.code).toBe("vendor_failure");
    }
    expect(h.store.peek(change.id)?.status).toBe("applied"); // TRUTHFUL
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);
    expect(h.alerts).toHaveLength(0); // no alert claims a revert that did not happen

    // The monitoring loop retries and completes the auto-revert.
    const retried = await h.manager.monitor(change.id, [signal("ranking", -50)], CTX);
    expect(retried.action).toBe("auto_reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    expect(h.alerts).toHaveLength(1);
  });

  it("execute-mode revert against a DELETED entity reports auto_revert_failed honestly — never 'auto_reverted'", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    h.fake.remove("posts", POST_ID);

    const evaluation = await h.manager.monitor(change.id, [signal("traffic", -80)], CTX);
    expect(evaluation.action).toBe("auto_revert_failed");
    if (isWriteMethodError(evaluation.error)) {
      expect(evaluation.error.code).toBe("target_missing");
    } else {
      throw new Error("expected a WriteMethodError from the failed auto-revert");
    }
    expect(h.store.peek(change.id)?.status).toBe("applied");
    expect(h.alerts).toHaveLength(0);
  });

  it("auto-rollback never fires twice: a terminal auto_reverted row evaluates to 'none'", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const change = await applyTitleChange(h);
    await h.manager.monitor(change.id, [signal("traffic", -60)], CTX);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    const writes = postRequests(h.fake).length;

    const again = await h.manager.monitor(change.id, [signal("traffic", -60)], CTX);
    expect(again.action).toBe("none");
    expect(postRequests(h.fake)).toHaveLength(writes); // no second revert write
    expect(h.alerts).toHaveLength(1);
  });

  it("a change never applied (previewed) is never auto-reverted, whatever the signals say", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const preview = await h.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const evaluation = await h.manager.monitor(
      preview.change.id,
      [signal("traffic", -99)],
      CTX,
    );
    expect(evaluation.action).toBe("none");
    expect(h.fake.requests).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("a failing alert sink NEVER blocks or hides the auto-rollback — surfaced as a warning", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
      alertSink: {
        emit: () => {
          throw new Error("alert sink down");
        },
      },
    });
    const change = await applyTitleChange(h);
    const evaluation = await h.manager.monitor(change.id, [signal("traffic", -50)], CTX);
    expect(evaluation.action).toBe("auto_reverted");
    expect(evaluation.warnings.map((w) => w.code)).toEqual(["alert_emit_failed"]);
    expect(h.store.peek(change.id)?.status).toBe("auto_reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("automation_level 'human_only' rows ride the same monitored-rollback machinery", async () => {
    const h = harness({
      seed: TITLE_SPEC.seed(ORIGINAL_TITLE),
      policy: { mode: "execute", thresholds: THRESHOLDS },
    });
    const preview = await h.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE, "human_only"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.change.automation_level).toBe("human_only");

    const evaluation = await h.manager.monitor(applied.change.id, [signal("visibility", -35)], CTX);
    expect(evaluation.action).toBe("auto_reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("automation_level 'auto' is rejected at the seam — it can never enter the pipeline", async () => {
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE) });
    const hostile = {
      ...desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      automationLevel: "auto",
    } as unknown as DesiredChange;
    await expect(h.manager.preview(hostile, CTX)).rejects.toBeInstanceOf(
      AutomationLevelError,
    );
    expect(h.fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Re-verification of the QA-1 fix (resumed_after_partial_apply)    */
/* ------------------------------------------------------------------ */

describe("QA gate 5 — the QA-1 fix under repeated adversity", () => {
  it("crash → retry → crash AGAIN → retry: the original baseline survives every cycle; rollback restores it byte-exact", async () => {
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE), store });
    const preview = await h.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );

    // Crash window #1: site write lands, DB update fails.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(h.fake.post(POST_ID).title).toBe(APPROVED_TITLE);
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // Crash window #2: the RETRY takes the resumed branch, then crashes too.
    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
    // The persisted preview diff still carries the ORIGINAL baseline.
    expect(store.peek(preview.change.id)?.diff.before).toBe(ORIGINAL_TITLE);

    // Third attempt completes — with the original, not the after, as baseline.
    const retried = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retried.change.status).toBe("applied");
    expect(retried.change.diff.before).toBe(ORIGINAL_TITLE);
    expect(retried.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);

    const reverted = await h.manager.rollback(
      retried.change.id,
      { reason: "qa: undo after double-crash recovery" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("the resumed warning is DISTINCT: never drift_detected on resume, never resumed on genuine drift", async () => {
    // Resume case: crash then retry → exactly resumed_after_partial_apply.
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const resumed = harness({ seed: TITLE_SPEC.seed(ORIGINAL_TITLE), store });
    const p1 = await resumed.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    store.crashNextUpdate = true;
    await expect(resumed.manager.apply(p1.change.id, APPROVAL, CTX)).rejects.toThrow();
    const retried = await resumed.manager.apply(p1.change.id, APPROVAL, CTX);
    expect(retried.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(retried.warnings[0].message).toContain("resuming a partially-applied change");

    // Genuine drift (live is a THIRD value): exactly drift_detected,
    // re-baselined to the live state as before the fix — behavior unchanged.
    const drifted = harness({ seed: TITLE_SPEC.seed("Externally Edited Title") });
    const p2 = await drifted.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const applied = await drifted.manager.apply(p2.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBe("Externally Edited Title");
    await drifted.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(drifted.fake.post(POST_ID).title).toBe("Externally Edited Title");
  });

  it("a third party independently setting the EXACT after-value takes the resumed branch — still reversible to the previewed before", async () => {
    // Documented indistinguishability: live == after with a previewed row.
    // The safe branch keeps the previewed before, so rollback restores the
    // pre-change state instead of becoming a verified no-op.
    const h = harness({ seed: TITLE_SPEC.seed(APPROVED_TITLE) }); // site already shows after
    const preview = await h.manager.preview(
      desired(TITLE_SPEC, ORIGINAL_TITLE, APPROVED_TITLE),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(applied.change.diff.before).toBe(ORIGINAL_TITLE);

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    expect(h.fake.post(POST_ID).title).toBe(ORIGINAL_TITLE);
  });

  it("RESIDUAL (pinned, honest): resume with an adapter-invalid previewed before fails LOUDLY on every retry — never a false 'applied'", async () => {
    // Preview a meta change whose previewed before is null (stale crawl).
    // First apply: genuine drift (live is a real value) → baseline = live —
    // but the store crashes after the site write. The retry now sees
    // live == after and takes the resumed branch, whose baseline is the
    // null previewed before — which the adapter REFUSES (invalid_value).
    // The row stays 'previewed' with the site half-applied: an honest,
    // loud, human-escalation state — never a row claiming to be reversible
    // when it is not. Pinned so any future silent change here fails QA.
    const spec = KINDS.find((k) => k.kind === "post/meta")!;
    const store = new CrashOnUpdateStore({
      clock: steppingClock("2026-07-09T12:00:00.000Z"),
    });
    const h = harness({ seed: spec.seed("live-value"), store });
    const preview = await h.manager.preview(desired(spec, null, "x"), CTX);

    store.crashNextUpdate = true;
    await expect(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrow("database unavailable");
    expect(spec.read(h.fake)).toBe("x"); // half-applied

    // Every retry refuses loudly at plan time — no write, no false status.
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "invalid_value",
    );
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Registered-meta fidelity (real-WP semantics in the fake)         */
/* ------------------------------------------------------------------ */

describe("QA gate 6 — registered-meta fidelity: whitelist, [] quirk, 400 envelope", () => {
  const metaSpec = KINDS.find((k) => k.kind === "post/meta")!;

  it("an UNREGISTERED target key is refused as target_missing at before-capture — WP would silently drop the write", async () => {
    const h = harness({
      seed: {
        ...metaSpec.seed("stored-but-unregistered"),
        registeredMeta: { some_other_key: "string" }, // target key NOT registered
      },
    });
    const preview = await h.manager.preview(
      desired(metaSpec, "stored-but-unregistered", "new-value"),
      CTX,
    );
    await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "target_missing",
    );
    expect(postRequests(h.fake)).toHaveLength(0); // refused BEFORE any write
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("ZERO registered keys (the PHP meta-as-[] quirk) is refused as target_missing, not a crash or a false write", async () => {
    const h = harness({
      seed: { ...metaSpec.seed("stored"), registeredMeta: {} },
    });
    const preview = await h.manager.preview(desired(metaSpec, "stored", "new"), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "target_missing",
    );
    expect(err.message).toContain("not exposed by this site's REST API");
    expect(postRequests(h.fake)).toHaveLength(0);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
  });

  it("a REGISTERED key round-trips byte-exact under fidelity mode, from the registered default onward", async () => {
    // Never-written registered string key: live reads as the REST default "".
    const h = harness({
      seed: {
        posts: { [POST_ID]: { title: SIBLING_TITLE, content: SIBLING_CONTENT } },
        registeredMeta: { [TARGET_META_KEY]: "string" },
      },
    });
    const preview = await h.manager.preview(desired(metaSpec, "", "aeo description"), CTX);
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings).toEqual([]);
    expect(applied.change.diff.before).toBe("");
    expect(h.fake.post(POST_ID).meta[TARGET_META_KEY]).toBe("aeo description");

    await h.manager.rollback(applied.change.id, { reason: "qa: undo" }, CTX);
    // Restored to the captured default — and the REST view agrees.
    expect(h.fake.post(POST_ID).meta[TARGET_META_KEY]).toBe("");
  });

  it("a registered-type mismatch on APPLY fails as vendor_failure(400 rest_invalid_param) — row previewed, site unchanged, retry path open", async () => {
    const h = harness({
      seed: {
        posts: {
          [POST_ID]: {
            title: SIBLING_TITLE,
            content: SIBLING_CONTENT,
            meta: { [TARGET_META_KEY]: "current" },
          },
        },
        registeredMeta: { [TARGET_META_KEY]: "string" },
      },
    });
    // The approved after is a number on a string-registered key.
    const preview = await h.manager.preview(desired(metaSpec, "current", 42), CTX);
    const err = await expectFailure(
      h.manager.apply(preview.change.id, APPROVAL, CTX),
      "vendor_failure",
    );
    expect(err.httpStatus).toBe(400);
    expect(h.store.peek(preview.change.id)?.status).toBe("previewed");
    expect(h.fake.post(POST_ID).meta[TARGET_META_KEY]).toBe("current"); // no state change
  });
});

/* ------------------------------------------------------------------ */
/* 4. Partial-batch rollback — mixed kinds, mid-write failure          */
/* ------------------------------------------------------------------ */

describe("QA gate 4 — partial batch: member 2 fails MID-WRITE, prefix rolls back byte-exact", () => {
  it("batch of 3 (title, content, alt): #2's write half-lands and fails verification; #1 reverts byte-exact; #3 never attempted; statuses truthful", async () => {
    const originalTitle = "Post One — original";
    const originalContent = "<p>Post Two — original body</p>";
    const originalAlt = "original alt 🖼";
    const h = harness({
      seed: {
        posts: {
          1: { title: originalTitle, content: "<p>one</p>" },
          2: { title: "Post Two", content: originalContent },
        },
        media: { 9: { altText: originalAlt } },
      },
    });

    const approvedTitle = "Post One | Approved";
    // Member 2's approved content carries a marker the site's filters strip —
    // the write LANDS (mutated) but cannot verify byte-exact.
    const approvedContent = '<p data-qa="approved">Post Two — approved body</p>';
    const approvedAlt = "approved alt";

    const batch = await h.manager.previewBatch(
      [
        {
          ...desired({ changeType: "title", locator: wordpressLocators.postTitle(1) }, originalTitle, approvedTitle),
        },
        {
          ...desired({ changeType: "content", locator: wordpressLocators.postContent(2) }, originalContent, approvedContent),
        },
        {
          ...desired({ changeType: "alt", locator: wordpressLocators.mediaAltText(9) }, originalAlt, approvedAlt),
        },
      ],
      CTX,
    );
    const [m1, m2, m3] = batch.members.map((m) => m.change.id);

    // The site strips data-qa attributes on write (kses-style filter).
    h.fake.mutateWrites((v) => v.replace(/ data-qa="[^"]*"/g, ""));

    const report = await h.manager.applyBatch(batch, APPROVAL, CTX);

    // EXACT accounting: applied prefix / failed member / untouched tail.
    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([m1]);
    expect(report.failed?.changeId).toBe(m2);
    if (!isWriteMethodError(report.failed?.error)) {
      throw new Error("expected the failed member to carry a WriteMethodError");
    }
    expect(report.failed.error.code).toBe("write_verification_failed");
    expect(report.notAttempted).toEqual([m3]);

    // Statuses truthful for all three members.
    expect(h.store.peek(m1)?.status).toBe("applied");
    expect(h.store.peek(m2)?.status).toBe("previewed"); // never claimed applied
    expect(h.store.peek(m3)?.status).toBe("previewed");

    // #3 was NEVER attempted — not even a read reached media/9.
    expect(h.fake.requests.some((r) => r.url.includes("/media/9"))).toBe(false);

    // The site state is exactly what the report says: #1 applied, #2 holds the
    // filter-mutated value (the surfaced honest mess), alt untouched.
    expect(h.fake.post(1).title).toBe(approvedTitle);
    expect(h.fake.post(2).content).toBe("<p>Post Two — approved body</p>");
    expect(h.fake.media(9).altText).toBe(originalAlt);

    // The applied prefix rolls back byte-exact through the same adapter.
    const reverted = await h.manager.rollback(
      m1,
      { reason: "qa: batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(reverted.change.status).toBe("reverted");
    expect(h.fake.post(1).title).toBe(originalTitle);

    // Final statuses: reverted / previewed / previewed — nothing lies.
    expect(h.store.peek(m1)?.status).toBe("reverted");
    expect(h.store.peek(m2)?.status).toBe("previewed");
    expect(h.store.peek(m3)?.status).toBe("previewed");
  });
});
