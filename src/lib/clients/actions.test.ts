/**
 * `createClientFromOnboarding` server-action suite (onboarding write path:
 * client row + server-generated plan + tasks — doc 03 §3/§6, migration 0004).
 *
 * Only the action's seams are mocked (the verified-claims reader, the Supabase
 * server client, next/navigation's redirect); the role guard, runtime clamp,
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
 *  - IDEMPOTENT CREATE (ticket a): a replayed idempotencyKey recovers the
 *    already-saved client (and finishes its plan) indistinguishably from a
 *    first-time success; a FOREIGN-tenant key collision returns the
 *    byte-identical generic failure — no existence leak
 *  - UPDATE-THROUGH RECONCILIATION (Code Review Major 1): a replayed key with
 *    EDITED fields updates the row to the confirmed values — never a silent
 *    stale return; a vertical edit supersedes the replay-run's plan (tasks
 *    first) before planning against the new playbook
 *  - RUNTIME CLAMP (ticket c): hostile shapes/oversizes are refused in
 *    interface voice before any DB call
 *  - REDACTED TELEMETRY (ticket d): plan-write failures log marker+stage+code
 *    only — no payloads, no tenant ids, no error message text
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePlan } from "@/lib/plan";
import { ACTIVE_VERTICALS, SEED_PLAYBOOKS } from "@/lib/playbooks";
import {
  fakePostgrest,
  type FakeScript,
} from "@/lib/plans/postgrest-fake";
import type { PlanInsertRow, TaskInsertRow } from "@/lib/plans/rows";
import { AUTOMATION_LEVELS } from "@/lib/types/db";
import {
  createClientFromOnboarding,
  type CreateClientInput,
  type CreateClientResult,
} from "./actions";
import { CLIENT_LOCATIONS_MAX, CLIENT_NAME_MAX_CHARS } from "./validate";

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
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

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
  clients: { insert: { data: SAVED_CLIENT_ROW } },
  plans: { insert: { data: { id: "plan-1" } } },
};

const INPUT: CreateClientInput = {
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  locations: [{ name: "North Park", address: "North Park" }],
};

/** A strict UUID v4 — the browser-minted idempotency key (ticket a). */
const KEY = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

/** What the DB row actually holds after attempt 1 — the recovery re-read now
 * selects `locations` too, so the fixture must model it. */
const KEYED_CLIENT_ROW = {
  ...SAVED_CLIENT_ROW,
  id: KEY,
  locations: INPUT.locations,
};

const PLAN_WARNING =
  "Your client was saved, but we couldn’t create their plan — generate it from their card on your dashboard.";

/** Pinned once, asserted byte-identical on BOTH failure paths (no-leak rule). */
const SAVE_FAILED_ERROR =
  "We couldn’t save this client. Check your connection and try again — nothing was created.";

function setup(script: FakeScript = HAPPY_SCRIPT) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(ADMIN_CLAIMS);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

/** Narrow to the ok branch or fail the test loudly. */
function okResult(result: CreateClientResult) {
  if (!result.ok) throw new Error(`expected ok:true, got: ${result.error}`);
  return result;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
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
    // No key supplied → no caller-set id (server-generated), pre-ticket behavior.
    expect("id" in clientValues).toBe(false);

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
      // them anyway. The action must read only the validated fields.
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
      clients: { insert: { data: SAVED_CLIENT_ROW } },
      plans: { insert: { error: { message: "duplicate key value violates …" } } },
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
      clients: { insert: { data: SAVED_CLIENT_ROW } },
      plans: { insert: { data: { id: "plan-1" } } },
      tasks: { insert: { error: { message: "connection reset" } } },
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
      clients: {
        insert: { data: { ...SAVED_CLIENT_ROW, vertical: "restaurants" } },
      },
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
      clients: {
        insert: { data: { ...SAVED_CLIENT_ROW, vertical: "dentists" } },
      },
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
    const fake = setup({
      clients: { insert: { error: { message: "RLS violation" } } },
    });
    const result = await createClientFromOnboarding(INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(SAVE_FAILED_ERROR);
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
  });
});

/* ------------------------------------------------------------------ */
/* runtime clamp at the seam (ticket c — full matrix in validate.test) */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — runtime clamp (ticket c)", () => {
  it("refuses an over-cap name before any DB call", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({
      ...INPUT,
      name: "n".repeat(CLIENT_NAME_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`capped at ${CLIENT_NAME_MAX_CHARS}`);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("hostile non-string name cannot throw or reach Postgres", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({
      ...INPUT,
      name: 42,
    } as unknown as CreateClientInput);
    expect(result).toEqual({
      ok: false,
      error: "Add a name for this client before saving.",
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("refuses an over-cap locations array before any DB call", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({
      ...INPUT,
      locations: Array(CLIENT_LOCATIONS_MAX + 1).fill({
        name: "N",
        address: "A",
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`up to ${CLIENT_LOCATIONS_MAX} locations`);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("persists the SANITIZED locations: unknown keys are stripped from the row", async () => {
    const fake = setup();
    okResult(
      await createClientFromOnboarding({
        ...INPUT,
        locations: [
          {
            name: " North Park ",
            address: " Ray St ",
            tenant_id: "tenant-evil",
          } as unknown as CreateClientInput["locations"][number],
        ],
      })
    );
    const clientValues = fake.inserts[0].values as Record<string, unknown>;
    expect(clientValues.locations).toEqual([
      { name: "North Park", address: "Ray St" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* idempotent create (ticket a — the duplicate-client footgun)         */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — idempotency key (ticket a)", () => {
  it("a valid key becomes the row id; everything else is unchanged", async () => {
    const fake = setup({
      clients: { insert: { data: KEYED_CLIENT_ROW } },
      plans: { insert: { data: { id: "plan-1" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, idempotencyKey: KEY })
    );
    const clientValues = fake.inserts[0].values as Record<string, unknown>;
    expect(clientValues.id).toBe(KEY);
    expect(clientValues.tenant_id).toBe("tenant-1"); // still claim-sourced
    expect(result.client.id).toBe(KEY);
    expect(result.plan?.id).toBe("plan-1");
  });

  it("an invalid key is refused before any DB call — junk never reaches Postgres", async () => {
    setup();
    createClientMock.mockClear();
    const result = await createClientFromOnboarding({
      ...INPUT,
      idempotencyKey: "'; drop table clients;--",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("looked malformed");
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("lost-response retry, plan already persisted: returns the saved client + existing plan, no duplicates", async () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS["real-estate"],
      now: "2026-07-09T00:00:00.000Z",
    });
    const fake = setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        select: { data: KEYED_CLIENT_ROW },
      },
      plans: {
        select: {
          data: [
            {
              id: "plan-1",
              playbook_version: roadmap.playbookVersion,
              generated_roadmap: roadmap,
            },
          ],
        },
      },
      tasks: { select: { data: [{ plan_id: "plan-1" }, { plan_id: "plan-1" }] } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, idempotencyKey: KEY })
    );

    // Indistinguishable from a first-time success: ok, client, plan, no warning.
    expect(result.client).toEqual({
      id: KEY,
      name: "Gable & Grove Realty",
      vertical: "real-estate",
      status: "onboarding",
    });
    expect(result.plan).toEqual({
      id: "plan-1",
      playbookVersion: roadmap.playbookVersion,
      taskCount: 2,
      roadmap,
    });
    expect(result.planWarning).toBeUndefined();
    // NEVER a duplicate: the only insert attempt was the colliding client row.
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
    expect(fake.deletes).toEqual([]);
  });

  it("lost-response retry, client saved but plan never persisted: the plan is recovered NOW", async () => {
    const fake = setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        select: { data: KEYED_CLIENT_ROW },
      },
      plans: { select: { data: [] }, insert: { data: { id: "plan-2" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, idempotencyKey: KEY })
    );

    expect(result.client.id).toBe(KEY);
    expect(result.plan?.id).toBe("plan-2");
    expect(result.plan?.taskCount).toBeGreaterThan(0);
    expect(result.planWarning).toBeUndefined();

    // The recovered persist is claim-scoped like any first-time write.
    expect(fake.inserts.map((i) => i.table)).toEqual([
      "clients",
      "plans",
      "tasks",
    ]);
    const taskRows = fake.inserts[2].values as TaskInsertRow[];
    for (const row of taskRows) {
      expect(row.tenant_id).toBe("tenant-1");
      expect(row.client_id).toBe(KEY);
      expect(row.plan_id).toBe("plan-2");
    }
  });

  it("lost-response retry onto zero-task residue: residue superseded, fresh plan persisted", async () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS["real-estate"],
      now: "2026-07-09T00:00:00.000Z",
    });
    const fake = setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        select: { data: KEYED_CLIENT_ROW },
      },
      plans: {
        select: {
          data: [
            {
              id: "stale-1",
              playbook_version: roadmap.playbookVersion,
              generated_roadmap: roadmap,
            },
          ],
        },
        insert: { data: { id: "plan-3" } },
      },
      tasks: { select: { data: [] } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, idempotencyKey: KEY })
    );
    expect(result.plan?.id).toBe("plan-3");
    expect(result.planWarning).toBeUndefined();
    expect(fake.deletes).toEqual([
      {
        table: "plans",
        filters: { tenant_id: "tenant-1", client_id: KEY, id: ["stale-1"] },
      },
    ]);
  });

  it("lost-response retry on a dormant vertical: ok, plan null, no warning (first-time shape)", async () => {
    setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        select: { data: { ...KEYED_CLIENT_ROW, vertical: "restaurants" } },
      },
    });
    const result = okResult(
      await createClientFromOnboarding({
        ...INPUT,
        vertical: "restaurants",
        idempotencyKey: KEY,
      })
    );
    expect(result.plan).toBeNull();
    expect(result.planWarning).toBeUndefined();
  });

  it("ADVERSARIAL: key collides with a FOREIGN tenant's row — byte-identical generic failure, no leak", async () => {
    const fake = setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        // RLS: the row exists (PK is global) but is NOT visible to us.
        select: { data: null },
      },
    });
    const result = await createClientFromOnboarding({
      ...INPUT,
      idempotencyKey: KEY,
    });

    // EXACTLY the same object as any other insert failure — no "already
    // exists", no distinct text an attacker could use as an existence oracle.
    expect(result).toEqual({ ok: false, error: SAVE_FAILED_ERROR });
    // And nothing beyond the one RLS-scoped re-read happened: no plan
    // probing, no reconciling update (the payload differs from the foreign
    // row by construction — divergence must never be evaluated here).
    expect(fake.selects.map((s) => s.table)).toEqual(["clients"]);
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
    expect(fake.updates).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("23505 WITHOUT a key (server-generated id): generic failure, no recovery attempted", async () => {
    const fake = setup({
      clients: { insert: { error: { message: "duplicate key", code: "23505" } } },
    });
    const result = await createClientFromOnboarding(INPUT);
    expect(result).toEqual({ ok: false, error: SAVE_FAILED_ERROR });
    expect(fake.selects).toEqual([]);
  });

  it("a keyed insert failing with a NON-unique-violation code: generic failure, no recovery attempted", async () => {
    const fake = setup({
      clients: {
        insert: { error: { message: "connection reset", code: "PGRST301" } },
      },
    });
    const result = await createClientFromOnboarding({
      ...INPUT,
      idempotencyKey: KEY,
    });
    expect(result).toEqual({ ok: false, error: SAVE_FAILED_ERROR });
    expect(fake.selects).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* update-through reconciliation (Code Review Major 1)                 */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — replayed key with operator edits (update-through)", () => {
  const COLLIDE = { error: { message: "duplicate key", code: "23505" } };

  it("name edit: the row is UPDATED to the confirmed values — never a stale return", async () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS["real-estate"],
      now: "2026-07-09T00:00:00.000Z",
    });
    const fake = setup({
      clients: {
        insert: COLLIDE,
        select: { data: KEYED_CLIENT_ROW },
        update: {
          data: { ...KEYED_CLIENT_ROW, name: "Gable & Grove Realty Group" },
        },
      },
      plans: {
        select: {
          data: [
            {
              id: "plan-1",
              playbook_version: roadmap.playbookVersion,
              generated_roadmap: roadmap,
            },
          ],
        },
      },
      tasks: { select: { data: [{ plan_id: "plan-1" }] } },
    });
    const result = okResult(
      await createClientFromOnboarding({
        ...INPUT,
        name: "Gable & Grove Realty Group",
        idempotencyKey: KEY,
      })
    );

    // The DB row now matches what the operator just confirmed — RLS-scoped,
    // pinned to the recovered id, all three reconciled columns submitted.
    expect(fake.updates).toEqual([
      {
        table: "clients",
        values: {
          name: "Gable & Grove Realty Group",
          vertical: "real-estate",
          locations: INPUT.locations,
        },
        filters: { tenant_id: "tenant-1", id: KEY },
      },
    ]);
    // …and the response announces exactly those values, keeping the plan
    // (vertical unchanged → the existing tasked plan is still correct).
    expect(result.client.name).toBe("Gable & Grove Realty Group");
    expect(result.plan?.id).toBe("plan-1");
    expect(result.planWarning).toBeUndefined();
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
    expect(fake.deletes).toEqual([]);
  });

  it("locations edit: the SANITIZED new locations are updated through; plan flow unchanged", async () => {
    const fake = setup({
      clients: {
        insert: COLLIDE,
        select: { data: KEYED_CLIENT_ROW },
        update: { data: KEYED_CLIENT_ROW },
      },
      plans: { select: { data: [] }, insert: { data: { id: "plan-2" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({
        ...INPUT,
        locations: [{ name: " South Park ", address: " 30th St " }],
        idempotencyKey: KEY,
      })
    );
    expect(fake.updates[0].values).toEqual({
      name: INPUT.name,
      vertical: "real-estate",
      // Sanitized (trimmed), never the raw payload.
      locations: [{ name: "South Park", address: "30th St" }],
    });
    // Vertical unchanged → no supersede; the missing plan is recovered as on
    // any identical replay.
    expect(fake.deletes).toEqual([]);
    expect(result.plan?.id).toBe("plan-2");
    expect(result.planWarning).toBeUndefined();
  });

  it("vertical edit (live→live): replay-run plan superseded — tasks first — and regenerated from the NEW playbook", async () => {
    // Gate 1a leaves only real-estate live; activate restaurants for THIS
    // test so a live→live vertical edit exists to exercise. Restored below.
    ACTIVE_VERTICALS.push("restaurants");
    try {
      const fake = setup({
        clients: {
          insert: COLLIDE,
          select: { data: KEYED_CLIENT_ROW }, // attempt 1 saved real-estate
          update: { data: { ...KEYED_CLIENT_ROW, vertical: "restaurants" } },
        },
        plans: {
          // First read: the replay-run's wrong-playbook plan ids; second read
          // (ensurePlan, after the supersede): none left.
          select: [{ data: [{ id: "old-plan" }] }, { data: [] }],
          insert: { data: { id: "plan-new" } },
        },
      });
      const result = okResult(
        await createClientFromOnboarding({
          ...INPUT,
          vertical: "restaurants",
          idempotencyKey: KEY,
        })
      );

      // Old tasks gone FIRST (tasks_plan_fk is on delete restrict), then the
      // old plan — both tenant-scoped AND pinned to the read ids.
      expect(fake.deletes).toEqual([
        {
          table: "tasks",
          filters: {
            tenant_id: "tenant-1",
            client_id: KEY,
            plan_id: ["old-plan"],
          },
        },
        {
          table: "plans",
          filters: { tenant_id: "tenant-1", client_id: KEY, id: ["old-plan"] },
        },
      ]);

      // The fresh plan was generated from the NEW vertical's playbook.
      expect(fake.inserts.map((i) => i.table)).toEqual([
        "clients",
        "plans",
        "tasks",
      ]);
      const persisted = (fake.inserts[1].values as PlanInsertRow)
        .generated_roadmap;
      expect(persisted).toEqual(
        generatePlan({
          playbook: SEED_PLAYBOOKS.restaurants,
          now: persisted.generatedAt,
        })
      );
      expect(result.client.vertical).toBe("restaurants");
      expect(result.plan?.id).toBe("plan-new");
      expect(result.planWarning).toBeUndefined();
    } finally {
      ACTIVE_VERTICALS.splice(ACTIVE_VERTICALS.indexOf("restaurants"), 1);
    }
  });

  it("vertical edit (live→dormant): old plan removed, plan null, NO warning (no-playbook contract)", async () => {
    const fake = setup({
      clients: {
        insert: COLLIDE,
        select: { data: KEYED_CLIENT_ROW },
        update: { data: { ...KEYED_CLIENT_ROW, vertical: "restaurants" } },
      },
      plans: { select: { data: [{ id: "old-plan" }] } },
    });
    const result = okResult(
      await createClientFromOnboarding({
        ...INPUT,
        vertical: "restaurants",
        idempotencyKey: KEY,
      })
    );
    expect(result.client.vertical).toBe("restaurants");
    expect(result.plan).toBeNull();
    expect(result.planWarning).toBeUndefined(); // nothing failed
    expect(fake.deletes).toEqual([
      {
        table: "tasks",
        filters: {
          tenant_id: "tenant-1",
          client_id: KEY,
          plan_id: ["old-plan"],
        },
      },
      {
        table: "plans",
        filters: { tenant_id: "tenant-1", client_id: KEY, id: ["old-plan"] },
      },
    ]);
    // No fresh plan: dormant verticals get none (Gate 1a).
    expect(fake.inserts.map((i) => i.table)).toEqual(["clients"]);
  });

  it("update failure: honest ok:false — never a stale success — with one redacted telemetry line", async () => {
    const fake = setup({
      clients: {
        insert: COLLIDE,
        select: { data: KEYED_CLIENT_ROW },
        update: {
          error: {
            message: "connection reset (Edited Name, tenant-1)",
            code: "57014",
          },
        },
      },
    });
    const result = await createClientFromOnboarding({
      ...INPUT,
      name: "Edited Name",
      idempotencyKey: KEY,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "We couldn’t save this client’s details. Check your connection and try again.",
    });
    // No plan probing after a failed reconciliation — the row's state is
    // unknown, so nothing further is touched.
    expect(fake.selects.map((s) => s.table)).toEqual(["clients"]);
    expect(fake.deletes).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toBe(
      "[plan-write-failure] stage=replay_update code=57014"
    );
  });

  it("supersede failure after a vertical edit: honest planWarning + telemetry; plans delete never attempted", async () => {
    const fake = setup({
      clients: {
        insert: COLLIDE,
        select: { data: KEYED_CLIENT_ROW },
        update: { data: { ...KEYED_CLIENT_ROW, vertical: "restaurants" } },
      },
      plans: { select: { data: [{ id: "old-plan" }] } },
      tasks: { delete: { error: { message: "permission denied", code: "42501" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({
        ...INPUT,
        vertical: "restaurants",
        idempotencyKey: KEY,
      })
    );
    // The client update stands; the plan state is reported honestly.
    expect(result.client.vertical).toBe("restaurants");
    expect(result.plan).toBeNull();
    expect(result.planWarning).toBe(PLAN_WARNING);
    expect(fake.deletes).toEqual([
      {
        table: "tasks",
        filters: {
          tenant_id: "tenant-1",
          client_id: KEY,
          plan_id: ["old-plan"],
        },
      },
    ]);
    expect(consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "[plan-write-failure] stage=replay_tasks_delete code=42501",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* redacted plan-write telemetry (ticket d — full matrix in plans/)    */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — plan-write telemetry is redacted (ticket d)", () => {
  it("a plan insert failure logs ONE line: marker + stage + code, nothing else", async () => {
    setup({
      clients: { insert: { data: SAVED_CLIENT_ROW } },
      plans: {
        insert: {
          error: {
            message: `duplicate key … (${SAVED_CLIENT_ROW.name}, tenant-1, SECRET)`,
            details: "Failing row contains user data",
            code: "23505",
          },
        },
      },
    });
    okResult(await createClientFromOnboarding(INPUT));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const line = consoleErrorSpy.mock.calls[0][0] as string;
    expect(line).toBe("[plan-write-failure] stage=plan_insert code=23505");
    for (const forbidden of [
      SAVED_CLIENT_ROW.name,
      "tenant-1",
      "SECRET",
      "Failing row",
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ */
/* website property (this batch): persist on the fresh path, RECONCILE  */
/* on replay (the ratified idempotency must cover the property row).     */
/* ------------------------------------------------------------------ */

describe("createClientFromOnboarding — website property persistence + replay coverage", () => {
  const WEBSITE = { url: "https://gableandgrove.com", platform: "wordpress" as const };

  it("FRESH: persists the website (connection_method 'none', NEVER auth_ref, claim-sourced tenant)", async () => {
    const fake = setup({
      ...HAPPY_SCRIPT,
      properties: { select: { data: [] }, insert: { data: { id: "prop-1" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, website: WEBSITE })
    );
    expect(result.property).toEqual({ id: "prop-1", url: WEBSITE.url, platform: "wordpress" });
    const values = fake.inserts.find((i) => i.table === "properties")!.values as Record<string, unknown>;
    expect(values).toMatchObject({
      tenant_id: "tenant-1",
      client_id: "client-1",
      type: "website",
      platform: "wordpress",
      url: WEBSITE.url,
      connection_method: "none",
    });
    expect("auth_ref" in values).toBe(false);
  });

  it("an incomplete website (url, no platform) saves the client with a propertyWarning — never fails onboarding", async () => {
    const fake = setup(HAPPY_SCRIPT);
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, website: { url: "https://gableandgrove.com", platform: "" } })
    );
    expect(result.property).toBeNull();
    expect(typeof result.propertyWarning).toBe("string");
    // No property query was attempted for an unpersistable website.
    expect(fake.inserts.some((i) => i.table === "properties")).toBe(false);
  });

  it("a website insert failure keeps the client saved and surfaces a propertyWarning (soft)", async () => {
    setup({
      ...HAPPY_SCRIPT,
      properties: { select: { data: [] }, insert: { error: { message: "boom", code: "23505" } } },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, website: WEBSITE })
    );
    expect(result.client.id).toBe("client-1");
    expect(result.property).toBeNull();
    expect(typeof result.propertyWarning).toBe("string");
  });

  it("REPLAY: a lost-response retry UPDATES-THROUGH a diverged property URL — never strands a stale one", async () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS["real-estate"],
      now: "2026-07-09T00:00:00.000Z",
    });
    const fake = setup({
      clients: {
        insert: { error: { message: "duplicate key", code: "23505" } },
        select: { data: KEYED_CLIENT_ROW }, // identical client payload → world 1
      },
      plans: {
        select: {
          data: [{ id: "plan-1", playbook_version: roadmap.playbookVersion, generated_roadmap: roadmap }],
        },
      },
      tasks: { select: { data: [{ plan_id: "plan-1" }] } },
      // The first attempt persisted the OLD url; the replay carries a new one.
      properties: {
        select: { data: [{ id: "prop-1", url: "https://old.com", platform: "wix" }] },
        update: { data: { id: "prop-1" } },
      },
    });
    const result = okResult(
      await createClientFromOnboarding({ ...INPUT, idempotencyKey: KEY, website: WEBSITE })
    );
    // The property was reconciled to the resubmitted values, not stranded.
    expect(result.property).toEqual({ id: "prop-1", url: WEBSITE.url, platform: "wordpress" });
    const propUpdate = fake.updates.find((u) => u.table === "properties");
    expect(propUpdate?.values).toEqual({ url: WEBSITE.url, platform: "wordpress" });
    expect(propUpdate?.filters).toEqual({ tenant_id: "tenant-1", id: "prop-1" });
  });
});
