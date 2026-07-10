/**
 * cancelRun suite — the writer floor, the UUID clamp, and the CAS-on-queued
 * cancel (queued → canceled, the one legal raw tenant edge). Seams mocked
 * (requireOperator, the Supabase server client); the uuid clamp and the honest
 * 0-row "already started" mapping run for real.
 *
 * Note: the REAL invariants (tenant scope, writer floor, queued-only source) are
 * enforced by RLS + the 0012 runs_transition_guard at the database; this suite
 * pins the action's shape + outcome mapping, matching enqueue.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireOperatorMock, createClientMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/guards", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/guards")>();
  return { ...actual, requireOperator: requireOperatorMock };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

import { AuthorizationError } from "@/lib/auth/guards";
import { cancelRun } from "./cancel";

const OPERATOR = { tenantId: "tenant-1", role: "operator" as const, sub: "auth-user-1" };
const RUN_ID = "5f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

/** A chainable supabase-js stub: captures the patch + eq filters; `select` is the
 *  terminal (the action awaits `.update().eq()...select('id')`). */
function fakeClient(result: { data: unknown; error: unknown }) {
  const captured: { patch?: unknown; filters: Record<string, unknown> } = {
    filters: {},
  };
  const builder: {
    update: (patch: unknown) => typeof builder;
    eq: (col: string, val: unknown) => typeof builder;
    select: () => Promise<{ data: unknown; error: unknown }>;
  } = {
    update(patch: unknown) {
      captured.patch = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      captured.filters[col] = val;
      return builder;
    },
    select: async () => result,
  };
  const client = { from: () => builder };
  return { client, captured };
}

beforeEach(() => {
  requireOperatorMock.mockResolvedValue(OPERATOR);
});
afterEach(() => vi.restoreAllMocks());

describe("cancelRun — writer floor", () => {
  it("wrong role → forbidden, never touches the DB", async () => {
    requireOperatorMock.mockRejectedValueOnce(
      new AuthorizationError(["operator", "agency_admin"], "client_viewer")
    );
    const res = await cancelRun({ runId: RUN_ID });
    expect(res).toEqual({ ok: false, reason: "forbidden", error: expect.any(String) });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("cancelRun — clamp", () => {
  it("a non-uuid run id → not_found (never reaches Postgres)", async () => {
    const res = await cancelRun({ runId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("cancelRun — CAS on queued", () => {
  it("a queued row → canceled: sets ONLY status, scoped to tenant + id + queued", async () => {
    const { client, captured } = fakeClient({ data: [{ id: RUN_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await cancelRun({ runId: RUN_ID });
    expect(res).toEqual({ ok: true });
    // Only status is written (the guard's "cancel may only set status").
    expect(captured.patch).toEqual({ status: "canceled" });
    // Claim-sourced tenant + id + the queued CAS predicate.
    expect(captured.filters).toEqual({
      tenant_id: "tenant-1",
      id: RUN_ID,
      status: "queued",
    });
  });

  it("0 rows (already leased/finished/foreign) → already_started, no fake success", async () => {
    const { client } = fakeClient({ data: [], error: null });
    createClientMock.mockResolvedValue(client);
    const res = await cancelRun({ runId: RUN_ID });
    expect(res).toMatchObject({ ok: false, reason: "already_started" });
  });

  it("a DB error → cancel_failed (redacted, retryable)", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501" } });
    createClientMock.mockResolvedValue(client);
    const res = await cancelRun({ runId: RUN_ID });
    expect(res).toMatchObject({ ok: false, reason: "cancel_failed" });
  });
});
