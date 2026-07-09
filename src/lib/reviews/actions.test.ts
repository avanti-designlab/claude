/**
 * M15 server-action suite (captureReviewSignal + draftReviewResponse +
 * listReviewSignals).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the deferred review-platform provider, the
 * deferred content provider → a ScriptedContentProvider); the role guard, uuid +
 * input clamps, the REAL monitor/sentiment/velocity/signal pipeline, the REAL
 * frozen compliance skill, M7's REAL readLockedBrandKit read path, and the real
 * row mapping all run. Pins the M15 hard properties:
 *  - the review SIGNAL persists to metrics(source='reviews') with a CLAIM-SOURCED
 *    tenant (never client-supplied); a hostile payload is dead weight;
 *  - a drafted response is NEVER persisted (no review_response type) and NEVER
 *    sent — it is a pre-approval artifact returned for the gates;
 *  - unconnected monitoring → monitor_unavailable (no misleading all-zero signal);
 *  - no locked brand kit → REFUSED (never a generic-voice fallback);
 *  - Gate 1a: a dormant vertical → no_playbook;
 *  - RLS-mirrored auth (operator writes; client_viewer forbidden to write, may READ);
 *  - redacted telemetry: one line, marker + stage + code, no review text/reply/PII.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ingestBrandKit } from "@/lib/production/brand-kit";
import { ScriptedContentProvider } from "@/lib/production/content";
import { ScriptedReviewPlatformProvider } from "./provider";
import {
  captureReviewSignal,
  draftReviewResponse,
  listReviewSignals,
  type CaptureReviewSignalInput,
  type DraftReviewResponseActionInput,
} from "./actions";
import type { IngestedReview } from "./types";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, reviewProviderMock, contentProviderMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  reviewProviderMock: vi.fn(),
  contentProviderMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./live-provider", () => ({ resolveReviewPlatformProvider: () => reviewProviderMock() }));
vi.mock("@/lib/production/content/live-provider", () => ({
  resolveContentProvider: () => contentProviderMock(),
}));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };

const TELEMETRY = /^\[review-write-failure\] stage=(signal_insert|signal_read|generate|thrown) code=[A-Za-z0-9_]{1,16}$/;

const CLIENT_ROW = { id: CLIENT_ID, vertical: "real-estate" };

function lockedRow() {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff" },
    voice: { descriptors: ["warm"], samples: ["We advise, we don’t sell."] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  return {
    id: "kit-1",
    client_id: CLIENT_ID,
    version: 1,
    locked: true,
    tokens: res.kit.tokens,
    voice_profile: res.kit.voice_profile,
    likeness_refs: res.kit.likeness_refs,
    assets: { logo_url: res.logoUrl, ingestion: res.report },
    created_at: "2026-07-09T00:00:00Z",
  };
}

const REVIEW: IngestedReview = {
  platform: "google",
  author: "Jordan",
  rating: 2,
  ratingScale: 5,
  text: "Closing took longer than expected.",
  postedAt: "2026-07-01T00:00:00Z",
  externalId: "g-1",
};

/** A review provider that returns one real review for google (connected). */
function connectedReviewProvider() {
  return new ScriptedReviewPlatformProvider().script({ platform: "google", reviews: [REVIEW] });
}
/** A review provider where the platform is unavailable (nothing connected). */
function unavailableReviewProvider() {
  return new ScriptedReviewPlatformProvider().failNext("google");
}
function benignContentProvider(body = "Thank you for the honest feedback, Jordan — we’ve improved our updates.") {
  return new ScriptedContentProvider().script({ result: { title: "Response", body, raw: {} } });
}

function setup(
  script: FakeScript,
  claims: unknown = OPERATOR_CLAIMS,
  reviewProvider = connectedReviewProvider(),
  contentProvider = benignContentProvider(),
) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  reviewProviderMock.mockReturnValue(reviewProvider);
  contentProviderMock.mockReturnValue(contentProvider);
  return fake;
}

const CAPTURE_INPUT: CaptureReviewSignalInput = {
  clientId: CLIENT_ID,
  platforms: [{ platform: "google", accountRef: "acct-google" }],
  windowDays: 30,
};
const DRAFT_INPUT: DraftReviewResponseActionInput = {
  clientId: CLIENT_ID,
  review: REVIEW,
  contextFacts: ["We now send weekly closing updates."],
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  reviewProviderMock.mockReset();
  contentProviderMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */
/* captureReviewSignal — authz + persistence security                  */
/* ------------------------------------------------------------------ */

describe("captureReviewSignal — authz (mirrors metrics_insert app.is_writer)", () => {
  it("client_viewer: forbidden, no Supabase client + no provider touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await captureReviewSignal(CAPTURE_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(reviewProviderMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed: a signal is computed + persisted to metrics(source='reviews')", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      metrics: { insert: { data: { id: "m-1" } } },
    });
    const res = await captureReviewSignal(CAPTURE_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.metricId).toBe("m-1");
    expect(res.signal.coveredPlatforms).toEqual(["google"]);
    expect(res.signal.sentiment.total).toBe(1);

    const insert = fake.inserts.find((i) => i.table === "metrics");
    expect(insert).toBeDefined();
    const row = insert!.values as Record<string, unknown>;
    expect(row.source).toBe("reviews");
    expect(row.tenant_id).toBe("tenant-1"); // claim-sourced
    expect(row.client_id).toBe(CLIENT_ID); // RLS-sourced
    expect(row).not.toHaveProperty("id");
  });
});

describe("captureReviewSignal — hostile payload is dead weight", () => {
  it("ignores forged tenant/source/id fields", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      metrics: { insert: { data: { id: "m-1" } } },
    });
    const hostile = {
      ...CAPTURE_INPUT,
      tenant_id: "attacker-tenant",
      source: "ga4",
      id: "attacker-row",
    } as unknown as CaptureReviewSignalInput;
    const res = await captureReviewSignal(hostile);
    expect(res.ok).toBe(true);
    const row = fake.inserts.find((i) => i.table === "metrics")!.values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.source).toBe("reviews");
    expect(row).not.toHaveProperty("id");
  });
});

/* ------------------------------------------------------------------ */
/* captureReviewSignal — honesty + refusals                            */
/* ------------------------------------------------------------------ */

describe("captureReviewSignal — refusals + honesty", () => {
  it("monitor_unavailable when nothing is connected — NO all-zero signal persisted", async () => {
    const fake = setup(
      { clients: { select: { data: CLIENT_ROW } } },
      OPERATOR_CLAIMS,
      unavailableReviewProvider(),
    );
    const res = await captureReviewSignal(CAPTURE_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "monitor_unavailable" });
    if (res.ok) return;
    expect(res.excludedPlatforms).toEqual(["google"]); // named, not zeroed
    // A misleading "0 reviews" signal is NOT written.
    expect(fake.inserts.some((i) => i.table === "metrics")).toBe(false);
  });

  it("invalid_input when no platforms are supplied", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await captureReviewSignal({ ...CAPTURE_INPUT, platforms: [] });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("no_playbook for a dormant vertical (Gate 1a), before monitoring", async () => {
    const fake = setup({ clients: { select: { data: { id: CLIENT_ID, vertical: "cannabis" } } } });
    const res = await captureReviewSignal(CAPTURE_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(reviewProviderMock).not.toHaveBeenCalled();
    expect(fake.inserts.some((i) => i.table === "metrics")).toBe(false);
  });

  it("not_found for a bad uuid (junk never reaches Postgres) and for an empty client read", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    expect(await captureReviewSignal({ ...CAPTURE_INPUT, clientId: "nope" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    setup({ clients: { select: { data: null } } });
    expect(await captureReviewSignal(CAPTURE_INPUT)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("write_failed on an insert error logs marker+stage+code ONLY (no review data leak)", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      metrics: { insert: { error: { code: "23503", message: "fk; text='Closing took longer'" } } },
    });
    const res = await captureReviewSignal(CAPTURE_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("code=23503");
    expect(lines[0]).not.toContain("Closing");
    expect(lines[0]).not.toContain("fk");
  });
});

/* ------------------------------------------------------------------ */
/* draftReviewResponse — pre-approval, never persisted, never sent     */
/* ------------------------------------------------------------------ */

describe("draftReviewResponse — governed like M8, never persisted/sent", () => {
  it("client_viewer: forbidden, no Supabase/provider touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await draftReviewResponse(DRAFT_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("operator: returns a PRE-APPROVAL draft and persists NOTHING (no review_response type)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [lockedRow()] } },
    });
    const res = await draftReviewResponse(DRAFT_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.draft.status).toBe("draft_pending_human_approval");
    expect(res.draft.report.responseType).toBe("review_response");
    // NOTHING is written — not content_items, not metrics, not a reply.
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("REFUSES a client with no locked brand kit (no generic-voice fallback)", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [] } },
    });
    const res = await draftReviewResponse(DRAFT_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_brand_kit" });
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("no_playbook for a dormant vertical, before reading the kit or generating", async () => {
    const fake = setup({ clients: { select: { data: { id: CLIENT_ID, vertical: "cannabis" } } } });
    const res = await draftReviewResponse(DRAFT_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(fake.selects.some((s) => s.table === "brand_kits")).toBe(false);
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("invalid_input for a review with no platform / no text+rating", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await draftReviewResponse({
      ...DRAFT_INPUT,
      review: { ...REVIEW, platform: "", text: "", rating: null },
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("maps a rejecting content provider to generation_unavailable + ONE redacted line", async () => {
    setup(
      { clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [lockedRow()] } } },
      OPERATOR_CLAIMS,
      connectedReviewProvider(),
      new ScriptedContentProvider().failNext(new Error("secret prompt boom")),
    );
    const res = await draftReviewResponse(DRAFT_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "generation_unavailable" });
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=generate");
    expect(lines[0]).not.toContain("secret");
  });
});

/* ------------------------------------------------------------------ */
/* listReviewSignals — read the signal queue (mirror metrics_select)   */
/* ------------------------------------------------------------------ */

describe("listReviewSignals", () => {
  const metricRow = {
    id: "m-1",
    source: "reviews",
    data: {
      schemaVersion: 1,
      signal: {
        windowDays: 30,
        capturedFor: "2026-07-09T00:00:00Z",
        totalIngested: 1,
        undatedCount: 0,
        coveredPlatforms: ["google"],
        excludedPlatforms: [],
        sentiment: { positive: 0, neutral: 0, negative: 1, unknownBasis: 0, total: 1 },
        velocity: { currentCount: 1, priorCount: 0, perDay: 1 / 30, trend: "rising", delta: 1 },
      },
    },
    captured_at: "2026-07-09T00:00:00Z",
  };

  it("client_viewer may LIST review signals (read open to any tenant member; RLS scopes)", async () => {
    setup({ metrics: { select: { data: [metricRow] } } }, VIEWER_CLAIMS);
    const res = await listReviewSignals({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].signal?.sentiment.negative).toBe(1);
  });

  it("not_found for a bad uuid; read_failed on a read error", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    expect(await listReviewSignals({ clientId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });

    setup({ metrics: { select: { error: { code: "PGRST301", message: "boom" } } } }, VIEWER_CLAIMS);
    expect(await listReviewSignals({ clientId: CLIENT_ID })).toMatchObject({ ok: false, reason: "read_failed" });
  });
});
