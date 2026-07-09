/**
 * `createClientFromOnboarding` server-action suite (onboarding write path:
 * client row + server-generated plan + tasks — doc 03 §3/§6, migration 0004).
 *
 * Only the action's seams are mocked (the verified-claims reader, the Supabase
 * server client, next/navigation's redirect); the role guard, validation,
 * server-side plan generation, and row mapping all run for real. The suite
 * pins the review-gated hard properties:
 *  - tenant_id is CLAIM-SOURCED on every row (clients, plans, tasks) — never
 *    read from the browser payload, even when the payload smuggles one in
 *  - the roadmap is generated SERVER-SIDE from the server-loaded playbook; a
 *    browser-supplied "roadmap" is dead weight
 *  - partial failure fails SOFT: client kept (never deleted), plan null,
 *    interface-voice planWarning
 *  - persisted automation_level values mirror the generator and stay inside
 *    the frozen CHECK set (doc 03 §6)
 *  - unauthenticated → NEXT_REDIRECT propagates (also covers env-unset, which
 *    reads as unauthenticated); wrong role → interface-voice error, no throw
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan } from "@/lib/plan";
import { ACTIVE_VERTICALS, SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { PlanInsertRow, TaskInsertRow } from "@/lib/plans/rows";
import { AUTOMATION_LEVELS } from "@/lib/types/db";
import {
  createClientFromOnboarding,
  type CreateClientInput,
  type CreateClientResult,
} from "./actions";

/* ------------------------------------------------------------------ */
/* seams (hoisted above the imports by vitest)                         */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
}));

// The real package throws outside a React Server environment.
vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  // Mirror Next's control-flow throw: the action must RETHROW this from its
  // requireRole trap, never swallow it into an { ok: false }.
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
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface ScriptedResult {
  data?: Record<string, unknown> | null;
  error?: { message: string } | null;
}

interface FakeScript {
  clients?: ScriptedResult;
  plans?: ScriptedResult;
  tasks?: ScriptedResult;
}

/**
 * Minimal PostgREST-shaped fake: records every insert/delete per table and
 * answers from the script. Covers the three call shapes the action uses —
 * `.insert().select().single()`, a bare awaited bulk `.insert()` (builders
 * are thenables), and `.delete().eq().eq()`.
 */
function fakeSupabase(script: FakeScript) {
  const inserts: Array<{ table: string; values: unknown }> = [];
  const deletes: Array<{ table: string; filters: Record<string, unknown> }> =
    [];

  const client = {
    from(table: string) {
      return {
        insert(values: unknown) {
          inserts.push({ table, values });
          const scripted: ScriptedResult =
            (table === "clients"
              ? script.clients
              : table === "plans"
                ? script.plans
                : script.tasks) ?? {};
          const error = scripted.error ?? null;
          return {
            select() {
              return {
                single: async () => ({
                  data: error ? null : (scripted.data ?? null),
                  error,
                }),
              };
            },
            then(
              resolve: (value: { error: { message: string } | null }) => void
            ) {
              resolve({ error });
            },
          };
        },
        delete() {
          const filters: Record<string, unknown> = {};
          deletes.push({ table, filters });
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            then(resolve: (value: { error: null }) => void) {
              resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  return { client, inserts, deletes };
}

const ADMIN_CLAIMS = {
  tenantId: "tenant-1",
  role: "agency_admin" as const,
  sub: "user-1",
};

const SAVED_CLIENT_ROW = {
  id: "client-1",
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  status: "onboarding",
};

const HAPPY_SCRIPT: FakeScript = {
  clients: { data: SAVED_CLIENT_ROW },
  plans: { data: { id: "plan-1" } },
  tasks: {},
};

const INPUT: CreateClientInput = {
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  locations: [{ name: "North Park", address: "North Park" }],
};

const PLAN_WARNING =
  "Your client was saved, but we couldn’t generate the plan — retry from the dashboard.";

function setup(script: FakeScript = HAPPY_SCRIPT) {
  const fake = fakeSupabase(script);
  getClaimsMock.mockResolvedValue(ADMIN_CLAIMS);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

/** Narrow to the ok branch or fail the test loudly. */
function okResult(result: CreateClientResult) {
  if (!result.ok) throw new Error(`expected ok:true, got: ${result.error}`);
  return result;
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
});

/* ------------------------------------------------------------------ */
/* happy path                                                          */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — happy path (client + plan + tasks)", () => {
  it("persists client, then plan, then tasks — tenant_id claim-sourced on every row", async () => {
    const fake = setup();
    const result = okResult(await createClientFromOnboarding(INPUT));

    expect(result.client).toEqual({
      id: "client-1",
      name: "Gable & Grove Realty",
      vertical: "real-estate",
      status: "onboarding",
    });
    expect(result.planWarning).toBeUndefined();

    // Write order is the contract: client (anchor) → plan → tasks.
    expect(fake.inserts.map((i) => i.table)).toEqual([
      "clients",
      "plans",
      "tasks",
    ]);

    const clientValues = fake.inserts[0].values as Record<string, unknown>;
    expect(clientValues.tenant_id).toBe("tenant-1");

    const planValues = fake.inserts[1].values as PlanInsertRow;
    expect(planValues.tenant_id).toBe("tenant-1");
    expect(planValues.client_id).toBe("client-1");
    expect(planValues.playbook_version).toBe(
      SEED_PLAYBOOKS["real-estate"].version
    );

    const taskValues = fake.inserts[2].values as TaskInsertRow[];
    expect(taskValues.length).toBeGreaterThan(0);
    for (const row of taskValues) {
      expect(row.tenant_id).toBe("tenant-1");
      expect(row.client_id).toBe("client-1");
      expect(row.plan_id).toBe("plan-1");
      expect(row.status).toBe("todo");
    }

    expect(result.plan).not.toBeNull();
    expect(result.plan?.id).toBe("plan-1");
    expect(result.plan?.playbookVersion).toBe(
      SEED_PLAYBOOKS["real-estate"].version
    );
    expect(result.plan?.taskCount).toBe(taskValues.length);
    expect(result.plan?.roadmap.tasks).toHaveLength(taskValues.length);
  });

  it("generates the roadmap SERVER-SIDE; a browser-smuggled roadmap/tenant is dead weight", async () => {
    const fake = setup();
    const hostile = {
      ...INPUT,
      // Neither field exists on CreateClientInput — a hostile browser sends
      // them anyway. The action must read only name/vertical/locations.
      tenant_id: "tenant-evil",
      roadmap: { tasks: [{ title: "attacker task", automationLevel: "auto" }] },
    } as CreateClientInput;

    okResult(await createClientFromOnboarding(hostile));

    const clientValues = fake.inserts[0].values as Record<string, unknown>;
    expect(clientValues.tenant_id).toBe("tenant-1"); // claim, not payload

    const persisted = (fake.inserts[1].values as PlanInsertRow)
      .generated_roadmap;
    // Recomputing with the persisted timestamp must reproduce the stored
    // roadmap byte-for-byte — proof it came from the server generator.
    const expected = generatePlan({
      playbook: SEED_PLAYBOOKS["real-estate"],
      now: persisted.generatedAt,
    });
    expect(persisted).toEqual(expected);
    expect(JSON.stringify(persisted)).not.toContain("attacker task");
  });

  it("persisted automation_level values mirror the generator and stay in the frozen CHECK set", async () => {
    const fake = setup();
    okResult(await createClientFromOnboarding(INPUT));

    const persisted = (fake.inserts[1].values as PlanInsertRow)
      .generated_roadmap;
    const taskValues = fake.inserts[2].values as TaskInsertRow[];
    taskValues.forEach((row, index) => {
      expect(AUTOMATION_LEVELS).toContain(row.automation_level);
      // Pass-through, never invented or widened: 'auto' appears iff the
      // generator emitted exactly 'auto' on that item.
      expect(row.automation_level).toBe(persisted.tasks[index].automationLevel);
    });
  });
});

/* ------------------------------------------------------------------ */
/* partial failure (client saved, plan path failed)                    */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — partial failure fails soft", () => {
  it("plan insert failure: client kept, plan null, interface-voice warning, no tasks write", async () => {
    const fake = setup({
      clients: { data: SAVED_CLIENT_ROW },
      plans: { error: { message: "duplicate key value violates …" } },
    });
    const result = okResult(await createClientFromOnboarding(INPUT));

    expect(result.client.id).toBe("client-1");
    expect(result.plan).toBeNull();
    expect(result.planWarning).toBe(PLAN_WARNING);
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients", "plans"]);
    // The client row is NEVER deleted on a plan failure.
    expect(fake.deletes).toEqual([]);
  });

  it("tasks insert failure: plan reported null, orphan plan best-effort deleted, client never deleted", async () => {
    const fake = setup({
      clients: { data: SAVED_CLIENT_ROW },
      plans: { data: { id: "plan-1" } },
      tasks: { error: { message: "connection reset" } },
    });
    const result = okResult(await createClientFromOnboarding(INPUT));

    expect(result.plan).toBeNull();
    expect(result.planWarning).toBe(PLAN_WARNING);
    expect(fake.deletes).toEqual([
      { table: "plans", filters: { tenant_id: "tenant-1", id: "plan-1" } },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* no-active-playbook verticals (Gate 1a)                              */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — verticals without an active playbook", () => {
  it("dormant seed vertical: client persists, no plan, no warning", async () => {
    // Guard the premise: restaurants is seeded but not ACTIVE (Gate 1a).
    expect(ACTIVE_VERTICALS).not.toContain("restaurants");

    const fake = setup({
      clients: { data: { ...SAVED_CLIENT_ROW, vertical: "restaurants" } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, vertical: "restaurants" })
    );

    expect(result.client.vertical).toBe("restaurants");
    expect(result.plan).toBeNull();
    expect(result.planWarning).toBeUndefined(); // nothing failed
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
  });

  it("unknown vertical (open set): client persists, no plan, no warning", async () => {
    const fake = setup({
      clients: { data: { ...SAVED_CLIENT_ROW, vertical: "dentists" } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, vertical: "dentists" })
    );

    expect(result.plan).toBeNull();
    expect(result.planWarning).toBeUndefined();
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
  });
});

/* ------------------------------------------------------------------ */
/* authz + validation + client-insert failure (existing hard props)    */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — authz and validation", () => {
  it("wrong role: interface-voice permission error, no Supabase client built", async () => {
    getClaimsMock.mockResolvedValue({
      tenantId: "tenant-1",
      role: "operator",
      sub: "user-2",
    });
    const result = await createClientFromOnboarding(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("agency-admin");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("unauthenticated (also env-unset): NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(createClientFromOnboarding(INPUT)).rejects.toThrow(
      /NEXT_REDIRECT:\/login/
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("rejects a blank name before touching the database", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({ ...INPUT, name: "   " });
    expect(result).toEqual({
      ok: false,
      error: "Add a name for this client before saving.",
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("rejects a blank vertical before touching the database", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({
      ...INPUT,
      vertical: " ",
    });
    expect(result).toEqual({
      ok: false,
      error: "Pick an industry for this client before saving.",
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("client insert failure: ok:false in interface voice, no plan attempted", async () => {
    const fake = setup({ clients: { error: { message: "RLS violation" } } });
    const result = await createClientFromOnboarding(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "We couldn’t save this client. Check your connection and try again — nothing was created."
    );
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
  });
});
