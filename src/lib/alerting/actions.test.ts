/**
 * M17 action suite (`runVisibilityAlertCheck` + `getActiveAlerts`).
 *
 * Mocks only the seams (verified-claims reader, Supabase server client,
 * next/navigation redirect, the M3 series read). The role guard, the uuid clamp,
 * the REAL visibility-drop rule, the REAL dedup+persist, and the REAL feed read
 * all run. Pins the review-gated properties:
 *  - fires ONLY on a real measured run-over-run drop (honesty: <2 runs ⇒ none);
 *  - claim-sourced tenant on the persisted alert (never client-supplied);
 *  - fail-closed on a failed series read (never mistaken for "no drop");
 *  - RLS-mirrored auth (operator may run; wrong role → forbidden; reads → requireAuth).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import type { AlertInsertRow } from "./rows";

const { getClaimsMock, createClientMock, seriesMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  seriesMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/intelligence/visibility/reads", () => ({ getVisibilityScoreSeries: seriesMock }));

import { getActiveAlerts, runVisibilityAlertCheck } from "./actions";

const OPERATOR = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: "c", sub: "u2" };
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";

function useDb(script: FakeScript) {
  const fake = fakePostgrest(script);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe("runVisibilityAlertCheck", () => {
  it("fires a claim-sourced visibility_drop alert on a real run-over-run drop", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    const fake = useDb({ alerts: { select: { data: [] }, insert: { error: null } } , clients: { select: { data: { id: CLIENT_ID } } } });
    seriesMock.mockResolvedValue({
      kind: "ok",
      truncated: false,
      series: [
        { runAt: "r1", score: 82 },
        { runAt: "r2", score: 48 },
      ],
    });

    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true, alerts: { kind: "inserted", inserted: 1, deduped: 0 }, runsAvailable: 2 });
    const written = fake.inserts[0].values as AlertInsertRow[];
    expect(written[0].type).toBe("visibility_drop");
    expect(written[0].tenant_id).toBe("tenant-1"); // claim, not caller
    expect(written[0].client_id).toBe(CLIENT_ID);
  });

  it("HONESTY: fewer than two runs ⇒ no alert (no baseline), never an error", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    useDb({ clients: { select: { data: { id: CLIENT_ID } } } });
    seriesMock.mockResolvedValue({ kind: "ok", truncated: false, series: [{ runAt: "r1", score: 40 }] });

    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true, alerts: { kind: "no_alerts" }, runsAvailable: 1 });
  });

  it("HONESTY: two runs but no drop ⇒ no candidate, no insert", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    const fake = useDb({ alerts: { select: { data: [] } }, clients: { select: { data: { id: CLIENT_ID } } } });
    seriesMock.mockResolvedValue({ kind: "ok", truncated: false, series: [{ runAt: "r1", score: 50 }, { runAt: "r2", score: 55 }] });

    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true, alerts: { kind: "no_alerts" }, runsAvailable: 2 });
    expect(fake.inserts).toEqual([]);
  });

  it("FAIL CLOSED: a failed series read is not 'no drop' — it is a retryable check_failed", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    useDb({ clients: { select: { data: { id: CLIENT_ID } } } });
    seriesMock.mockResolvedValue({ kind: "failed" });

    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("check_failed");
  });

  it("a wrong-role caller is forbidden and never reads or writes", async () => {
    getClaimsMock.mockResolvedValue(VIEWER);
    const fake = useDb({});
    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("forbidden");
    expect(fake.inserts).toEqual([]);
    expect(seriesMock).not.toHaveBeenCalled();
  });

  it("a non-uuid clientId is not_found before any DB work", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    useDb({});
    const res = await runVisibilityAlertCheck({ clientId: "not-a-uuid" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
    expect(seriesMock).not.toHaveBeenCalled();
  });

  it("a cross-tenant/nonexistent client (empty RLS read) is not_found, never runs the check", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    useDb({ clients: { select: { data: null } } });
    const res = await runVisibilityAlertCheck({ clientId: CLIENT_ID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
    expect(seriesMock).not.toHaveBeenCalled();
  });
});

describe("getActiveAlerts", () => {
  it("returns the unified feed for any authenticated tenant member (requireAuth, RLS-scoped)", async () => {
    getClaimsMock.mockResolvedValue(VIEWER);
    useDb({
      alerts: {
        select: {
          data: [{ id: "a1", type: "crawler_blocked", severity: "warning", payload: { summary: "s" }, acknowledged: false, created_at: "t" }],
        },
      },
    });
    const res = await getActiveAlerts({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.type)).toEqual(["crawler_blocked"]);
  });

  it("a non-uuid clientId is not_found", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR);
    useDb({});
    const res = await getActiveAlerts({ clientId: "junk" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });
});
