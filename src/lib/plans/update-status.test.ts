/**
 * updateTaskStatus suite — the sanctioned thin write on tasks.status. Seams
 * mocked (requireOperator, the Supabase server client); the UUID clamp, the
 * legal-target check, the CAS-predicate derivation, and the honest 0-row
 * "conflict" mapping run for real.
 *
 * The REAL invariants (tenant scope, writer floor, the done⇒human_only coupling)
 * are enforced by RLS + the 0013 CHECK at the database; this suite pins the
 * action's frozen result shape + outcome mapping and that the CAS carries every
 * predicate manualCasFor derives (source set + level set), exactly like
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

interface Captured {
  patch?: unknown;
  eq: Record<string, unknown>;
  in: Record<string, unknown[]>;
}

/** Chainable supabase-js stub: captures the patch + eq/in filters; `select` is terminal. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const captured: Captured = { eq: {}, in: {} };
  const builder: {
    update: (patch: unknown) => typeof builder;
    eq: (col: string, val: unknown) => typeof builder;
    in: (col: string, vals: unknown[]) => typeof builder;
    select: () => Promise<{ data: unknown; error: unknown }>;
  } = {
    update(patch: unknown) {
      captured.patch = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      captured.eq[col] = val;
      return builder;
    },
    in(col: string, vals: unknown[]) {
      captured.in[col] = vals;
      return builder;
    },
    select: async () => result,
  };
  return { client: { from: () => builder }, captured };
}

const sorted = (xs: unknown[]) => [...xs].map(String).sort();

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

  it("a target outside the legal set → illegal_transition (pipeline/gate words never reach the DB)", async () => {
    for (const to of ["published", "approved", "in_review", "reverted"] as const) {
      const res = await updateTaskStatus({ taskId: TASK_ID, to });
      expect(res).toMatchObject({ ok: false, reason: "illegal_transition" });
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("updateTaskStatus — CAS shapes (source set + level set per target)", () => {
  it("→ in_progress: sources {todo, done}, levels {human_only, ai_draft}; writes ONLY status", async () => {
    const { client, captured } = fakeClient({ data: [{ id: TASK_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toEqual({ ok: true, status: "in_progress" });
    expect(captured.patch).toEqual({ status: "in_progress" });
    expect(captured.eq).toEqual({ tenant_id: "tenant-1", id: TASK_ID });
    expect(sorted(captured.in.status)).toEqual(["done", "todo"]);
    expect(sorted(captured.in.automation_level)).toEqual([
      "ai_draft_human_approve",
      "human_only",
    ]);
  });

  it("→ todo: source {in_progress}, levels {human_only, ai_draft} (move-back, both non-auto levels)", async () => {
    const { client, captured } = fakeClient({ data: [{ id: TASK_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await updateTaskStatus({ taskId: TASK_ID, to: "todo" });
    expect(res).toEqual({ ok: true, status: "todo" });
    expect(captured.patch).toEqual({ status: "todo" });
    expect(captured.in.status).toEqual(["in_progress"]);
    expect(sorted(captured.in.automation_level)).toEqual([
      "ai_draft_human_approve",
      "human_only",
    ]);
  });

  it("→ done: source {in_progress}, level {human_only} ONLY (a pipeline task can't be marked done)", async () => {
    const { client, captured } = fakeClient({ data: [{ id: TASK_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await updateTaskStatus({ taskId: TASK_ID, to: "done" });
    expect(res).toEqual({ ok: true, status: "done" });
    expect(captured.patch).toEqual({ status: "done" });
    expect(captured.in.status).toEqual(["in_progress"]);
    // human_only ONLY — the level set structurally excludes auto AND ai_draft.
    expect(captured.in.automation_level).toEqual(["human_only"]);
  });
});

describe("updateTaskStatus — honest 0-row / error mapping", () => {
  it("0 rows (moved / wrong level / foreign / gone) → conflict, no fake success", async () => {
    // e.g. a `done` target against an ai_draft/auto task: the CAS level set is
    // human_only-only, so it matches 0 rows — the SAME honest conflict as any
    // other non-match (and the 0013 DB CHECK is the authoritative backstop).
    const { client } = fakeClient({ data: [], error: null });
    createClientMock.mockResolvedValue(client);
    const res = await updateTaskStatus({ taskId: TASK_ID, to: "done" });
    expect(res).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("a DB error → write_failed (redacted, retryable)", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501" } });
    createClientMock.mockResolvedValue(client);
    const res = await updateTaskStatus({ taskId: TASK_ID, to: "in_progress" });
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
  });
});
