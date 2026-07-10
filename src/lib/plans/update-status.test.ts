/**
 * updateTaskStatus suite — the sanctioned thin write on tasks.status. Seams
 * mocked (requireOperator, the Supabase server client); the UUID clamp, the
 * legal-target check, and the honest 0-row "conflict" mapping run for real.
 *
 * The REAL invariants (tenant scope, writer floor, human_only ownership) are
 * enforced by RLS at the database; this suite pins the action's frozen shape +
 * outcome mapping and that the CAS carries every predicate, exactly like
 * cancel.test.ts pins cancelRun.
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
import { updateTaskStatus } from "./update-status";

const OPERATOR = { tenantId: "tenant-1", role: "operator" as const, sub: "auth-user-1" };
const TASK_ID = "5f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

/** Chainable supabase-js stub: captures the patch + eq filters; `select` is terminal. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const captured: { patch?: unknown; filters: Record<string, unknown> } = { filters: {} };
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
  return { client: { from: () => builder }, captured };
}

beforeEach(() => {
  requireOperatorMock.mockResolvedValue(OPERATOR);
});
afterEach(() => vi.restoreAllMocks());

describe("updateTaskStatus — writer floor", () => {
  it("wrong role → forbidden, never touches the DB", async () => {
    requireOperatorMock.mockRejectedValueOnce(
      new AuthorizationError(["operator", "agency_admin"], "client_viewer"),
    );
    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toEqual({ ok: false, reason: "forbidden", error: expect.any(String) });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a non-AuthorizationError from the guard propagates (e.g. a redirect)", async () => {
    requireOperatorMock.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(updateTaskStatus({ taskId: TASK_ID, to: "todo" })).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("updateTaskStatus — input clamps (no DB round-trip)", () => {
  it("a non-uuid task id → not_found", async () => {
    const res = await updateTaskStatus({ taskId: "not-a-uuid", to: "in_progress" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a target outside the legal set → illegal_transition", async () => {
    for (const to of ["published", "approved", "in_review", "reverted"] as const) {
      const res = await updateTaskStatus({ taskId: TASK_ID, to });
      expect(res).toMatchObject({ ok: false, reason: "illegal_transition" });
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("updateTaskStatus — CAS", () => {
  it("todo→in_progress: sets ONLY status, scoped to tenant + id + human_only + source", async () => {
    const { client, captured } = fakeClient({ data: [{ id: TASK_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toEqual({ ok: true, status: "in_progress" });
    expect(captured.patch).toEqual({ status: "in_progress" });
    expect(captured.filters).toEqual({
      tenant_id: "tenant-1",
      id: TASK_ID,
      automation_level: "human_only",
      status: "todo", // the CAS source implied by the in_progress target
    });
  });

  it("in_progress→todo: the CAS source flips to in_progress", async () => {
    const { client, captured } = fakeClient({ data: [{ id: TASK_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await updateTaskStatus({ taskId: TASK_ID, to: "todo" });
    expect(res).toEqual({ ok: true, status: "todo" });
    expect(captured.filters.status).toBe("in_progress");
    expect(captured.filters.automation_level).toBe("human_only");
  });

  it("0 rows (moved / not human_only / foreign / gone) → conflict, no fake success", async () => {
    const { client } = fakeClient({ data: [], error: null });
    createClientMock.mockResolvedValue(client);
    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("a DB error → write_failed (redacted, retryable)", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501" } });
    createClientMock.mockResolvedValue(client);
    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
  });
});
