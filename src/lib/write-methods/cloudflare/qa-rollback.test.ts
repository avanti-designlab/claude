/**
 * QA ROLLBACK GATE — Cloudflare edge worker write method (method 4/4, commit
 * 7feb288). Written INDEPENDENTLY by the qa-testing agent (doc 04 §2: "a write
 * method cannot ship until its rollback path is proven"; doc 07 block 1.3).
 * This suite deliberately re-derives the safety claims instead of trusting
 * the engineer's tests, and drives everything through the REAL ChangeManager
 * (the 1.2 pipeline) wherever a pipeline seam exists.
 *
 * THE INVERSION UNDER TEST: on this method a "write" upserts ONE rule slot in
 * a versioned KV manifest; the origin is NEVER touched. Rollback = restoring
 * the prior RULE state — including absence, which is first-class here (a
 * null before-state means "remove the rule entirely"; the untouched origin
 * shows through). The gates below:
 *
 *  1. Round-trip exhaustive: every rule op × edge payloads (empty, unicode/
 *     emoji/RTL, HTML-hostile, long, nested JSON-LD), preview → apply →
 *     manifest byte-exact → rollback → prior state byte-exact INCLUDING the
 *     absent case. Grammar completeness is pinned at COMPILE TIME
 *     (`satisfies Record<EdgeRuleOp, ...>` — a sixth op turns this suite red
 *     until it is covered). Canonical-serialization stability: apply+revert
 *     leaves the manifest byte-identical to the original except EXACTLY
 *     {version, updatedAt} — pinned by re-serializing the seed with only
 *     those two fields overridden.
 *  2. The null-before inversion: apply-then-rollback of a never-existed rule
 *     REMOVES it (not disable, not empty payload). Pinned honest residue:
 *     the manifest KEY itself is not deleted — an empty-rules manifest
 *     remains (version advanced), and the WORKER treats it as pass-through.
 *  3. Adversity: deleted namespace, token rotated between the revert's read
 *     and its PUT, 429 both directions (Retry-After whitelist), the QA-1
 *     crash windows THROUGH this adapter (incl. non-null-before, double
 *     crash, crash-after-revert), concurrent writer/deleter between PUT and
 *     verification (LOUD — the pinned anti-Wix contrast, both directions),
 *     torn/foreign/tampered-id manifests refused without a clobber, version
 *     regression/tie/saturation behavior.
 *  4. Worker-half behavioral QA over the PURE functions + handleRequest with
 *     a streaming HTML fixture (no CF runtime): each op applied on a
 *     matching page, non-matching path untouched (object identity), disabled
 *     rules inert, hostile payloads escaped in the RENDERED page (no script
 *     breakout), fail-open identity on every constructible failure input,
 *     x-edge-autofix header exactness, no-store on rewritten vs untouched
 *     caching on pass-through.
 *     FIDELITY NOTE for the streaming fixture: it models lol-html's escaping
 *     minimally — setInnerContent({html:false}) entity-escapes & < > and
 *     attribute serialization escapes only & and " (the minimum the runtime
 *     guarantees). Escaping the injected `</head>` HTML is NOT modeled — it
 *     is inserted raw (html:true), so those assertions exercise the SHIPPED
 *     escaping in rules.ts, not this fake. Handler journals additionally pin
 *     the raw-value/options contract handed to the runtime.
 *  5. Auto-rollback policy modes (off / flag / execute) through this
 *     adapter, threshold boundary exactness, failed auto-revert honesty.
 *  6. Partial batch: middle member fails on 429 AND on write-verification —
 *     exact prefix, tail never requested (journal-proven), prefix rollback
 *     byte-exact.
 *  7. No-silent-failure sweep of every adapter catch/branch (every failure
 *     is a typed WriteMethodError; vendor free text and credentials never
 *     surface). The assertRuleOperable slot-coordinate mismatch branch is
 *     documented belt-and-braces: parseManifest already enforces
 *     id === derivation, so the branch is unreachable without a parser
 *     regression — it is intentionally NOT covered rather than faked.
 *
 * All HTTP is the injected FakeCloudflareKv / ScriptedFetch — no network.
 * No source file is modified by this suite.
 */

import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  fixedClock,
  steppingClock,
  type AdapterWrite,
  type AlertDraft,
  type AutoRollbackPolicy,
  type ChangePatch,
  type Clock,
  type DesiredChange,
  type MonitoredMetric,
  type MonitoringSignal,
  type TenantContext,
} from "@/lib/change-management";
import { VendorCredential, type SecretsResolver } from "@/lib/connectors";
import type { Json, SiteChangeRow, SiteChangeType } from "@/lib/types/db";
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_KEY,
  base64UrlEncode,
  edgeRuleId,
  parseManifest,
  serializeManifest,
  type EdgeRule,
  type EdgeRuleOp,
  type EdgeRuleSeed,
} from "../../../../workers/edge-autofix/src/manifest";
import {
  handleRequest,
  type EdgeAutofixEnv,
  type HtmlRewriterConstructor,
  type HtmlRewriterLike,
  type RewriterElementLike,
  type RewriterEndTagLike,
  type WorkerDeps,
} from "../../../../workers/edge-autofix/src/worker";
import {
  isWriteMethodError,
  WriteMethodError,
  type WriteMethodErrorCode,
} from "../shared/errors";
import type { FetchPort } from "../shared/http";
import {
  htmlResponse,
  jsonResponse,
  ScriptedFetch,
  textResponse,
  type ScriptedHandler,
} from "../shared/http-harness";
import { CloudflareEdgeAdapter, CLOUDFLARE_API_HOST } from "./adapter";
import { FakeCloudflareKv } from "./fake-cloudflare";
import { edgeLocators, parseEdgeTarget, ruleFor, ruleValueOf } from "./target";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SECRET = "cf-qa-4dv3rsari4l-t0ken-5ecret";

const ACCOUNT_ID = "aabbccddeeff00112233445566778899";
const NAMESPACE_ID = "0123456789abcdef0123456789abcdef";
const ZONE_ID = "99887766554433221100ffeeddccbbaa";
const SCRIPT_NAME = "edge-autofix-qa-client";

/** The ONE URL this method may ever touch — the positive traffic whitelist. */
const MANIFEST_URL = `${CLOUDFLARE_API_HOST}/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${MANIFEST_KEY}`;

const PAGE_PATH = "/qa-page";
const PAGE_URL = `https://qa-client.example${PAGE_PATH}`;

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-qa", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };
const ADAPTER_CTX = { tenantId: "t1", clientId: "c1", propertyId: "prop-1" };

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
  fake: FakeCloudflareKv;
  manager: ChangeManager;
  store: CrashOnUpdateStore;
  alerts: AlertDraft[];
}

function harness(opts?: {
  values?: Record<string, string>;
  policy?: AutoRollbackPolicy;
  wrapPort?: (port: FetchPort, fake: FakeCloudflareKv) => FetchPort;
  adapterClock?: Clock;
}): Harness {
  const fake = new FakeCloudflareKv({
    apiToken: SECRET,
    accountId: ACCOUNT_ID,
    namespaceId: NAMESPACE_ID,
    values: opts?.values,
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const clock = steppingClock("2026-07-09T14:00:00.000Z");
  const adapter = new CloudflareEdgeAdapter({
    pin: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      accountId: ACCOUNT_ID,
      zoneId: ZONE_ID,
      scriptName: SCRIPT_NAME,
      namespaceId: NAMESPACE_ID,
    },
    secrets,
    authRef: "vault://cloudflare/prop-1",
    fetch: opts?.wrapPort ? opts.wrapPort(fake.port, fake) : fake.port,
    clock: opts?.adapterClock ?? clock,
  });
  const store = new CrashOnUpdateStore({ clock });
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
  spec: { changeType: SiteChangeType; locator?: string; url?: string },
  before: Json,
  after: Json,
): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "edge_worker",
    changeType: spec.changeType,
    target: { url: spec.url ?? PAGE_URL, locator: spec.locator },
    before,
    after,
  };
}

function seedManifest(
  rules: EdgeRule[],
  version = 41,
  updatedAt = "2026-07-01T00:00:00.000Z",
): string {
  return serializeManifest({
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    updatedAt,
    rules,
  });
}

function mrule<T extends EdgeRuleSeed>(seed: T): T & { id: string } {
  return { ...seed, id: edgeRuleId(seed) };
}

/**
 * Positive traffic contract: every request this method emits is a GET or PUT
 * on EXACTLY the pinned account+namespace manifest URL, Bearer-authed, with
 * redirect refused. There is no other endpoint — and the client's own domain
 * appears in no request (the origin is never touched, at the transport level).
 */
function expectPinnedTraffic(fake: FakeCloudflareKv): void {
  expect(fake.requests.length).toBeGreaterThan(0);
  for (const req of fake.requests) {
    expect(req.url).toBe(MANIFEST_URL);
    expect(["GET", "PUT"]).toContain(req.method);
    expect(req.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(req.redirect).toBe("error");
    expect(req.url).not.toContain("qa-client.example");
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
  expect(thrown.method).toBe("edge_worker");
  return thrown;
}

function signal(metric: MonitoredMetric, deltaPct: number): MonitoringSignal {
  return {
    metric,
    deltaPct,
    windowDays: 7,
    observedAt: "2026-07-09T16:00:00.000Z",
    detail: "qa:scripted",
  };
}

/* ------------------------------------------------------------------ */
/* QA gate 1 — round-trip exhaustive + grammar-completeness pin        */
/* ------------------------------------------------------------------ */

interface KindSpec {
  changeType: SiteChangeType;
  locator: string;
  values: ReadonlyArray<{ label: string; value: Json }>;
  /** A non-null prior rule value for the upsert-over-prior cycles. */
  prior: Json;
}

const STRING_SHAPES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "empty string (legal for text slots)", value: "" },
  {
    label: "unicode + emoji + RTL",
    value: "מחירון — أسعار الخدمات — 私たちの料金 🚀 café",
  },
  {
    label: "</script> breakout probe",
    value: "</script><script>alert(1)</script>",
  },
  {
    label: "quote/angle attribute breakout probe",
    value: '"><meta http-equiv="refresh" content="0;url=https://evil.example">',
  },
  {
    label: "manifest-lookalike JSON string",
    value: '{"format":"edge-autofix/rules","rules":[]}',
  },
  {
    label: "~10k chars with surrogate pairs",
    value: ("𝕬" + "x".repeat(97) + "🚀").repeat(100),
  },
  {
    label: "whitespace, newline, tab, U+2028",
    value: "  leading\n\tinner  line-sep trailing  ",
  },
];

const CANONICAL_SHAPES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "plain https", value: "https://qa-client.example/pricing" },
  { label: "plain http (legal)", value: "http://qa-client.example/pricing" },
  {
    label: "2k-char query string",
    value: `https://qa-client.example/pricing?p=${"q".repeat(2048)}`,
  },
  {
    label: "unicode path + query",
    value: "https://qa-client.example/مسار/価格?q=café🚀",
  },
  {
    label: "hostile path characters",
    value: 'https://qa-client.example/"><script>alert(1)</script>',
  },
];

const JSONLD_SHAPES: ReadonlyArray<{ label: string; value: Json }> = [
  { label: "empty object (minimal legal block)", value: {} },
  {
    label: "nested schema with hostile strings + numbers/bool/null",
    value: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "</script><script>alert(1)</script>",
          acceptedAnswer: {
            "@type": "Answer",
            text: 'ציטוט — "quoted" & <b>bold</b> 🚀',
          },
        },
      ],
      empties: { s: "", arr: [], obj: {} },
      numbers: [0, -1, 2.5, 1e21],
      flags: [true, false, null],
    },
  },
  {
    label: "unicode keys + RTL values",
    value: { "名前🚀": "value", "مفتاح": ["مرحبا", ""], "עומק": { in: "שלום" } },
  },
  {
    label: "JS line separators U+2028/U+2029 in values",
    value: { line: "a b c" },
  },
];

/**
 * GRAMMAR-COMPLETENESS PIN (compile-time): this table `satisfies
 * Record<EdgeRuleOp, KindSpec>`. If the manifest format ever grows a sixth
 * operation, this file stops typechecking until the new op gets round-trip
 * coverage — the suite cannot silently under-cover the grammar.
 */
const SPECS = {
  set_title: {
    changeType: "title",
    locator: edgeLocators.title(),
    values: STRING_SHAPES,
    prior: "Prior title — v1 🚀",
  },
  set_meta_description: {
    changeType: "meta",
    locator: edgeLocators.metaDescription(),
    values: STRING_SHAPES,
    prior: "Prior description — v1",
  },
  set_canonical: {
    changeType: "canonical",
    locator: edgeLocators.canonical(),
    values: CANONICAL_SHAPES,
    prior: "https://qa-client.example/prior-canonical",
  },
  upsert_json_ld: {
    changeType: "schema",
    locator: edgeLocators.jsonLd("faq"),
    values: JSONLD_SHAPES,
    prior: { "@type": "Thing", name: "prior block" },
  },
  set_img_alt: {
    changeType: "alt",
    locator: edgeLocators.imgAlt("/hero.jpg"),
    values: STRING_SHAPES,
    prior: "prior alt text",
  },
} satisfies Record<EdgeRuleOp, KindSpec>;

const OPS = Object.keys(SPECS) as EdgeRuleOp[];

function addressOf(op: EdgeRuleOp) {
  return parseEdgeTarget({ url: PAGE_URL, locator: SPECS[op].locator });
}

describe("QA gate 1 — round-trip property across EVERY rule op × edge payloads", () => {
  it("runtime grammar pin: exactly five ops, each locator parses to its own slot and back", () => {
    expect([...OPS].sort()).toEqual([
      "set_canonical",
      "set_img_alt",
      "set_meta_description",
      "set_title",
      "upsert_json_ld",
    ]);
    const slots = new Set<string>();
    for (const op of OPS) {
      const address = addressOf(op);
      const rule = ruleFor(address.op, PAGE_PATH, SPECS[op].prior);
      expect(rule.op).toBe(op); // the spec key IS the manifest op — no drift
      expect(rule.id).toBe(address.ruleId);
      expect(ruleValueOf(rule)).toEqual(SPECS[op].prior);
      slots.add(address.ruleId);
    }
    expect(slots.size).toBe(OPS.length); // five DISTINCT slots on one page
  });

  for (const op of OPS) {
    const spec = SPECS[op];
    describe(`${op} — apply-from-absence → byte-exact manifest → rollback REMOVES the slot`, () => {
      for (const { label, value } of spec.values) {
        it(`round-trips ${label}`, async () => {
          const { fake, manager, store } = harness();

          const preview = await manager.preview(desired(spec, null, value), CTX);
          expect(fake.requests).toHaveLength(0); // PREVIEW writes nothing

          const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
          expect(applied.warnings).toEqual([]);
          expect(applied.change.status).toBe("applied");
          // Audit row: before = PRIOR RULE STATE (absent). Never origin HTML.
          expect(applied.change.diff).toEqual({
            before: null,
            after: value,
            target: { url: PAGE_URL, locator: spec.locator },
          });

          // Manifest state: canonical bytes stored, exactly one enabled rule
          // in the derived slot carrying the value byte-exact.
          const text1 = fake.value(MANIFEST_KEY);
          expect(text1).not.toBeNull();
          const m1 = parseManifest(text1!)!;
          expect(serializeManifest(m1)).toBe(text1); // canonical form stored
          const address = addressOf(op);
          expect(m1.rules).toEqual([ruleFor(address.op, PAGE_PATH, value)]);
          expect(m1.version).toBe(1);
          expect(ruleValueOf(m1.rules[0])).toEqual(value);

          // ROLLBACK: one action, same adapter — the slot is REMOVED
          // entirely (the null/absent before-state is first-class here).
          await manager.rollback(
            applied.change.id,
            { reason: "qa: round-trip revert" },
            CTX,
          );
          const text2 = fake.value(MANIFEST_KEY)!;
          const m2 = parseManifest(text2)!;
          expect(m2.rules).toEqual([]); // removed — not disabled, not emptied
          expect(text2).not.toContain(address.ruleId);
          expect(m2.version).toBe(2); // version BUMPS on revert (see gate 2 pin)
          expect(store.peek(applied.change.id)?.status).toBe("reverted");

          expectPinnedTraffic(fake);
        });
      }

      it("round-trips OVER a prior rule: upsert replaces the slot, rollback restores the prior manifest byte-exact modulo {version, updatedAt}", async () => {
        const address = addressOf(op);
        const priorRule = ruleFor(address.op, PAGE_PATH, spec.prior);
        // A sibling rule on ANOTHER page rides along — collateral detector.
        const sibling = mrule({
          enabled: true,
          path: "/sibling",
          op: "set_title" as const,
          payload: { text: "sibling title (must never change)" },
        });
        const seedText = seedManifest([priorRule, sibling], 41);
        const { fake, manager, store } = harness({
          values: { [MANIFEST_KEY]: seedText },
        });

        const value = spec.values[1].value;
        const preview = await manager.preview(
          desired(spec, spec.prior, value),
          CTX,
        );
        const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
        expect(applied.warnings).toEqual([]); // live rule matched the preview

        const m1 = parseManifest(fake.value(MANIFEST_KEY)!)!;
        expect(m1.version).toBe(42);
        expect(m1.rules.find((r) => r.id === address.ruleId)).toEqual(
          ruleFor(address.op, PAGE_PATH, value),
        );
        expect(m1.rules.find((r) => r.id === sibling.id)).toEqual(sibling);
        expect(m1.rules).toHaveLength(2); // replaced its slot — never a duplicate

        await manager.rollback(
          applied.change.id,
          { reason: "qa: restore prior rule version" },
          CTX,
        );
        const finalText = fake.value(MANIFEST_KEY)!;
        const finalM = parseManifest(finalText)!;
        // CANONICAL-SERIALIZATION STABILITY PIN: the reverted manifest is
        // byte-identical to the seed with ONLY version and updatedAt
        // overridden — no other byte may differ.
        expect(finalM.version).toBe(43); // 41 → 42 (apply) → 43 (revert)
        expect(finalText).toBe(
          serializeManifest({
            ...parseManifest(seedText)!,
            version: finalM.version,
            updatedAt: finalM.updatedAt,
          }),
        );
        expect(store.peek(applied.change.id)?.status).toBe("reverted");
        expectPinnedTraffic(fake);
      });
    });
  }

  it("unrepresentable grammar refuses at plan time — regex/CSS/robots/origin-JSON-LD never reach an HTTP call, the row stays previewed", async () => {
    const probes: Array<string | undefined> = [
      undefined, // no locator at all
      "",
      "edge:regex/replace",
      "edge:css/head>title",
      "edge:robots",
      "edge:noindex",
      "edge:redirect",
      "title", // bare name without the edge: namespace
      "edge:jsonld/", // empty script id
      "edge:jsonld/bad id!", // grammar violation
      `edge:jsonld/${"x".repeat(65)}`, // over-long script id
      "edge:img.alt/", // empty discriminator
      "edge:img.alt/%%%", // not base64url
      `edge:img.alt/${base64UrlEncode("")}`, // empty decoded src
      `edge:img.alt/${base64UrlEncode("bad src")}`, // control chars
    ];
    for (const locator of probes) {
      const { fake, manager, store } = harness();
      const preview = await manager.preview(
        desired({ changeType: "title", locator }, null, "T"),
        CTX,
      );
      await expectFailure(
        manager.apply(preview.change.id, APPROVAL, CTX),
        "unsupported_operation",
      );
      expect(fake.requests).toHaveLength(0);
      expect(store.peek(preview.change.id)?.status).toBe("previewed");
    }
  });

  it("an img src embedding credentials is refused without echoing them", async () => {
    const { fake, manager } = harness();
    const preview = await manager.preview(
      desired(
        {
          changeType: "alt",
          locator: edgeLocators.imgAlt(
            "https://user:s3cr3t-pw@qa-client.example/hero.jpg",
          ),
        },
        null,
        "alt",
      ),
      CTX,
    );
    const err = await expectFailure(
      manager.apply(preview.change.id, APPROVAL, CTX),
      "unsupported_operation",
    );
    expect(err.message).not.toContain("s3cr3t-pw");
    expect(fake.requests).toHaveLength(0);
  });

  it("non-installable values (BOTH sides) are refused at plan time, never at rollback time — zero requests", async () => {
    const cases: Array<{
      spec: { changeType: SiteChangeType; locator: string };
      before: Json;
      after: Json;
      redacted?: string;
    }> = [
      { spec: SPECS.set_title, before: null, after: 42 },
      { spec: SPECS.set_title, before: null, after: { text: "obj" } },
      { spec: SPECS.set_canonical, before: null, after: "" },
      { spec: SPECS.set_canonical, before: null, after: "/relative/path" },
      { spec: SPECS.set_canonical, before: null, after: "javascript:alert(1)" },
      {
        spec: SPECS.set_canonical,
        before: null,
        after: "https://user:c4nary-pw@site.example/x",
        redacted: "c4nary-pw",
      },
      { spec: SPECS.upsert_json_ld, before: null, after: ["array"] },
      { spec: SPECS.upsert_json_ld, before: null, after: "string" },
      { spec: SPECS.upsert_json_ld, before: null, after: 7 },
      { spec: SPECS.set_img_alt, before: null, after: true },
    ];
    for (const c of cases) {
      // Through the pipeline: the manager's before-capture read may run, but
      // the write path refuses BOTH directions before any PUT — no write, no
      // half-state, the row stays previewed.
      const { fake, manager, store } = harness();
      const preview = await manager.preview(
        desired(c.spec, c.before, c.after),
        CTX,
      );
      const err = await expectFailure(
        manager.apply(preview.change.id, APPROVAL, CTX),
        "invalid_value",
      );
      if (c.redacted) expect(err.message).not.toContain(c.redacted);
      expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
      expect(fake.value(MANIFEST_KEY)).toBeNull();
      expect(store.peek(preview.change.id)?.status).toBe("previewed");

      // Directly at the adapter: the gate is PRE-NETWORK in both directions
      // (this is what guarantees rollback can never discover an impossible
      // restore — the same shapes are refused before revert's first request).
      const direct = directAdapter();
      const write: AdapterWrite = {
        target: { url: PAGE_URL, locator: c.spec.locator },
        before: c.before,
        after: c.after,
        ctx: ADAPTER_CTX,
      };
      await expectFailure(direct.adapter.apply(write), "invalid_value");
      await expectFailure(direct.adapter.revert(write), "invalid_value");
      expect(direct.fake.requests).toHaveLength(0);
    }
  });

  it("an INVALID persisted 'before' is gated in both directions at the adapter (pre-network) — and through the manager it can never become a rollback baseline", async () => {
    // (a) The adapter refuses the shape outright, in BOTH directions, before
    // any request — rollback can never discover an impossible restore.
    const direct = directAdapter();
    const invalidBefore: AdapterWrite = {
      target: { url: PAGE_URL, locator: SPECS.set_title.locator },
      before: 42,
      after: "fine",
      ctx: ADAPTER_CTX,
    };
    await expectFailure(direct.adapter.apply(invalidBefore), "invalid_value");
    await expectFailure(direct.adapter.revert(invalidBefore), "invalid_value");
    expect(direct.fake.requests).toHaveLength(0);

    // (b) Through the manager, when the LIVE state differs from the after:
    // the drift re-baseline replaces the bogus previewed before with the
    // TRUE live state (null) — the invalid value never becomes the baseline,
    // and rollback restores the honest live prior.
    const drift = harness();
    const preview = await drift.manager.preview(
      desired(SPECS.set_title, 42, "fine"),
      CTX,
    );
    const applied = await drift.manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBeNull(); // re-baselined, not 42
    await drift.manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    expect(parseManifest(drift.fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);

    // (c) The one path where the bogus before WOULD survive — the resumed-
    // after-partial-apply branch (live already equals our after) — refuses
    // loudly instead: invalid_value on every retry, the row never leaves
    // 'previewed', no write happens. The same honest residual pinned at the
    // WordPress gate (ops surface for stuck-previewed rows is the known
    // carried ticket iii).
    const address = addressOf("set_title");
    const resumed = harness({
      values: {
        [MANIFEST_KEY]: seedManifest(
          [ruleFor(address.op, PAGE_PATH, "fine")],
          2,
        ),
      },
    });
    const stuck = await resumed.manager.preview(
      desired(SPECS.set_title, 42, "fine"),
      CTX,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectFailure(
        resumed.manager.apply(stuck.change.id, APPROVAL, CTX),
        "invalid_value",
      );
      expect(resumed.store.peek(stuck.change.id)?.status).toBe("previewed");
    }
    expect(
      resumed.fake.requests.filter((r) => r.method === "PUT"),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 2 — the null-before inversion                               */
/* ------------------------------------------------------------------ */

describe("QA gate 2 — null-before inversion: rollback of a never-existed rule REMOVES it", () => {
  it("apply-from-nothing then rollback: the rule is gone (not disabled, not emptied); the honest residue is an EMPTY manifest — which the worker passes through", async () => {
    const { fake, manager, store } = harness();
    expect(fake.value(MANIFEST_KEY)).toBeNull(); // truly no manifest yet

    const preview = await manager.preview(
      desired(SPECS.set_title, null, "Never existed before"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const address = addressOf("set_title");
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toEqual([
      ruleFor(address.op, PAGE_PATH, "Never existed before"),
    ]);

    await manager.rollback(applied.change.id, { reason: "qa: inversion" }, CTX);
    const text = fake.value(MANIFEST_KEY);

    // PINNED RESIDUE — exactly this, no more, no less:
    //  - the KV KEY still exists (the adapter has no DELETE verb; absence of
    //    the RULE, not of the manifest, is the restored state);
    //  - rules is byte-exactly [] — no disabled twin, no empty-payload twin;
    //  - version advanced to 2 (apply +1, revert +1 — revert BUMPS the
    //    monotonic counter, it never restores the pre-apply number);
    //  - updatedAt is the revert-time stamp.
    expect(text).not.toBeNull();
    const m = parseManifest(text!)!;
    expect(m.rules).toEqual([]);
    expect(text).not.toContain(address.ruleId);
    expect(text).not.toContain('"enabled":false');
    expect(m.version).toBe(2);
    expect(m.format).toBe(MANIFEST_FORMAT);
    expect(store.peek(applied.change.id)?.status).toBe("reverted");

    // Cross-half proof: the WORKER treats the residue as a strict
    // pass-through — the origin object comes back untouched, identity-equal.
    const origin = new Response("<html><head></head><body>o</body></html>", {
      status: 200,
      headers: { "content-type": "text/html", "cache-control": "max-age=60" },
    });
    const out = await handleRequest(
      new Request(PAGE_URL),
      { EDGE_RULES: { get: async () => fake.value(MANIFEST_KEY) } },
      { originFetch: async () => origin, rewriter: makeRewriter("") },
    );
    expect(out).toBe(origin);
    expect(out.headers.get("x-edge-autofix")).toBeNull();
  });

  it("against a pre-existing manifest: apply+rollback of a new slot leaves the manifest byte-equal to pre-apply modulo EXACTLY {version, updatedAt}", async () => {
    const siblings = [
      mrule({
        enabled: true,
        path: "/other",
        op: "set_meta_description" as const,
        payload: { content: "sibling description" },
      }),
      mrule({
        enabled: false, // an ops-disabled sibling rides along UNTOUCHED
        path: "/killed",
        op: "set_title" as const,
        payload: { text: "disabled sibling" },
      }),
    ];
    const seedText = seedManifest(siblings, 7);
    const { fake, manager } = harness({ values: { [MANIFEST_KEY]: seedText } });

    const preview = await manager.preview(
      desired(SPECS.upsert_json_ld, null, { "@type": "FAQPage" }),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    await manager.rollback(applied.change.id, { reason: "qa: inversion" }, CTX);

    const finalText = fake.value(MANIFEST_KEY)!;
    const finalM = parseManifest(finalText)!;
    const seedM = parseManifest(seedText)!;
    // Field-exact pin: everything except version/updatedAt is IDENTICAL.
    expect({ ...finalM, version: 0, updatedAt: "" }).toEqual({
      ...seedM,
      version: 0,
      updatedAt: "",
    });
    expect(finalM.version).toBe(9); // 7 → 8 → 9
    expect(finalM.updatedAt).not.toBe(seedM.updatedAt);
    // Byte-exact modulo exactly those two fields.
    expect(finalText).toBe(
      serializeManifest({
        ...seedM,
        version: finalM.version,
        updatedAt: finalM.updatedAt,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 3 — adversity                                               */
/* ------------------------------------------------------------------ */

describe("QA gate 3 — adversity: rollback truth under deleted/rotated/limited/racing storage", () => {
  it("namespace deleted after apply: rollback fails target_missing at the READ — no PUT is even attempted, the row stays 'applied'", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const putsBefore = fake.requests.filter((r) => r.method === "PUT").length;

    fake.deleteNamespace();
    await expectFailure(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
      "target_missing",
    );
    expect(store.peek(applied.change.id)?.status).toBe("applied");
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(
      putsBefore, // refusal happened before any write
    );
  });

  it("token rotated BETWEEN the revert's manifest read and its PUT: credential_rejected, manifest untouched, row stays 'applied'; reconnecting completes the same rollback", async () => {
    let armed = false;
    const { fake, manager, store } = harness({
      wrapPort: (port, f) => async (url, init) => {
        if (armed && init.method === "PUT") {
          f.rotateToken("rotated-mid-flight");
          armed = false;
        }
        return port(url, init);
      },
    });
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const appliedText = fake.value(MANIFEST_KEY)!;

    armed = true; // the rotation lands after the read, before the write
    const err = await expectFailure(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
      "credential_rejected",
    );
    expect(err.message).not.toContain(SECRET);
    expect(fake.value(MANIFEST_KEY)).toBe(appliedText); // auth precedes storage
    expect(store.peek(applied.change.id)?.status).toBe("applied");

    fake.rotateToken(SECRET);
    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("429 on the APPLY direction (the PUT itself): rate_limited with whitelisted Retry-After, manifest untouched, row 'previewed', NOTHING retried automatically", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    fake.failPut(1, 429, 10015);
    const err = await expectFailure(
      manager.apply(preview.change.id, APPROVAL, CTX),
      "rate_limited",
    );
    expect(err.retryAfterSeconds).toBeUndefined(); // no header given
    expect(err.message).toContain("shortly");
    expect(fake.value(MANIFEST_KEY)).toBeNull();
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
    // No automatic retry: readCurrent GET + manifest GET + the rejected PUT.
    expect(fake.requests).toHaveLength(3);

    const retry = await manager.apply(preview.change.id, APPROVAL, CTX); // human re-runs
    expect(retry.change.status).toBe("applied");
  });

  it("429 on the REVERT direction with a GARBAGE Retry-After: rate_limited, header dropped (never echoed), row stays 'applied'; the same rollback completes later", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.rateLimitNext('run this: <script>alert("Retry-After")</script>');
    const err = await expectFailure(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
      "rate_limited",
    );
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.message).not.toContain("<script>");
    expect(store.peek(applied.change.id)?.status).toBe("applied");
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toHaveLength(1);

    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("QA-1 with a PRIOR rule: store crash after the manifest write; the retry keeps the persisted 'v1' before (resumed_after_partial_apply) — rollback restores v1, never our own v2", async () => {
    const address = addressOf("set_title");
    const prior = ruleFor(address.op, PAGE_PATH, "Prior title v1");
    const { fake, manager, store } = harness({
      values: { [MANIFEST_KEY]: seedManifest([prior], 3) },
    });
    const preview = await manager.preview(
      desired(SPECS.set_title, "Prior title v1", "Approved v2"),
      CTX,
    );

    store.crashNextUpdate = true;
    await expect(
      manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrowError(/database unavailable/);
    // The documented ordering window: manifest already rewritten, row not.
    expect(
      ruleValueOf(parseManifest(fake.value(MANIFEST_KEY)!)!.rules[0]),
    ).toBe("Approved v2");
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(outcome.change.diff.before).toBe("Prior title v1"); // NEVER "Approved v2"

    await manager.rollback(outcome.change.id, { reason: "qa" }, CTX);
    expect(
      ruleValueOf(parseManifest(fake.value(MANIFEST_KEY)!)!.rules[0]),
    ).toBe("Prior title v1");
  });

  it("QA-1 double crash: two consecutive crash windows still converge — the baseline survives both, the third attempt lands, rollback removes the rule", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      store.crashNextUpdate = true;
      await expect(
        manager.apply(preview.change.id, APPROVAL, CTX),
      ).rejects.toThrowError(/database unavailable/);
      expect(store.peek(preview.change.id)?.status).toBe("previewed");
      expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toHaveLength(1);
    }

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(outcome.change.diff.before).toBeNull(); // the true original state

    await manager.rollback(outcome.change.id, { reason: "qa" }, CTX);
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
  });

  it("crash AFTER the revert write (null before): row stays 'applied' while the manifest is already reverted; re-running rollback is an idempotent no-op removal and reconciles the row", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    store.crashNextUpdate = true;
    await expect(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
    ).rejects.toThrowError(/database unavailable/);
    // Safe direction: the site (manifest) is already reverted; the row is
    // honest-stale at 'applied' and retryable.
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
    expect(store.peek(applied.change.id)?.status).toBe("applied");

    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
  });

  it("crash AFTER the revert write (prior rule): the re-run re-installs the SAME prior byte-exact — idempotent", async () => {
    const address = addressOf("set_meta_description");
    const prior = ruleFor(address.op, PAGE_PATH, "prior desc");
    const seedText = seedManifest([prior], 5);
    const { fake, manager, store } = harness({
      values: { [MANIFEST_KEY]: seedText },
    });
    const preview = await manager.preview(
      desired(SPECS.set_meta_description, "prior desc", "new desc"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    store.crashNextUpdate = true;
    await expect(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
    ).rejects.toThrowError(/database unavailable/);
    expect(
      ruleValueOf(parseManifest(fake.value(MANIFEST_KEY)!)!.rules[0]),
    ).toBe("prior desc");
    expect(store.peek(applied.change.id)?.status).toBe("applied");

    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    const finalM = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(finalM.rules).toEqual([prior]); // byte-exact prior, still exactly one
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("ANTI-WIX CONTRAST PIN, apply direction: a concurrent writer landing between our PUT and the verification GET is caught LOUDLY — write_verification_failed, row 'previewed', the other writer's bytes are NOT clobbered back", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "Ours"),
      CTX,
    );
    const foreign = seedManifest(
      [
        mrule({
          enabled: true,
          path: "/theirs",
          op: "set_title" as const,
          payload: { text: "another pipeline operation" },
        }),
      ],
      999,
    );
    fake.overwriteAfterNextPut(foreign);

    const err = await expectFailure(
      manager.apply(preview.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    // The interleaving is NAMED, not smoothed over — the Wix GET→PUT window
    // is silent by transport design; THIS method sees it every time.
    expect(err.message).toContain("concurrent");
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
    expect(fake.value(MANIFEST_KEY)).toBe(foreign); // no clobber-back either
  });

  it("ANTI-WIX CONTRAST PIN, revert direction: same loudness — the row keeps its 'applied' truth, never a false 'reverted'", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "Ours"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const racing = fake.value(MANIFEST_KEY)!; // any other-writer bytes

    fake.overwriteAfterNextPut(racing);
    await expectFailure(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
      "write_verification_failed",
    );
    expect(store.peek(applied.change.id)?.status).toBe("applied");
  });

  it("a manifest VANISHING between PUT and verification (concurrent deleter) is write_verification_failed in both directions — never a success claim", async () => {
    // Apply direction.
    const a = harness();
    const previewA = await a.manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    a.fake.deleteAfterNextPut();
    await expectFailure(
      a.manager.apply(previewA.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    expect(a.store.peek(previewA.change.id)?.status).toBe("previewed");

    // Revert direction.
    const b = harness();
    const previewB = await b.manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const appliedB = await b.manager.apply(previewB.change.id, APPROVAL, CTX);
    b.fake.deleteAfterNextPut();
    await expectFailure(
      b.manager.rollback(appliedB.change.id, { reason: "qa" }, CTX),
      "write_verification_failed",
    );
    expect(b.store.peek(appliedB.change.id)?.status).toBe("applied");
  });

  it("torn/foreign/tampered manifests are refused on read and NEVER clobbered — apply direction, every corruption shape, zero PUTs", async () => {
    const address = addressOf("set_title");
    const valid = ruleFor(address.op, PAGE_PATH, "ok");
    const validText = seedManifest([valid], 4);
    const corruptions: Array<{ label: string; text: string }> = [
      {
        label: "foreign format tag",
        text: '{"format":"someone-elses/rules","formatVersion":1,"version":1,"updatedAt":"x","rules":[]}',
      },
      {
        label: "tampered rule id (id ≠ derivation)",
        text: seedManifest([{ ...valid, id: "title@/somewhere-else" }], 4),
      },
      {
        label: "torn write (truncated JSON)",
        text: validText.slice(0, validText.length - 7),
      },
      {
        label: "extra top-level key (smuggling)",
        text: validText.slice(0, -1) + ',"extra":true}',
      },
      {
        label: "non-integer version",
        text: validText.replace('"version":4', '"version":4.5'),
      },
      {
        label: "duplicate rule ids",
        text: seedManifest([valid], 4).replace(
          '"rules":[',
          `"rules":[${JSON.stringify(valid)},`,
        ),
      },
    ];
    for (const c of corruptions) {
      expect(parseManifest(c.text), c.label).toBeNull(); // premise check
      const { fake, manager, store } = harness({
        values: { [MANIFEST_KEY]: c.text },
      });
      const preview = await manager.preview(
        desired(SPECS.set_title, null, "T"),
        CTX,
      );
      await expectFailure(
        manager.apply(preview.change.id, APPROVAL, CTX),
        "unexpected_response",
      );
      expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
      expect(fake.value(MANIFEST_KEY)).toBe(c.text); // untouched bytes
      expect(store.peek(preview.change.id)?.status).toBe("previewed");
    }
  });

  it("a manifest turned foreign AFTER apply blocks rollback loudly (revert direction): refusal, no PUT, bytes untouched, row stays 'applied'", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const putsBefore = fake.requests.filter((r) => r.method === "PUT").length;

    const foreign = '{"someone":"elses data entirely"}';
    fake.seedValue(MANIFEST_KEY, foreign);
    await expectFailure(
      manager.rollback(applied.change.id, { reason: "qa" }, CTX),
      "unexpected_response",
    );
    expect(fake.value(MANIFEST_KEY)).toBe(foreign);
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(
      putsBefore,
    );
    expect(store.peek(applied.change.id)?.status).toBe("applied");
  });

  it("VERSION REGRESSION: the adapter versions relative to the STORE (an out-of-band reset does not break rollback) — byte-verification, not version arithmetic, is the concurrency guard", async () => {
    const address = addressOf("set_title");
    const prior = ruleFor(address.op, PAGE_PATH, "prior");
    const { fake, manager, store } = harness({
      values: { [MANIFEST_KEY]: seedManifest([prior], 41) },
    });
    const preview = await manager.preview(
      desired(SPECS.set_title, "prior", "next"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.version).toBe(42);

    // Out-of-band writer resets the counter to 7 (same rules, valid manifest).
    const current = parseManifest(fake.value(MANIFEST_KEY)!)!;
    fake.seedValue(
      MANIFEST_KEY,
      serializeManifest({ ...current, version: 7 }),
    );

    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    const finalM = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(finalM.version).toBe(8); // 7 + 1 — relative to the store
    expect(finalM.rules).toEqual([prior]); // the restore itself is exact
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("VERSION SATURATION PIN: at Number.MAX_SAFE_INTEGER the +1 counter TIES (stops advancing) — writes still verify byte-exact; the version is diagnostic, not the safety mechanism", async () => {
    const address = addressOf("set_title");
    const prior = ruleFor(address.op, PAGE_PATH, "prior");
    const { fake, manager } = harness({
      values: {
        [MANIFEST_KEY]: seedManifest([prior], Number.MAX_SAFE_INTEGER),
      },
    });
    const preview = await manager.preview(
      desired(SPECS.set_title, "prior", "next"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.version).toBe(
      Number.MAX_SAFE_INTEGER + 1,
    );
    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    const finalM = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(finalM.version).toBe(Number.MAX_SAFE_INTEGER + 1); // the tie
    expect(finalM.rules).toEqual([prior]); // rollback correctness unaffected
  });

  it("VERSION TIE, byte-identical concurrent write: indistinguishable from our own echo and verified as success — harmless by definition (the store provably holds exactly the verified content)", async () => {
    const FIXED = "2026-07-09T15:00:00.000Z";
    const { fake, manager } = harness({ adapterClock: fixedClock(FIXED) });
    const address = addressOf("set_title");
    const predicted = serializeManifest({
      format: MANIFEST_FORMAT,
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: 1,
      updatedAt: FIXED,
      rules: [ruleFor(address.op, PAGE_PATH, "Tie title")],
    });
    fake.overwriteAfterNextPut(predicted); // a twin writes the same bytes

    const preview = await manager.preview(
      desired(SPECS.set_title, null, "Tie title"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.change.status).toBe("applied");
    expect(fake.value(MANIFEST_KEY)).toBe(predicted);
  });

  it("VERSION TIE, same version but DIFFERENT bytes: caught — the version number is NOT the detector, the bytes are", async () => {
    const FIXED = "2026-07-09T15:00:00.000Z";
    const { fake, manager, store } = harness({
      adapterClock: fixedClock(FIXED),
    });
    const address = addressOf("set_title");
    const divergent = serializeManifest({
      format: MANIFEST_FORMAT,
      formatVersion: MANIFEST_FORMAT_VERSION,
      version: 1, // the SAME version our write will claim
      updatedAt: FIXED, // and the same timestamp
      rules: [ruleFor(address.op, PAGE_PATH, "Different content")],
    });
    fake.overwriteAfterNextPut(divergent);

    const preview = await manager.preview(
      desired(SPECS.set_title, null, "Tie title"),
      CTX,
    );
    await expectFailure(
      manager.apply(preview.change.id, APPROVAL, CTX),
      "write_verification_failed",
    );
    expect(store.peek(preview.change.id)?.status).toBe("previewed");
    expect(fake.value(MANIFEST_KEY)).toBe(divergent); // never clobbered back
  });

  it("legitimate drift (a DIFFERENT rule value found live) re-baselines with a drift_detected warning — rollback restores the LIVE prior, not the stale preview", async () => {
    const address = addressOf("set_title");
    const live = ruleFor(address.op, PAGE_PATH, "Live value");
    const { fake, manager } = harness({
      values: { [MANIFEST_KEY]: seedManifest([live], 2) },
    });
    const preview = await manager.preview(
      desired(SPECS.set_title, "Stale preview value", "Approved"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(applied.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    expect(applied.change.diff.before).toBe("Live value");

    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    expect(
      ruleValueOf(parseManifest(fake.value(MANIFEST_KEY)!)!.rules[0]),
    ).toBe("Live value");
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 4 — worker-half behavioral QA (no CF runtime)               */
/* ------------------------------------------------------------------ */

/** lol-html-modeled minimal escaping (see the header fidelity note). */
const escAttrLikeRuntime = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escTextLikeRuntime = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface RewriteJournalEntry {
  selector: string;
  call: "setAttribute" | "setInnerContent";
  name?: string;
  value: string;
  options?: { html: boolean };
}

interface RewriterOpts {
  poisonSelector?: string;
  journal?: RewriteJournalEntry[];
}

interface Registration {
  selector: string;
  handlers: { element(element: RewriterElementLike): void };
}

class StreamedTag implements RewriterElementLike {
  dirty = false;
  private readonly order: string[] = [];
  private readonly values = new Map<string, string>();
  private readonly mutated = new Set<string>();
  constructor(
    private readonly tagName: string,
    attrText: string,
    private readonly selector: string,
    private readonly opts?: RewriterOpts,
  ) {
    const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrText)) !== null) {
      this.order.push(m[1]);
      this.values.set(m[1], m[2]);
    }
  }
  getAttribute(name: string): string | null {
    return this.values.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    if (this.opts?.poisonSelector === this.selector) {
      throw new Error("qa: hostile runtime element");
    }
    this.opts?.journal?.push({
      selector: this.selector,
      call: "setAttribute",
      name,
      value,
    });
    if (!this.values.has(name)) this.order.push(name);
    this.values.set(name, value);
    this.mutated.add(name);
    this.dirty = true;
  }
  setInnerContent(): void {
    /* void elements have no inner content; the worker never calls this here */
  }
  onEndTag(): void {
    /* unused on void elements */
  }
  serialize(): string {
    const attrs = this.order
      .map((n) => {
        const v = this.values.get(n)!;
        return `${n}="${this.mutated.has(n) ? escAttrLikeRuntime(v) : v}"`;
      })
      .join(" ");
    return `<${this.tagName} ${attrs}>`;
  }
}

class StreamedTitle implements RewriterElementLike {
  dirty = false;
  newInner = "";
  constructor(private readonly opts?: RewriterOpts) {}
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {
    /* the worker never sets attributes on <title> */
  }
  setInnerContent(content: string, options?: { html: boolean }): void {
    if (this.opts?.poisonSelector === "title") {
      throw new Error("qa: hostile runtime element");
    }
    this.opts?.journal?.push({
      selector: "title",
      call: "setInnerContent",
      value: content,
      options,
    });
    this.newInner = options?.html ? content : escTextLikeRuntime(content);
    this.dirty = true;
  }
  onEndTag(): void {
    /* unused */
  }
}

class StreamedHead implements RewriterElementLike {
  endTagHandler: ((tag: RewriterEndTagLike) => void) | null = null;
  getAttribute(): string | null {
    return null;
  }
  setAttribute(): void {
    /* unused */
  }
  setInnerContent(): void {
    /* unused */
  }
  onEndTag(handler: (tag: RewriterEndTagLike) => void): void {
    this.endTagHandler = handler;
  }
}

function renderRewritten(
  source: string,
  regs: readonly Registration[],
  opts?: RewriterOpts,
): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const reg of regs) {
    if (reg.selector === "head") continue;
    if (reg.selector === "title") {
      const re = /<title\b[^>]*>[\s\S]*?<\/title>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const el = new StreamedTitle(opts);
        reg.handlers.element(el);
        if (el.dirty) {
          edits.push({
            start: m.index,
            end: m.index + m[0].length,
            text: `<title>${el.newInner}</title>`,
          });
        }
      }
    } else {
      const re = new RegExp(`<${reg.selector}\\b([^>]*?)/?>`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const el = new StreamedTag(reg.selector, m[1], reg.selector, opts);
        reg.handlers.element(el);
        if (el.dirty) {
          edits.push({
            start: m.index,
            end: m.index + m[0].length,
            text: el.serialize(),
          });
        }
      }
    }
  }
  const headReg = regs.find((r) => r.selector === "head");
  if (headReg) {
    const el = new StreamedHead();
    headReg.handlers.element(el);
    const closeIdx = source.search(/<\/head>/i);
    if (closeIdx >= 0 && el.endTagHandler) {
      const parts: string[] = [];
      el.endTagHandler({ before: (content) => void parts.push(content) });
      if (parts.length > 0) {
        edits.push({ start: closeIdx, end: closeIdx, text: parts.join("") });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function makeRewriter(
  sourceHtml: string,
  opts?: RewriterOpts,
): HtmlRewriterConstructor {
  return class implements HtmlRewriterLike {
    private readonly regs: Registration[] = [];
    on(
      selector: string,
      handlers: { element(element: RewriterElementLike): void },
    ): HtmlRewriterLike {
      this.regs.push({ selector, handlers });
      return this;
    }
    transform(response: Response): Response {
      return new Response(renderRewritten(sourceHtml, this.regs, opts), response);
    }
  };
}

const BASE_PAGE = [
  "<!doctype html><html><head>",
  "<title>Original Title</title>",
  '<meta charset="utf-8">',
  '<meta name="Description" content="original description">',
  '<meta name="keywords" content="unrelated">',
  '<link rel="stylesheet" href="/styles.css">',
  '<link rel="alternate canonical" href="https://qa-client.example/old-canonical">',
  "</head><body>",
  '<img src="/hero.jpg" alt="original alt">',
  '<img src="/other.jpg" alt="unrelated alt">',
  "<script>var qa = 1;</script>",
  "</body></html>",
].join("");

const BARE_HEAD_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

function originResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
      etag: '"qa-origin-etag"',
      "last-modified": "Wed, 08 Jul 2026 00:00:00 GMT",
    },
  });
}

function kvEnv(text: string | null): EdgeAutofixEnv {
  return { EDGE_RULES: { get: async () => text } };
}

function workerManifest(rules: EdgeRule[], version = 9): string {
  return seedManifest(rules, version, "2026-07-09T12:00:00.000Z");
}

async function renderPage(
  html: string,
  manifestText: string | null,
  opts?: RewriterOpts & { url?: string; method?: string },
): Promise<{ out: Response; origin: Response; body: string }> {
  const origin = originResponse(html);
  const deps: WorkerDeps = {
    originFetch: async () => origin,
    rewriter: makeRewriter(html, opts),
  };
  const out = await handleRequest(
    new Request(opts?.url ?? PAGE_URL, { method: opts?.method ?? "GET" }),
    kvEnv(manifestText),
    deps,
  );
  return { out, origin, body: await out.clone().text() };
}

describe("QA gate 4 — worker-half behavior: rewrites, escaping, fail-open, header + caching truth", () => {
  const HOSTILE_TEXT = "</title></script><script>alert(1)</script>";
  const HOSTILE_ATTR = '"><script>alert(1)</script>';

  it("set_title replaces an existing <title>; a hostile payload is handed to the runtime with html:false and cannot open a script context", async () => {
    const journal: RewriteJournalEntry[] = [];
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: HOSTILE_TEXT },
    });
    const { out, body } = await renderPage(BASE_PAGE, workerManifest([rule]), {
      journal,
    });
    // Contract with the runtime: RAW payload, html:false (runtime escapes).
    expect(journal).toContainEqual({
      selector: "title",
      call: "setInnerContent",
      value: HOSTILE_TEXT,
      options: { html: false },
    });
    expect(body).toContain(
      "<title>&lt;/title&gt;&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    // No NEW executable script context in the rendered page.
    expect(body.match(/<script/gi)).toHaveLength(1); // the origin's own only
    expect(out.headers.get("x-edge-autofix")).toBe(`v9; ${rule.id}`);
  });

  it("set_title injects at </head> when the page has no <title> — the SHIPPED escaper (rules.ts), not the runtime, contains the hostile payload", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: HOSTILE_TEXT },
    });
    const { body } = await renderPage(BARE_HEAD_PAGE, workerManifest([rule]));
    expect(body).toContain(
      "<title>&lt;/title&gt;&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    expect(body.match(/<script/gi)).toBeNull(); // no script context at all
  });

  it("set_meta_description rewrites ONLY name=description (case-insensitive); other metas untouched; hostile content cannot close the attribute", async () => {
    const journal: RewriteJournalEntry[] = [];
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_meta_description" as const,
      payload: { content: HOSTILE_ATTR },
    });
    const { body } = await renderPage(BASE_PAGE, workerManifest([rule]), {
      journal,
    });
    expect(journal).toContainEqual({
      selector: "meta",
      call: "setAttribute",
      name: "content",
      value: HOSTILE_ATTR, // raw to the runtime — the runtime escapes
    });
    // The payload's quote arrives escaped, so the attribute never closes
    // early and the '<script' inside it stays inert attribute text.
    expect(body).toContain(
      '<meta name="Description" content="&quot;><script>alert(1)</script>">',
    );
    expect(body).toContain('<meta name="keywords" content="unrelated">');
    expect(body).toContain('<meta charset="utf-8">');
  });

  it("set_meta_description injects when the page has none — shipped escapeAttribute output, quotes and angles entity-escaped", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_meta_description" as const,
      payload: { content: HOSTILE_ATTR },
    });
    const { body } = await renderPage(BARE_HEAD_PAGE, workerManifest([rule]));
    expect(body).toContain(
      '<meta name="description" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
    );
    expect(body.match(/<script/gi)).toBeNull();
  });

  it("set_canonical rewrites href on a rel TOKEN match ('alternate canonical' counts); the stylesheet link is untouched; injects when missing", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_canonical" as const,
      payload: { href: "https://qa-client.example/new-canonical" },
    });
    const { body } = await renderPage(BASE_PAGE, workerManifest([rule]));
    expect(body).toContain(
      '<link rel="alternate canonical" href="https://qa-client.example/new-canonical">',
    );
    expect(body).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(body).not.toContain("old-canonical");

    const injected = await renderPage(BARE_HEAD_PAGE, workerManifest([rule]));
    expect(injected.body).toContain(
      '<link rel="canonical" href="https://qa-client.example/new-canonical">',
    );
  });

  it("set_img_alt sets alt ONLY on the byte-exact src match; hostile alt stays inside its attribute; other imgs untouched", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_img_alt" as const,
      payload: { src: "/hero.jpg", alt: HOSTILE_ATTR },
    });
    const { body } = await renderPage(BASE_PAGE, workerManifest([rule]));
    expect(body).toContain(
      '<img src="/hero.jpg" alt="&quot;><script>alert(1)</script>">',
    );
    expect(body).toContain('<img src="/other.jpg" alt="unrelated alt">');
    // Near-miss src (case difference) is NOT rewritten — byte-exact only.
    const nearMiss = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_img_alt" as const,
      payload: { src: "/HERO.jpg", alt: "should never land" },
    });
    const miss = await renderPage(BASE_PAGE, workerManifest([nearMiss]));
    expect(miss.body).toContain('<img src="/hero.jpg" alt="original alt">');
  });

  it("upsert_json_ld injects a tagged, breakout-proof script: no '<' survives inside the block, and the content parses back to the exact object", async () => {
    const hostile = {
      "@type": "FAQPage",
      q: "</script><script>alert(1)</script>",
      sep: "a b c",
    };
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "upsert_json_ld" as const,
      payload: { scriptId: "faq", json: hostile },
    });
    const { body } = await renderPage(BASE_PAGE, workerManifest([rule]));

    const match =
      /<script type="application\/ld\+json"[^>]*data-edge-autofix-schema="faq"[^>]*>([\s\S]*?)<\/script>/.exec(
        body,
      );
    expect(match).not.toBeNull();
    const content = match![1];
    expect(content).not.toContain("<"); // every '<' is <-escaped
    expect(content).toContain("\\u003c/script");
    expect(JSON.parse(content)).toEqual(hostile); // value preserved exactly
    expect(match![0]).toContain(`data-edge-autofix-rule="${rule.id}"`);
    // Exactly ONE new script context: the tagged JSON-LD block itself.
    expect(body.match(/<script/gi)).toHaveLength(2);
  });

  it("path matching is EXACT: /qa-page rule does not fire on /qa-page/ (identity pass-through), while a query string does not defeat the match", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: "Rewritten" },
    });
    const trailing = await renderPage(BASE_PAGE, workerManifest([rule]), {
      url: `${PAGE_URL}/`,
    });
    expect(trailing.out).toBe(trailing.origin); // strict object identity

    const withQuery = await renderPage(BASE_PAGE, workerManifest([rule]), {
      url: `${PAGE_URL}?utm=1#frag`,
    });
    expect(withQuery.body).toContain("<title>Rewritten</title>");
  });

  it("a DISABLED rule is inert: pass-through identity, no header, origin caching untouched", async () => {
    const rule = mrule({
      enabled: false,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: "should never render" },
    });
    const { out, origin } = await renderPage(BASE_PAGE, workerManifest([rule]));
    expect(out).toBe(origin);
    expect(out.headers.get("x-edge-autofix")).toBeNull();
    expect(out.headers.get("cache-control")).toBe("public, max-age=600");
    expect(out.headers.get("etag")).toBe('"qa-origin-etag"');
  });

  it("fail-open identity on every constructible failure input: invalid JSON, foreign format, empty rules, other-page rules, KV throw, missing binding, throwing rewriter constructor", async () => {
    const enabledElsewhere = workerManifest([
      mrule({
        enabled: true,
        path: "/not-this-page",
        op: "set_title" as const,
        payload: { text: "x" },
      }),
    ]);
    const inputs: Array<[string, string | null]> = [
      ["invalid manifest JSON", "{{{ not json"],
      [
        "wrong format tag",
        '{"format":"foreign/rules","formatVersion":1,"version":1,"updatedAt":"x","rules":[]}',
      ],
      ["empty rules", workerManifest([])],
      ["rules for another page only", enabledElsewhere],
      ["missing manifest key", null],
    ];
    for (const [label, text] of inputs) {
      const { out, origin } = await renderPage(BASE_PAGE, text);
      expect(out, label).toBe(origin);
      expect(out.headers.get("x-edge-autofix"), label).toBeNull();
    }

    // KV read throws → identity.
    const origin1 = originResponse(BASE_PAGE);
    const kvThrow = await handleRequest(
      new Request(PAGE_URL),
      {
        EDGE_RULES: {
          get: async () => {
            throw new Error("kv unavailable");
          },
        },
      },
      { originFetch: async () => origin1, rewriter: makeRewriter(BASE_PAGE) },
    );
    expect(kvThrow).toBe(origin1);

    // No binding at all → identity.
    const origin2 = originResponse(BASE_PAGE);
    const noBinding = await handleRequest(
      new Request(PAGE_URL),
      {},
      { originFetch: async () => origin2, rewriter: makeRewriter(BASE_PAGE) },
    );
    expect(noBinding).toBe(origin2);

    // The rewriter constructor itself throws → identity (the outer guard).
    const origin3 = originResponse(BASE_PAGE);
    const Throwing = class implements HtmlRewriterLike {
      constructor() {
        throw new Error("no rewriter in this runtime");
      }
      on(): HtmlRewriterLike {
        return this;
      }
      transform(response: Response): Response {
        return response;
      }
    };
    const ctorThrow = await handleRequest(
      new Request(PAGE_URL),
      kvEnv(
        workerManifest([
          mrule({
            enabled: true,
            path: PAGE_PATH,
            op: "set_title" as const,
            payload: { text: "x" },
          }),
        ]),
      ),
      { originFetch: async () => origin3, rewriter: Throwing },
    );
    expect(ctorThrow).toBe(origin3);
  });

  it("a rule whose element handler throws fails open PER ELEMENT: the page still renders, the other rules still apply", async () => {
    const title = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: "poisoned handler target" },
    });
    const meta = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_meta_description" as const,
      payload: { content: "still applied" },
    });
    const { out, body } = await renderPage(
      BASE_PAGE,
      workerManifest([title, meta]),
      { poisonSelector: "title" },
    );
    expect(out.status).toBe(200);
    expect(body).toContain("<title>Original Title</title>"); // title survived
    expect(body).toContain('content="still applied"'); // meta still landed
  });

  it("the x-edge-autofix header names the manifest version and EXACTLY the rules applied to THIS page — never the other page's rule; pass-through carries no marker", async () => {
    const onPage = [
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "set_title" as const,
        payload: { text: "T" },
      }),
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "upsert_json_ld" as const,
        payload: { scriptId: "faq", json: { "@type": "FAQPage" } },
      }),
    ];
    const offPage = mrule({
      enabled: true,
      path: "/elsewhere",
      op: "set_canonical" as const,
      payload: { href: "https://qa-client.example/elsewhere" },
    });
    const { out } = await renderPage(
      BASE_PAGE,
      workerManifest([...onPage, offPage], 12),
    );
    const expectedIds = onPage.map((r) => r.id).sort();
    expect(out.headers.get("x-edge-autofix")).toBe(
      `v12; ${expectedIds.join(" ")}`,
    );
    expect(out.headers.get("x-edge-autofix")).not.toContain("/elsewhere");
  });

  it("caching truth: a REWRITTEN response is no-store with validators stripped; a PASS-THROUGH keeps the origin's caching byte-for-byte", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: "T" },
    });
    const rewritten = await renderPage(BASE_PAGE, workerManifest([rule]));
    expect(rewritten.out.headers.get("cache-control")).toBe("no-store");
    expect(rewritten.out.headers.get("etag")).toBeNull();
    expect(rewritten.out.headers.get("last-modified")).toBeNull();
    expect(rewritten.out.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );

    const passthrough = await renderPage(BASE_PAGE, workerManifest([rule]), {
      url: "https://qa-client.example/untouched",
    });
    expect(passthrough.out).toBe(passthrough.origin);
    expect(passthrough.out.headers.get("cache-control")).toBe(
      "public, max-age=600",
    );
    expect(passthrough.out.headers.get("etag")).toBe('"qa-origin-etag"');
  });

  it("all five ops land together on one page (the full-grammar render)", async () => {
    const rules = [
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "set_title" as const,
        payload: { text: "All Five" },
      }),
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "set_meta_description" as const,
        payload: { content: "five ops" },
      }),
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "set_canonical" as const,
        payload: { href: "https://qa-client.example/five" },
      }),
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "upsert_json_ld" as const,
        payload: { scriptId: "org", json: { "@type": "Organization" } },
      }),
      mrule({
        enabled: true,
        path: PAGE_PATH,
        op: "set_img_alt" as const,
        payload: { src: "/hero.jpg", alt: "five alt" },
      }),
    ];
    const { out, body } = await renderPage(BASE_PAGE, workerManifest(rules));
    expect(body).toContain("<title>All Five</title>");
    expect(body).toContain('content="five ops"');
    expect(body).toContain('href="https://qa-client.example/five"');
    expect(body).toContain('data-edge-autofix-schema="org"');
    expect(body).toContain('<img src="/hero.jpg" alt="five alt">');
    const header = out.headers.get("x-edge-autofix")!;
    for (const r of rules) expect(header).toContain(r.id);
  });

  it("HEAD requests take the rewrite path too (GET/HEAD are the idempotent pair)", async () => {
    const rule = mrule({
      enabled: true,
      path: PAGE_PATH,
      op: "set_title" as const,
      payload: { text: "T" },
    });
    const { out } = await renderPage(BASE_PAGE, workerManifest([rule]), {
      method: "HEAD",
    });
    expect(out.headers.get("x-edge-autofix")).toBe(`v9; ${rule.id}`);
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 5 — auto-rollback modes through this adapter                */
/* ------------------------------------------------------------------ */

describe("QA gate 5 — auto-rollback fires through the edge adapter, respecting mode flags", () => {
  async function appliedTitle(h: Harness): Promise<string> {
    const preview = await h.manager.preview(
      desired(SPECS.set_title, null, "Monitored title"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);
    return applied.change.id;
  }

  it("mode 'off': breach-level signals produce NO action — the rule stays live, no alert", async () => {
    const h = harness({ policy: { mode: "off", thresholds: { traffic: 25 } } });
    const id = await appliedTitle(h);
    const evaluation = await h.manager.monitor(id, [signal("traffic", -80)], CTX);
    expect(evaluation.action).toBe("none");
    expect(evaluation.breaches).toEqual([]);
    expect(h.store.peek(id)?.status).toBe("applied");
    expect(parseManifest(h.fake.value(MANIFEST_KEY)!)!.rules).toHaveLength(1);
    expect(h.alerts).toEqual([]);
  });

  it("mode 'flag': the breach is surfaced for a human, nothing reverts", async () => {
    const h = harness({ policy: { mode: "flag", thresholds: { traffic: 25 } } });
    const id = await appliedTitle(h);
    const evaluation = await h.manager.monitor(id, [signal("traffic", -30)], CTX);
    expect(evaluation.action).toBe("flagged");
    expect(evaluation.breaches).toHaveLength(1);
    expect(h.store.peek(id)?.status).toBe("applied");
    expect(parseManifest(h.fake.value(MANIFEST_KEY)!)!.rules).toHaveLength(1);
    expect(h.alerts).toEqual([]);
  });

  it("mode 'execute', null-before: the auto-revert REMOVES the rule slot; status 'auto_reverted', reason recorded, critical alert emitted", async () => {
    const h = harness({
      policy: { mode: "execute", thresholds: { visibility: 30 } },
    });
    const id = await appliedTitle(h);
    const evaluation = await h.manager.monitor(
      id,
      [signal("visibility", -45)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_reverted");
    const row = h.store.peek(id)!;
    expect(row.status).toBe("auto_reverted");
    expect(row.reverted_reason).toContain("auto-rollback:");
    expect(row.reverted_reason).toContain("visibility -45%");
    expect(parseManifest(h.fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].type).toBe("auto_rollback_fired");
    expect(h.alerts[0].severity).toBe("critical");
  });

  it("mode 'execute', prior rule: the auto-revert restores the prior slot BYTE-EXACT (manifest equals the seed modulo version/updatedAt)", async () => {
    const address = addressOf("set_title");
    const prior = ruleFor(address.op, PAGE_PATH, "Prior monitored title");
    const seedText = seedManifest([prior], 11);
    const h = harness({
      policy: { mode: "execute", thresholds: { ranking: 30 } },
      values: { [MANIFEST_KEY]: seedText },
    });
    const preview = await h.manager.preview(
      desired(SPECS.set_title, "Prior monitored title", "Regressing title"),
      CTX,
    );
    const applied = await h.manager.apply(preview.change.id, APPROVAL, CTX);

    const evaluation = await h.manager.monitor(
      applied.change.id,
      [signal("ranking", -31)],
      CTX,
    );
    expect(evaluation.action).toBe("auto_reverted");
    const finalText = h.fake.value(MANIFEST_KEY)!;
    const finalM = parseManifest(finalText)!;
    expect(finalText).toBe(
      serializeManifest({
        ...parseManifest(seedText)!,
        version: finalM.version,
        updatedAt: finalM.updatedAt,
      }),
    );
  });

  it("threshold boundary is exact: deltaPct == -threshold FIRES; one tenth inside does not", async () => {
    const policy: AutoRollbackPolicy = {
      mode: "execute",
      thresholds: { traffic: 25 },
    };
    const fires = harness({ policy });
    const idA = await appliedTitle(fires);
    const atBoundary = await fires.manager.monitor(
      idA,
      [signal("traffic", -25)],
      CTX,
    );
    expect(atBoundary.action).toBe("auto_reverted");

    const holds = harness({ policy });
    const idB = await appliedTitle(holds);
    const inside = await holds.manager.monitor(
      idB,
      [signal("traffic", -24.9)],
      CTX,
    );
    expect(inside.action).toBe("none");
    expect(holds.store.peek(idB)?.status).toBe("applied");
  });

  it("a FAILED auto-revert is honest: action 'auto_revert_failed', the row keeps 'applied', the rule stays live, NO alert — and the next monitor pass retries successfully", async () => {
    const h = harness({
      policy: { mode: "execute", thresholds: { traffic: 25 } },
    });
    const id = await appliedTitle(h);

    h.fake.rotateToken("rotated-away");
    const failed = await h.manager.monitor(id, [signal("traffic", -60)], CTX);
    expect(failed.action).toBe("auto_revert_failed");
    expect(isWriteMethodError(failed.error)).toBe(true);
    expect((failed.error as WriteMethodError).code).toBe("credential_rejected");
    expect(h.store.peek(id)?.status).toBe("applied");
    expect(parseManifest(h.fake.value(MANIFEST_KEY)!)!.rules).toHaveLength(1);
    expect(h.alerts).toEqual([]); // no alert for a revert that did NOT happen

    h.fake.rotateToken(SECRET);
    const retried = await h.manager.monitor(id, [signal("traffic", -60)], CTX);
    expect(retried.action).toBe("auto_reverted");
    expect(parseManifest(h.fake.value(MANIFEST_KEY)!)!.rules).toEqual([]);
    expect(h.alerts).toHaveLength(1);
  });

  it("a breach against a non-applied row is a no-op (only live changes are monitored)", async () => {
    const h = harness({
      policy: { mode: "execute", thresholds: { traffic: 25 } },
    });
    const preview = await h.manager.preview(
      desired(SPECS.set_title, null, "Never applied"),
      CTX,
    );
    const evaluation = await h.manager.monitor(
      preview.change.id,
      [signal("traffic", -99)],
      CTX,
    );
    expect(evaluation.action).toBe("none");
    expect(h.fake.requests).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 6 — partial batch: exact prefix, tail never requested        */
/* ------------------------------------------------------------------ */

const BATCH_PATHS = ["/batch-a", "/batch-b", "/batch-c"] as const;

function batchMembers(): DesiredChange[] {
  return BATCH_PATHS.map((path) => ({
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "edge_worker" as const,
    changeType: "title" as const,
    target: {
      url: `https://qa-client.example${path}`,
      locator: edgeLocators.title(),
    },
    before: null,
    after: `Title for ${path}`,
  }));
}

describe("QA gate 6 — partial batch: the MIDDLE member fails, prefix accounting is exact", () => {
  it("mid-batch 429: exact prefix applied, tail NEVER REQUESTED (journal-proven), row-status truth, re-run continues, prefix rollback restores absence", async () => {
    const { fake, manager, store } = harness();
    const batch = await manager.previewBatch(batchMembers(), CTX);
    fake.failPut(2, 429, 10015); // member 2's manifest PUT

    const report = await manager.applyBatch(batch, APPROVAL, CTX);
    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([
      batch.members[0].change.id,
    ]);
    expect(report.failed?.changeId).toBe(batch.members[1].change.id);
    expect(isWriteMethodError(report.failed?.error)).toBe(true);
    expect((report.failed?.error as WriteMethodError).code).toBe("rate_limited");
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);

    // Row-status truth.
    expect(store.peek(batch.members[0].change.id)?.status).toBe("applied");
    expect(store.peek(batch.members[1].change.id)?.status).toBe("previewed");
    expect(store.peek(batch.members[2].change.id)?.status).toBe("previewed");

    // The TAIL was never requested: member 1 = GET+GET+PUT+GET (4), member 2
    // = GET+GET+PUT-429 (3), member 3 = nothing. And no request body ever
    // mentions member 3's slot.
    expect(fake.requests).toHaveLength(7);
    for (const req of fake.requests) {
      expect(req.body ?? "").not.toContain(`title@${BATCH_PATHS[2]}`);
    }
    expect(parseManifest(fake.value(MANIFEST_KEY)!)!.rules.map((r) => r.path)).toEqual(
      [BATCH_PATHS[0]],
    );

    // Continuation after the window passes: previously-applied member is
    // reported, not re-applied; the rest land.
    const rerun = await manager.applyBatch(batch, APPROVAL, CTX);
    expect(rerun.complete).toBe(true);
    expect(rerun.previouslyApplied).toEqual([batch.members[0].change.id]);
    expect(
      parseManifest(fake.value(MANIFEST_KEY)!)!.rules.map((r) => r.path).sort(),
    ).toEqual([...BATCH_PATHS].sort());

    // Prefix members remain INDIVIDUALLY revertible, byte-exact to absence.
    await manager.rollback(
      batch.members[0].change.id,
      { reason: "qa: member 1 regressed" },
      CTX,
    );
    const m = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(m.rules.map((r) => r.path).sort()).toEqual(
      [BATCH_PATHS[1], BATCH_PATHS[2]].sort(),
    );
    expect(fake.value(MANIFEST_KEY)!).not.toContain(`title@${BATCH_PATHS[0]}`);
  });

  it("mid-batch WRITE-VERIFICATION failure (a concurrent writer racing member 2): loud stop, exact prefix, prefix rollback leaves the manifest byte-equal to pre-batch modulo version/updatedAt", async () => {
    let puts = 0;
    const { fake, manager, store } = harness({
      wrapPort: (port, f) => async (url, init) => {
        if (init.method === "PUT" && ++puts === 2) {
          // The racing writer restores the member-1-only manifest right
          // after member 2's PUT lands — member 2's verification must see it.
          f.overwriteAfterNextPut(f.value(MANIFEST_KEY)!);
        }
        return port(url, init);
      },
    });
    const batch = await manager.previewBatch(batchMembers(), CTX);

    const preBatch = fake.value(MANIFEST_KEY); // null — no manifest yet
    expect(preBatch).toBeNull();

    const report = await manager.applyBatch(batch, APPROVAL, CTX);
    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([
      batch.members[0].change.id,
    ]);
    expect((report.failed?.error as WriteMethodError).code).toBe(
      "write_verification_failed",
    );
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);
    expect(store.peek(batch.members[1].change.id)?.status).toBe("previewed");

    // The store holds exactly the member-1 state the racing writer left.
    const afterBatch = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(afterBatch.rules.map((r) => r.path)).toEqual([BATCH_PATHS[0]]);

    // Prefix rollback: member 1's slot removed — empty-rules manifest, the
    // pinned honest residue of the null-before inversion.
    await manager.rollback(
      batch.members[0].change.id,
      { reason: "qa: unwind prefix" },
      CTX,
    );
    const finalM = parseManifest(fake.value(MANIFEST_KEY)!)!;
    expect(finalM.rules).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* QA gate 7 — no-silent-failure sweep of every adapter branch          */
/* ------------------------------------------------------------------ */

function directAdapter(opts?: {
  values?: Record<string, string>;
  port?: FetchPort;
}): { adapter: CloudflareEdgeAdapter; fake: FakeCloudflareKv } {
  const fake = new FakeCloudflareKv({
    apiToken: SECRET,
    accountId: ACCOUNT_ID,
    namespaceId: NAMESPACE_ID,
    values: opts?.values,
  });
  const adapter = new CloudflareEdgeAdapter({
    pin: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      accountId: ACCOUNT_ID,
      zoneId: ZONE_ID,
      scriptName: SCRIPT_NAME,
      namespaceId: NAMESPACE_ID,
    },
    secrets: { resolve: async () => new VendorCredential(SECRET) },
    authRef: "vault://cloudflare/prop-1",
    fetch: opts?.port ?? fake.port,
    clock: fixedClock("2026-07-09T15:00:00.000Z"),
  });
  return { adapter, fake };
}

function scriptedAdapter(handler: ScriptedHandler): {
  adapter: CloudflareEdgeAdapter;
  http: ScriptedFetch;
} {
  const http = new ScriptedFetch();
  http.on("*", /./, handler);
  const { adapter } = directAdapter({ port: http.port });
  return { adapter, http };
}

const TITLE_TARGET = { url: PAGE_URL, locator: edgeLocators.title() };
const TITLE_WRITE: AdapterWrite = {
  target: TITLE_TARGET,
  before: null,
  after: "T",
  ctx: ADAPTER_CTX,
};

describe("QA gate 7 — no-silent-failure sweep of the adapter's branches", () => {
  it("GET 404 without the key-not-found code is target_missing — ONLY Cloudflare code 10009 reads as the legitimate empty state", async () => {
    for (const code of [7000, 7003, 10013]) {
      const { adapter, fake } = directAdapter();
      fake.failNextWith(404, code);
      const err = await expectFailure(
        adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
        "target_missing",
      );
      expect(err.vendorCode).toBe(String(code));
      expect(err.httpStatus).toBe(404);
    }
    // The positive branch: 10009 on a READ is null, not an error.
    const { adapter } = directAdapter();
    await expect(adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX)).resolves.toBeNull();
  });

  it("a 404/10009 on the PUT is target_missing too — key-not-found is never a write-success path", async () => {
    const { adapter, fake } = directAdapter();
    fake.failPut(1, 404, 10009);
    await expectFailure(adapter.apply(TITLE_WRITE), "target_missing");
  });

  it("401 and 403 are both credential_rejected, with status + sanitized code and nothing else", async () => {
    for (const status of [401, 403] as const) {
      const { adapter, fake } = directAdapter();
      fake.failNextWith(status, 9109);
      const err = await expectFailure(
        adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
        "credential_rejected",
      );
      expect(err.httpStatus).toBe(status);
      expect(err.vendorCode).toBe("9109");
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("vendor free-text");
    }
  });

  it("429 Retry-After whitelist: plain integers survive; floats, negatives, words, and over-long digit strings are DROPPED, never echoed", async () => {
    const cases: Array<{ header?: number | string; expected?: number }> = [
      { header: 30, expected: 30 },
      { header: "0", expected: 0 },
      { header: "999999", expected: 999999 },
      { header: "30.5" },
      { header: "-5" },
      { header: "soon" },
      { header: "1234567" }, // 7 digits — over the whitelist
      { header: "30; Do NOT echo this clause" },
      {}, // header absent
    ];
    for (const c of cases) {
      const { adapter, fake } = directAdapter();
      fake.rateLimitNext(c.header);
      const err = await expectFailure(
        adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
        "rate_limited",
      );
      expect(err.retryAfterSeconds).toBe(c.expected);
      if (c.expected === undefined) {
        expect(err.message).toContain("shortly");
      } else {
        expect(err.message).toContain(`~${c.expected}s`);
      }
      expect(err.message).not.toContain("echo this clause");
      expect(err.message).toContain("nothing retries automatically");
    }
  });

  it("a 2xx PUT that does not CONFIRM success is unexpected_response — accepted-but-unconfirmed is never claimed verified", async () => {
    const bodies = [
      JSON.stringify({ success: false, errors: [], messages: [], result: null }),
      JSON.stringify({ success: "yes" }),
      JSON.stringify([1, 2, 3]),
      "OK", // non-JSON 200
      "", // empty 200
    ];
    for (const body of bodies) {
      const { adapter } = scriptedAdapter((req) =>
        req.method === "GET"
          ? jsonResponse(404, {
              success: false,
              errors: [{ code: 10009, message: "key not found" }],
            })
          : textResponse(200, body, "application/json"),
      );
      await expectFailure(adapter.apply(TITLE_WRITE), "unexpected_response");
    }
  });

  it("vendor errors carry ONLY the numeric code slug; free text, non-integer codes, and malformed envelopes are dropped", async () => {
    const NEVER = "NEVER-ECHO-THIS-FREE-TEXT";
    const cases: Array<{ body: unknown; slug?: string }> = [
      { body: { success: false, errors: [{ code: 10000, message: NEVER }] }, slug: "10000" },
      { body: { success: false, errors: [] } },
      { body: { success: false, errors: "not-an-array" } },
      { body: [1, 2, 3] },
      { body: { success: false, errors: [{ code: 1.5, message: NEVER }] } },
      // A string code that is slug-shaped survives the whitelist by design…
      {
        body: { success: false, errors: [{ code: "custom_code-1", message: NEVER }] },
        slug: "custom_code-1",
      },
      // …but a hostile string code is dropped.
      { body: { success: false, errors: [{ code: "<script>alert(1)</script>", message: NEVER }] } },
    ];
    for (const c of cases) {
      const { adapter } = scriptedAdapter(() => jsonResponse(500, c.body));
      const err = await expectFailure(
        adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
        "vendor_failure",
      );
      expect(err.vendorCode).toBe(c.slug);
      if (c.slug) expect(err.message).toContain(`[${c.slug}]`);
      expect(err.message).not.toContain(NEVER);
      expect(err.message).not.toContain("<script>");
    }
  });

  it("non-JSON error bodies are named honestly: HTML → challenge-page wording; plain text → not-valid-JSON wording; neither echoes the body", async () => {
    const html = scriptedAdapter(() =>
      htmlResponse(503, "<html><body>Maintenance NEVER-ECHO</body></html>"),
    );
    const errHtml = await expectFailure(
      html.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "unexpected_response",
    );
    expect(errHtml.message).toContain("HTML page");
    expect(errHtml.message).not.toContain("NEVER-ECHO");

    const text = scriptedAdapter(() => textResponse(502, "Bad Gateway NEVER-ECHO"));
    const errText = await expectFailure(
      text.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "unexpected_response",
    );
    expect(errText.message).toContain("not valid JSON");
    expect(errText.message).not.toContain("NEVER-ECHO");
  });

  it("a 200 HTML interstitial where the STORED MANIFEST was promised is unexpected_response (the looksLikeHtml read branch)", async () => {
    const { adapter, fake } = directAdapter();
    fake.simulateHtmlInterstitial();
    const err = await expectFailure(
      adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "unexpected_response",
    );
    expect(err.message).toContain("HTML page");
  });

  it("transport failures surface ONLY whitelisted identifiers — hostile resolver text and embedded secrets never leak", async () => {
    // Machine code on the error survives.
    const withCode = directAdapter();
    withCode.fake.http.failNext(
      Object.assign(
        new Error(`connect refused via http://internal:9999/?token=${SECRET}`),
        { code: "ECONNREFUSED" },
      ),
    );
    const errCode = await expectFailure(
      withCode.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "network_failure",
    );
    expect(errCode.message).toContain("ECONNREFUSED");
    expect(errCode.message).not.toContain(SECRET);
    expect(errCode.message).not.toContain("internal:9999");

    // A bare Error's free text is dropped entirely.
    const bare = directAdapter();
    bare.fake.http.failNext(new Error("free text with spaces and a secret-ish blob"));
    const errBare = await expectFailure(
      bare.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "network_failure",
    );
    expect(errBare.message).not.toContain("free text with spaces");

    // An identifier-shaped error NAME (refused redirect → TypeError) survives.
    const typed = directAdapter();
    typed.fake.http.failNext(new TypeError("fetch failed: redirect not allowed"));
    const errTyped = await expectFailure(
      typed.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "network_failure",
    );
    expect(errTyped.message).toContain("TypeError");
    expect(errTyped.message).not.toContain("redirect not allowed");

    // A non-Error throw still lands as a typed network_failure.
    const nonError: FetchPort = async () => {
      throw "boom-string";
    };
    const weird = directAdapter({ port: nonError });
    const errWeird = await expectFailure(
      weird.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "network_failure",
    );
    expect(errWeird.message).not.toContain("boom-string");
  });

  it("a DISABLED rule refuses read, apply, AND revert loudly (invalid_value) with no write attempted", async () => {
    const address = addressOf("set_title");
    const disabled = {
      ...ruleFor(address.op, PAGE_PATH, "killed by ops"),
      enabled: false,
    };
    const seed = { [MANIFEST_KEY]: seedManifest([disabled], 6) };

    const read = directAdapter({ values: seed });
    await expectFailure(
      read.adapter.readCurrent(TITLE_TARGET, ADAPTER_CTX),
      "invalid_value",
    );

    const write = directAdapter({ values: seed });
    await expectFailure(write.adapter.apply(TITLE_WRITE), "invalid_value");
    await expectFailure(
      write.adapter.revert({ ...TITLE_WRITE, before: "restore me" }),
      "invalid_value",
    );
    expect(write.fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(write.fake.value(MANIFEST_KEY)).toBe(seed[MANIFEST_KEY]);
  });

  it("a mismatched AdapterContext is property_mismatch BEFORE any network call — the pin is the isolation boundary", async () => {
    const { adapter, fake } = directAdapter();
    for (const ctx of [
      { ...ADAPTER_CTX, tenantId: "t2" },
      { ...ADAPTER_CTX, clientId: "c2" },
      { ...ADAPTER_CTX, propertyId: "prop-2" },
    ]) {
      await expectFailure(
        adapter.readCurrent(TITLE_TARGET, ctx),
        "property_mismatch",
      );
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("construction refuses malformed pins and any custom API base URL — without echoing the rejected value", () => {
    const base = {
      secrets: { resolve: async () => new VendorCredential(SECRET) },
      authRef: "vault://cloudflare/prop-1",
      fetch: new FakeCloudflareKv({
        apiToken: SECRET,
        accountId: ACCOUNT_ID,
        namespaceId: NAMESPACE_ID,
      }).port,
      clock: fixedClock("2026-07-09T15:00:00.000Z"),
    };
    const goodPin = {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      accountId: ACCOUNT_ID,
      zoneId: ZONE_ID,
      scriptName: SCRIPT_NAME,
      namespaceId: NAMESPACE_ID,
    };
    const badPins: Array<[string, Partial<typeof goodPin>]> = [
      ["uppercase account id", { accountId: ACCOUNT_ID.toUpperCase() }],
      ["31-char namespace", { namespaceId: NAMESPACE_ID.slice(0, 31) }],
      ["path traversal in zone", { zoneId: "../../../etc/passwd0000000000000" }],
      ["uppercase script name", { scriptName: "Edge-Autofix" }],
      ["leading-hyphen script", { scriptName: "-edge" }],
      ["64-char script name", { scriptName: "a".repeat(64) }],
    ];
    for (const [label, override] of badPins) {
      const badValue = Object.values(override)[0] as string;
      let thrown: unknown;
      try {
        new CloudflareEdgeAdapter({ ...base, pin: { ...goodPin, ...override } });
      } catch (err) {
        thrown = err;
      }
      expect(isWriteMethodError(thrown), label).toBe(true);
      expect((thrown as WriteMethodError).code).toBe("misconfigured");
      expect((thrown as WriteMethodError).message).not.toContain(badValue);
    }

    const evil = `https://evil.example/?token=${SECRET}`;
    let thrown: unknown;
    try {
      new CloudflareEdgeAdapter({ ...base, pin: goodPin, apiBaseUrl: evil });
    } catch (err) {
      thrown = err;
    }
    expect(isWriteMethodError(thrown)).toBe(true);
    expect((thrown as WriteMethodError).code).toBe("misconfigured");
    expect((thrown as WriteMethodError).message).not.toContain("evil.example");
    expect((thrown as WriteMethodError).message).not.toContain(SECRET);
  });

  it("credential containment across a full lifecycle + assorted failures: no persisted row, no thrown message, no stored byte ever carries the token", async () => {
    const { fake, manager, store } = harness();
    const preview = await manager.preview(
      desired(SPECS.set_title, null, "T"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    const failures: string[] = [];
    fake.failNextWith(403, 9109);
    try {
      await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    } catch (err) {
      failures.push((err as Error).message);
    }
    fake.rateLimitNext("soon");
    try {
      await manager.rollback(applied.change.id, { reason: "qa" }, CTX);
    } catch (err) {
      failures.push((err as Error).message);
    }
    await manager.rollback(applied.change.id, { reason: "qa" }, CTX);

    expect(failures).toHaveLength(2);
    for (const message of failures) expect(message).not.toContain(SECRET);
    expect(JSON.stringify(store.peek(applied.change.id))).not.toContain(SECRET);
    expect(fake.value(MANIFEST_KEY) ?? "").not.toContain(SECRET);
    // The token egresses in the Authorization header and NOWHERE else.
    for (const req of fake.requests) {
      expect(req.url).not.toContain(SECRET);
      expect(req.body ?? "").not.toContain(SECRET);
    }
  });
});
