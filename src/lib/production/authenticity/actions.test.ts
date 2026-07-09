/**
 * M9 server-action suite (runAuthenticityGate + readAuthenticityVerdict).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the deferred humanizer + detector panel via
 * ./live-providers); the role guard, uuid clamp, the REAL authenticate core, the
 * REAL drift recheck (reusing M8's grounding pass), M7's REAL readLockedBrandKit
 * path, and the real row mapping all run. Pins the governance-critical properties:
 *  - M9 NEVER advances to approved/published — the persisted status is 'in_review',
 *    and no review verdict column is ever written (self-approval is impossible);
 *  - claim-sourced tenant on the update filter (never caller-supplied);
 *  - a hostile input payload is dead weight;
 *  - detection scores recorded VERBATIM; a flagged item is not force-passed;
 *  - providers unavailable ⇒ honest unavailable, NOTHING persisted;
 *  - redacted telemetry: one line, marker + stage + code, no body/scores/PII;
 *  - RLS-mirrored auth (operator may run; client_viewer forbidden but may READ).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ingestBrandKit } from "@/lib/production/brand-kit";
import { ScriptedDetectionProvider } from "./detector";
import { ScriptedHumanizerProvider } from "./humanizer";
import { runAuthenticityGate, readAuthenticityVerdict } from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, humanizerMock, panelMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  humanizerMock: vi.fn(),
  panelMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
// The deferred vendors are stubbed to scriptable fakes so the pipeline runs with
// no vendor SDK / network (mirrors M8 mocking ./live-provider).
vi.mock("./live-providers", () => ({
  resolveHumanizerProvider: () => humanizerMock(),
  resolveDetectorPanel: () => panelMock(),
}));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const DRAFT_ID = "1b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };

const TELEMETRY = /^\[authenticity-write-failure\] stage=(draft_read|humanize|humanization_update|verdict_read|thrown) code=[A-Za-z0-9_]{1,16}$/;

const ORIGINAL = "We advise expat buyers through the purchase process.";
const CLEAN = "We guide expat buyers through the purchase process with care.";

/** A locked `brand_kits` row with a KNOWN voice profile (empty dont ⇒ no incidental voice drift). */
function lockedRow() {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff" },
    voice: { descriptors: ["confident"], samples: ["We advise, we don’t sell."] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  return {
    id: "kit-1",
    client_id: CLIENT_ID,
    version: 1,
    locked: true,
    tokens: res.kit.tokens,
    voice_profile: { descriptors: ["confident"], samples: [], do: [], dont: ["cheap"] },
    likeness_refs: res.kit.likeness_refs,
    assets: { logo_url: res.logoUrl, ingestion: res.report },
    created_at: "2026-07-09T00:00:00Z",
  };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    client_id: CLIENT_ID,
    brand_kit_id: "kit-1",
    type: "blog",
    automation_level: "ai_draft_human_approve",
    body: ORIGINAL,
    status: "draft",
    humanization: null,
    ...overrides,
  };
}

function cleanHumanizer() {
  return new ScriptedHumanizerProvider("hz").rewrite(() => CLEAN);
}
function passingPanel() {
  return [new ScriptedDetectionProvider("d1", 0.1), new ScriptedDetectionProvider("d2", 0.2)];
}

function setup(
  script: FakeScript,
  claims: unknown = OPERATOR_CLAIMS,
  humanizer: unknown = cleanHumanizer(),
  panel: unknown = passingPanel(),
) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  humanizerMock.mockReturnValue(humanizer);
  panelMock.mockReturnValue(panel);
  return fake;
}

/** Happy-path script: draft read → locked kit → client vertical → humanization update. */
function happyScript(draftOverrides: Record<string, unknown> = {}): FakeScript {
  return {
    content_items: { select: { data: draftRow(draftOverrides) }, update: { data: { id: "ci-1" } } },
    brand_kits: { select: { data: [lockedRow()] } },
    clients: { select: { data: { id: CLIENT_ID, vertical: "real-estate" } } },
  };
}

function contentUpdate(fake: ReturnType<typeof fakePostgrest>) {
  return fake.updates.find((u) => u.table === "content_items");
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  humanizerMock.mockReset();
  panelMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */
/* authz                                                               */
/* ------------------------------------------------------------------ */

describe("runAuthenticityGate — authz (mirrors content_items_update app.is_writer)", () => {
  it("client_viewer: forbidden, no Supabase client + no providers touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(humanizerMock).not.toHaveBeenCalled();
    expect(panelMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed: the gate runs + records a verdict", async () => {
    const fake = setup(happyScript());
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.verdict).toBe("passed");
    expect(res.verdict.passes).toBe(true);
    expect(contentUpdate(fake)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* the "M9 cannot approve/publish or self-review" structural guarantee  */
/* ------------------------------------------------------------------ */

describe("runAuthenticityGate — never advances to approved/published", () => {
  it("persists status='in_review' + the humanization record, and NO review verdict, claim-scoped", async () => {
    const fake = setup(happyScript());
    await runAuthenticityGate({ contentItemId: DRAFT_ID });

    const update = contentUpdate(fake)!;
    const values = update.values as Record<string, unknown>;
    // The one status M9 writes — the review stage, never approval.
    expect(values.status).toBe("in_review");
    expect(["approved", "published"]).not.toContain(values.status);
    // M9 owns humanization + (here) the humanized body; it writes NO review verdict.
    expect(values).toHaveProperty("humanization");
    expect(values.body).toBe(CLEAN);
    expect(values).not.toHaveProperty("quality_review");
    expect(values).not.toHaveProperty("compliance_review");
    expect(values).not.toHaveProperty("automation_level");
    // Tenant is CLAIM-SOURCED on the update filter (never caller-supplied); id pinned.
    expect(update.filters).toMatchObject({ id: DRAFT_ID, tenant_id: "tenant-1" });
  });

  it("a FLAGGED item still only advances to 'in_review' (scores verbatim, not force-passed)", async () => {
    const fake = setup(happyScript(), OPERATOR_CLAIMS, cleanHumanizer(), [
      new ScriptedDetectionProvider("d1", 0.1),
      new ScriptedDetectionProvider("d2", 0.85),
    ]);
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.verdict).toBe("flagged_for_human");
    expect(res.verdict.passes).toBe(false);
    // The above-threshold score is recorded verbatim.
    expect(res.verdict.detectors.find((d) => d.vendor === "d2")?.aiLikelihood).toBe(0.85);

    const values = contentUpdate(fake)!.values as Record<string, unknown>;
    expect(values.status).toBe("in_review"); // flagged, but still only the review stage
  });

  it("meaning drift ⇒ flagged, and the drifted body is NOT persisted (original kept)", async () => {
    const drifting = new ScriptedHumanizerProvider("hz").rewrite(
      () => `${CLEAN} We have closed 500 deals this year.`, // fabricated statistic
    );
    const fake = setup(happyScript(), OPERATOR_CLAIMS, drifting, [
      new ScriptedDetectionProvider("d1", 0.05),
      new ScriptedDetectionProvider("d2", 0.05), // detection would pass
    ]);
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.flaggedReasons).toContain("meaning_drift");
    expect(res.verdict.drift.meaning.map((m) => m.excerpt)).toContain("500");

    const values = contentUpdate(fake)!.values as Record<string, unknown>;
    expect(values).not.toHaveProperty("body"); // drifted text discarded
    expect(values.status).toBe("in_review");
  });

  it("humanizer introduces a Fair-Housing violation ⇒ flagged, humanized body NOT persisted, no review verdict", async () => {
    // A rewrite that is compliant-clean to drift (no stat/superlative/banned phrase) but a
    // Fair-Housing preference violation — caught only by the post-humanization compliance re-screen.
    const violating = new ScriptedHumanizerProvider("hz").rewrite(
      () => "This home is perfect for growing families near downtown.",
    );
    const fake = setup(happyScript(), OPERATOR_CLAIMS, violating, [
      new ScriptedDetectionProvider("d1", 0.05),
      new ScriptedDetectionProvider("d2", 0.05), // detection would pass
    ]);
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.flaggedReasons).toContain("compliance_regression");
    expect(res.verdict.passes).toBe(false);

    const values = contentUpdate(fake)!.values as Record<string, unknown>;
    expect(values).not.toHaveProperty("body"); // non-compliant humanized text discarded (original kept)
    expect(values.status).toBe("in_review"); // still only the review stage
    expect(values).not.toHaveProperty("compliance_review"); // M9 flags; it never writes the verdict
  });
});

/* ------------------------------------------------------------------ */
/* hostile input is dead weight                                        */
/* ------------------------------------------------------------------ */

describe("runAuthenticityGate — hostile input payload", () => {
  it("ignores smuggled status/tenant_id/humanization fields on the input", async () => {
    const fake = setup(happyScript());
    const hostile = {
      contentItemId: DRAFT_ID,
      status: "approved",
      tenant_id: "attacker-tenant",
      humanization: { passes: true, verdict: "passed" },
      body: "attacker body",
    } as unknown as { contentItemId: string };

    const res = await runAuthenticityGate(hostile);
    expect(res.ok).toBe(true);

    const update = contentUpdate(fake)!;
    const values = update.values as Record<string, unknown>;
    expect(values.status).toBe("in_review"); // not "approved"
    expect(values.body).toBe(CLEAN); // the humanized text, not "attacker body"
    expect(update.filters.tenant_id).toBe("tenant-1"); // claim, not "attacker-tenant"
    // The persisted humanization is the BUILT record (has detectors), not the smuggled object.
    expect((values.humanization as Record<string, unknown>).detectors).toBeDefined();
    expect((values.humanization as Record<string, unknown>).schemaVersion).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* providers unavailable ⇒ nothing persisted (never a silent pass)     */
/* ------------------------------------------------------------------ */

describe("runAuthenticityGate — deferred vendors", () => {
  it("humanizer unavailable ⇒ humanizer_unavailable, NO update, ONE redacted telemetry line", async () => {
    const fake = setup(
      happyScript(),
      OPERATOR_CLAIMS,
      new ScriptedHumanizerProvider("hz").failNext(new Error("secret draft prompt")),
      passingPanel(),
    );
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "humanizer_unavailable" });
    expect(contentUpdate(fake)).toBeUndefined(); // nothing persisted

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=humanize");
    expect(lines[0]).not.toContain("secret");
  });

  it("empty detector panel ⇒ detection_unavailable, NO update, NO log (expected deferred state)", async () => {
    const fake = setup(happyScript(), OPERATOR_CLAIMS, cleanHumanizer(), []);
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "detection_unavailable" });
    expect(contentUpdate(fake)).toBeUndefined();
    expect(loggedLines()).toHaveLength(0);
  });

  it("write_failed on an update error logs marker+stage+code ONLY (no message/score/data leak)", async () => {
    const fake = setup({
      content_items: {
        select: { data: draftRow() },
        update: { error: { code: "23514", message: "violates check; body='secret humanized text' score=0.9" } },
      },
      brand_kits: { select: { data: [lockedRow()] } },
      clients: { select: { data: { id: CLIENT_ID, vertical: "real-estate" } } },
    });
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
    expect(contentUpdate(fake)).toBeDefined(); // the update was attempted

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("code=23514");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("0.9");
  });
});

/* ------------------------------------------------------------------ */
/* refusals                                                            */
/* ------------------------------------------------------------------ */

describe("runAuthenticityGate — refusals", () => {
  it("already_reviewed for an item past the review stage (approved), no providers, no update", async () => {
    const fake = setup(happyScript({ status: "approved" }));
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "already_reviewed" });
    expect(humanizerMock).not.toHaveBeenCalled();
    expect(contentUpdate(fake)).toBeUndefined();
  });

  it("no_brand_kit when the client has no locked kit (no check-without-voice, no update)", async () => {
    const fake = setup({
      content_items: { select: { data: draftRow() }, update: { data: { id: "ci-1" } } },
      brand_kits: { select: { data: [] } },
    });
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "no_brand_kit" });
    expect(humanizerMock).not.toHaveBeenCalled();
    expect(contentUpdate(fake)).toBeUndefined();
  });

  it("not_found for a non-uuid id (junk never reaches Postgres)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await runAuthenticityGate({ contentItemId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("not_found when the RLS-scoped draft read is empty (cross-tenant == nonexistent)", async () => {
    setup({ content_items: { select: { data: null } } });
    const res = await runAuthenticityGate({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

/* ------------------------------------------------------------------ */
/* readAuthenticityVerdict — the gates' + dashboard's read             */
/* ------------------------------------------------------------------ */

describe("readAuthenticityVerdict (mirror content_items_select)", () => {
  const RICH = {
    humanized: true,
    detection_score: 0.85,
    passes: false,
    schemaVersion: 1,
    verdict: "flagged_for_human",
    flaggedReasons: ["detection_above_threshold"],
    humanizer: { vendor: "hz", applied: true },
    detectors: [{ vendor: "d2", available: true, aiLikelihood: 0.85, belowThreshold: false }],
    aggregate: { score: 0.85, detectorsAvailable: 2, detectorsBelow: 1, belowThreshold: false },
    quorum: { required: 2, met: false },
    thresholds: { passAt: 0.3, minDetectors: 2, requireUnanimous: true },
    drift: { meaning: [], voice: [], detected: false },
  };

  it("client_viewer may READ the verdict (open to any tenant member; RLS scopes)", async () => {
    setup({ content_items: { select: { data: { status: "in_review", humanization: RICH } } } }, VIEWER_CLAIMS);
    const res = await readAuthenticityVerdict({ contentItemId: DRAFT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("in_review");
    expect(res.verdict?.verdict).toBe("flagged_for_human");
    expect(res.verdict?.passes).toBe(false);
    expect(res.verdict?.detectionScore).toBe(0.85);
  });

  it("verdict:null when M9 has not run (humanization null)", async () => {
    setup({ content_items: { select: { data: { status: "draft", humanization: null } } } }, VIEWER_CLAIMS);
    const res = await readAuthenticityVerdict({ contentItemId: DRAFT_ID });
    expect(res).toMatchObject({ ok: true, verdict: null, status: "draft" });
  });

  it("not_found for a bad uuid; read_failed on a read error", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    expect(await readAuthenticityVerdict({ contentItemId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });

    setup({ content_items: { select: { error: { code: "PGRST301", message: "boom" } } } }, VIEWER_CLAIMS);
    expect(await readAuthenticityVerdict({ contentItemId: DRAFT_ID })).toMatchObject({ ok: false, reason: "read_failed" });
  });
});
