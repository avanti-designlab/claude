/**
 * `regeneratePlanForClient` server-action suite (carried ticket a, part 1).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect); the role guard, uuid clamp, server-side
 * plan generation, and row mapping all run for real. Pins the frozen
 * `RegeneratePlanResult` contract and the review-gated hard properties:
 *  - RLS-scoped load: a cross-tenant clientId is indistinguishable from a
 *    nonexistent one (both → not_found) — correct and intended;
 *  - idempotence: an existing plan WITH tasks is returned untouched
 *    (alreadyExisted: true), never duplicated;
 *  - zero-task residue is superseded by ids (tenant-scoped delete), then a
 *    fresh plan persists (alreadyExisted: false);
 *  - every failure is interface-voice, and every plan-write failure emits
 *    exactly ONE redacted telemetry line (marker + stage + code — ticket d):
 *    no payloads, no tenant ids, no error message text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan } from "@/lib/plan";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { TaskInsertRow } from "@/lib/plans/rows";
import {
  fakePostgrest,
  type FakeScript,
} from "@/lib/plans/postgrest-fake";
import { regeneratePlanForClient, type RegeneratePlanResult } from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getClaims: getClaimsMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const ADMIN_CLAIMS = {
  tenantId: "tenant-1",
  role: "agency_admin" as const,
  sub: "user-1",
};

const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

const CLIENT_ROW = {
  id: CLIENT_ID,
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  status: "onboarding",
};

const ROADMAP = generatePlan({
  playbook: SEED_PLAYBOOKS["real-estate"],
  now: "2026-07-09T00:00:00.000Z",
});

const NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const WRITE_FAILED_ERROR =
  "We couldn’t rebuild this plan. Check your connection and try again.";

const TELEMETRY_LINE =
  /^\[plan-write-failure\] stage=(plan_insert|tasks_insert|cleanup_delete|supersede_delete|thrown) code=[A-Za-z0-9_]{1,16}$/;

function setup(script: FakeScript) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(ADMIN_CLAIMS);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

function okResult(result: RegeneratePlanResult) {
  if (!result.ok) throw new Error(`expected ok:true, got: ${result.error}`);
  return result;
}

function failResult(result: RegeneratePlanResult) {
  if (result.ok) throw new Error("expected ok:false, got ok:true");
  return result;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

/** Every console.error line emitted (each call must be a single string arg). */
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    return call[0] as string;
  });
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

/* ------------------------------------------------------------------ */
/* authz + input clamp                                                 */
/* ------------------------------------------------------------------ */

describe("regeneratePlanForClient — authz and input clamp", () => {
  it("wrong role: interface-voice permission error (reason write_failed), no Supabase client built", async () => {
    getClaimsMock.mockResolvedValue({
      tenantId: "tenant-1",
      role: "operator",
      sub: "user-2",
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    // Documented mapping: the frozen reason set has no permission bucket, so
    // a role failure buckets as write_failed; the STRING carries the truth.
    expect(result.reason).toBe("write_failed");
    expect(result.error).toContain("agency-admin");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(
      regeneratePlanForClient({ clientId: CLIENT_ID })
    ).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID clientId: not_found before any DB call — junk never reaches Postgres", async () => {
    getClaimsMock.mockResolvedValue(ADMIN_CLAIMS);
    for (const bad of ["not-a-uuid", "", "42 or 1=1", CLIENT_ID.slice(1)]) {
      const result = failResult(await regeneratePlanForClient({ clientId: bad }));
      expect(result.reason).toBe("not_found");
      expect(result.error).toBe(NOT_FOUND_ERROR);
    }
    const hostile = failResult(
      await regeneratePlanForClient({
        clientId: 42,
      } as unknown as { clientId: string })
    );
    expect(hostile.reason).toBe("not_found");
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* not_found / no_playbook                                             */
/* ------------------------------------------------------------------ */

describe("regeneratePlanForClient — not_found and no_playbook", () => {
  it("client not visible under RLS (nonexistent OR another tenant's — same observation): not_found", async () => {
    const fake = setup({ clients: { select: { data: null } } });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      error: NOT_FOUND_ERROR,
    });
    // Only the client read happened — no plan reads, no writes.
    expect(fake.selects.map((s) => s.table)).toEqual(["clients"]);
    expect(fake.inserts).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("client READ failure is write_failed (retryable), never a false not_found", async () => {
    setup({ clients: { select: { error: { message: "connection reset" } } } });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("write_failed");
    expect(result.error).toBe(WRITE_FAILED_ERROR);
  });

  it("dormant vertical: calm no_playbook, no plan reads or writes", async () => {
    const fake = setup({
      clients: { select: { data: { ...CLIENT_ROW, vertical: "restaurants" } } },
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("no_playbook");
    expect(result.error).toContain("playbook ships");
    expect(fake.selects.map((s) => s.table)).toEqual(["clients"]);
    expect(fake.inserts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* idempotence: existing plan with tasks                               */
/* ------------------------------------------------------------------ */

describe("regeneratePlanForClient — existing plan is returned, never duplicated", () => {
  it("plan WITH tasks exists: ok, alreadyExisted true, existing plan mapped, zero writes", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: {
          data: [
            {
              id: "plan-1",
              playbook_version: ROADMAP.playbookVersion,
              generated_roadmap: ROADMAP,
            },
          ],
        },
      },
      tasks: {
        select: {
          data: [
            { plan_id: "plan-1" },
            { plan_id: "plan-1" },
            { plan_id: "plan-1" },
          ],
        },
      },
    });
    const result = okResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));
    expect(result.alreadyExisted).toBe(true);
    expect(result.plan).toEqual({
      id: "plan-1",
      playbookVersion: ROADMAP.playbookVersion,
      taskCount: 3,
      roadmap: ROADMAP,
    });
    expect(fake.inserts).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("zero-task residue NEWER than a good plan cannot shadow it (rows arrive newest-first)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: {
          data: [
            {
              id: "residue-1",
              playbook_version: ROADMAP.playbookVersion,
              generated_roadmap: ROADMAP,
            },
            {
              id: "plan-good",
              playbook_version: ROADMAP.playbookVersion,
              generated_roadmap: ROADMAP,
            },
          ],
        },
      },
      tasks: {
        select: { data: [{ plan_id: "plan-good" }, { plan_id: "plan-good" }] },
      },
    });
    const result = okResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));
    expect(result.alreadyExisted).toBe(true);
    expect(result.plan.id).toBe("plan-good");
    expect(result.plan.taskCount).toBe(2);
    // Tolerated residue stays: no writes at all on the exists path.
    expect(fake.inserts).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* supersede + fresh persist                                           */
/* ------------------------------------------------------------------ */

describe("regeneratePlanForClient — zero-task residue is superseded, then persisted fresh", () => {
  it("deletes exactly the residue rows (tenant-scoped, by id), persists plan + tasks", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: {
          data: [
            { id: "stale-1", playbook_version: "1.0.0", generated_roadmap: ROADMAP },
            { id: "stale-2", playbook_version: "1.0.0", generated_roadmap: ROADMAP },
          ],
        },
        insert: { data: { id: "plan-9" } },
      },
      tasks: { select: { data: [] } },
    });
    const result = okResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));

    expect(result.alreadyExisted).toBe(false);
    expect(result.plan.id).toBe("plan-9");
    expect(result.plan.taskCount).toBeGreaterThan(0);

    // Supersede: pinned to the ids we read — never a blanket client_id sweep.
    expect(fake.deletes).toEqual([
      {
        table: "plans",
        filters: {
          tenant_id: "tenant-1",
          client_id: CLIENT_ID,
          id: ["stale-1", "stale-2"],
        },
      },
    ]);

    // Fresh persist: claim-sourced tenant on every row.
    expect(fake.inserts.map((i) => i.table)).toEqual(["plans", "tasks"]);
    const taskRows = fake.inserts[1].values as TaskInsertRow[];
    expect(taskRows.length).toBe(result.plan.taskCount);
    for (const row of taskRows) {
      expect(row.tenant_id).toBe("tenant-1");
      expect(row.client_id).toBe(CLIENT_ID);
      expect(row.plan_id).toBe("plan-9");
    }
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("no plan rows at all: straight to fresh persist (no tasks read, no delete)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: { select: { data: [] }, insert: { data: { id: "plan-9" } } },
    });
    const result = okResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));
    expect(result.alreadyExisted).toBe(false);
    expect(result.plan.id).toBe("plan-9");
    expect(fake.selects.map((s) => s.table)).toEqual(["clients", "plans"]);
    expect(fake.deletes).toEqual([]);
  });

  it("supersede delete failure: write_failed, no fresh insert, one redacted telemetry line", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: {
          data: [
            { id: "stale-1", playbook_version: "1.0.0", generated_roadmap: ROADMAP },
          ],
        },
        delete: {
          error: { message: "permission denied for table plans", code: "42501" },
        },
      },
      tasks: { select: { data: [] } },
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("write_failed");
    expect(result.error).toBe(WRITE_FAILED_ERROR);
    expect(fake.inserts).toEqual([]);
    expect(loggedLines()).toEqual([
      "[plan-write-failure] stage=supersede_delete code=42501",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* write failures + redacted telemetry (ticket d)                      */
/* ------------------------------------------------------------------ */

describe("regeneratePlanForClient — write failures and telemetry redaction", () => {
  it("plan insert failure: write_failed + one marker line with stage and code only", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: { data: [] },
        insert: {
          error: {
            message: `insert or update on table "plans" violates … ${CLIENT_ROW.name} tenant-1 SECRET-ROW-DATA`,
            details: `Failing row contains (${CLIENT_ID}, tenant-1, …)`,
            hint: "hostile hint",
            code: "23503",
          },
        },
      },
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("write_failed");

    const lines = loggedLines();
    expect(lines).toEqual(["[plan-write-failure] stage=plan_insert code=23503"]);
    // Redaction: no payloads, no user data, no tenant/client ids, no message text.
    for (const forbidden of [
      CLIENT_ROW.name,
      CLIENT_ID,
      "tenant-1",
      "SECRET-ROW-DATA",
      "Failing row",
      "hostile hint",
    ]) {
      expect(lines[0]).not.toContain(forbidden);
    }
  });

  it("tasks insert failure: cleanup delete runs; one line for the failure (cleanup success logs nothing)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: { select: { data: [] }, insert: { data: { id: "plan-9" } } },
      tasks: { insert: { error: { message: "connection reset", code: "57014" } } },
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("write_failed");
    expect(fake.deletes).toEqual([
      { table: "plans", filters: { tenant_id: "tenant-1", id: "plan-9" } },
    ]);
    expect(loggedLines()).toEqual([
      "[plan-write-failure] stage=tasks_insert code=57014",
    ]);
  });

  it("tasks insert failure AND cleanup delete failure: two lines, one per failed stage", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: { data: [] },
        insert: { data: { id: "plan-9" } },
        delete: { error: { message: "socket hang up" } },
      },
      tasks: { insert: { error: { message: "connection reset", code: "57014" } } },
    });
    failResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));
    expect(loggedLines()).toEqual([
      "[plan-write-failure] stage=tasks_insert code=57014",
      "[plan-write-failure] stage=cleanup_delete code=unknown",
    ]);
  });

  it("thrown mid-persist: write_failed, stage=thrown, message never logged", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: { data: [] },
        insert: { throws: new Error("kaboom with tenant-1 row data") },
      },
    });
    const result = failResult(
      await regeneratePlanForClient({ clientId: CLIENT_ID })
    );
    expect(result.reason).toBe("write_failed");
    const lines = loggedLines();
    expect(lines).toEqual(["[plan-write-failure] stage=thrown code=unknown"]);
    expect(lines[0]).not.toContain("kaboom");
  });

  it("a hostile error `code` cannot smuggle data: non-token codes collapse to unknown", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      plans: {
        select: { data: [] },
        insert: {
          error: { message: "boom", code: "23505; select * from tenants --" },
        },
      },
    });
    failResult(await regeneratePlanForClient({ clientId: CLIENT_ID }));
    const lines = loggedLines();
    expect(lines).toEqual(["[plan-write-failure] stage=plan_insert code=unknown"]);
    expect(lines[0]).toMatch(TELEMETRY_LINE);
  });
});
