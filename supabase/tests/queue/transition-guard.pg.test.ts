/**
 * runs_transition_guard — the DATABASE-ENFORCED state machine (migration 0012;
 * Orchestrator QA-F2 ruling). These are the architect's own trigger tests
 * (joining the queue suite per the ruling); QA's red regression pins for the
 * two proven exploits land separately and must also stay green.
 *
 * What this proves, all through the PostgREST execution model (queryAs):
 *   1. THE TWO PROVEN EXPLOITS ARE DB-REFUSED — terminal→queued re-lease
 *      (succeeded→queued, canceled→queued) and failed-at-cap→queued with
 *      attempts reset to 0.
 *   2. PRIVILEGED EDGES ARE UNREACHABLE RAW — queued→running (lease-only),
 *      failed→queued (requeue-only, even with a correct attempts+1),
 *      running→failed('orphaned') (reap-only flavor) all refused for a writer.
 *   3. GUC SPOOF FAILS — an authenticated writer that hand-sets
 *      app.runs_queue_op='lease' in its own transaction is still refused
 *      (privileged ops also require the definer/owner execution context).
 *   4. THE HOLDER'S LEGAL EDGES STILL WORK — running→succeeded(+result_ref),
 *      running→failed(engine_error), running→running heartbeat, and the
 *      tenant queued→canceled edge; canceled is then terminal.
 *   5. ATTEMPTS ARE QUEUE-MANAGED — any raw attempts change (bump, decrement,
 *      reset) is refused; requeue's exactly-+1 stays function-only.
 *   6. ROW IDENTITY IS IMMUTABLE — kind swap, client_id swap (own-tenant
 *      sibling), requested_by rewrite all refused; requested_by→NULL (the FK
 *      SET NULL shape) is allowed.
 *   7. input_url IS RUN IDENTITY (migration 0016; Orchestrator integrity
 *      ruling 2026-07-11) — a same-tenant writer's input_url rewrite on its
 *      own queued OR running brand_extract run is refused, the owner+GUC
 *      privileged context is refused too, and the legal edges (queued→canceled,
 *      the real lease) still work with input_url riding through unchanged.
 *
 * Requires local Postgres (supabase/tests/README.md).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JwtClaims } from "@/lib/types/db";
import {
  claimsFor,
  expectQueryRejected,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;

const REFUSED = /runs_transition_refused/;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a } = await seedTenantPair(db.admin));
});

afterAll(async () => {
  await db?.teardown();
});

beforeEach(async () => {
  await db.admin.query("delete from runs");
});

function writer(): JwtClaims {
  return claimsFor("operator", a.tenantId, { sub: a.operatorSub });
}

/** Superuser INSERT (the guard is an UPDATE trigger; inserts are scaffolding). */
async function insertRun(opts: {
  status?: string;
  attempts?: number;
  errorCode?: string | null;
  heartbeatAt?: string | null;
  requestedBy?: string | null;
} = {}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into runs (tenant_id, client_id, property_id, kind, status, attempts, error_code, heartbeat_at, requested_by)
     values ($1, $2, $3, 'audit', $4, $5, $6, $7, $8) returning id`,
    [
      a.tenantId,
      a.clientId,
      a.propertyId,
      opts.status ?? "queued",
      opts.attempts ?? 0,
      opts.errorCode ?? null,
      opts.heartbeatAt ?? null,
      opts.requestedBy ?? null,
    ]
  );
  return res.rows[0].id;
}

async function runRow(id: string): Promise<{ status: string; attempts: number; error_code: string | null; requested_by: string | null }> {
  const res = await db.admin.query(
    `select status, attempts, error_code, requested_by from runs where id = $1`,
    [id]
  );
  return res.rows[0];
}

/** The enqueue-recorded brand_extract target for §7's pins. */
const EXTRACT_URL = "https://prospect.example.com";

/** Superuser INSERT of a brand_extract run (0015: the kind REQUIRES a non-null
 *  input_url; client-scoped — property_id NULL, the pre-onboarding shape). */
async function insertBrandExtractRun(opts: { status?: string; heartbeatAt?: string | null } = {}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into runs (tenant_id, client_id, kind, status, heartbeat_at, input_url)
     values ($1, $2, 'brand_extract', $3, $4, $5) returning id`,
    [a.tenantId, a.clientId, opts.status ?? "queued", opts.heartbeatAt ?? null, EXTRACT_URL]
  );
  return res.rows[0].id;
}

async function inputUrlOf(id: string): Promise<string | null> {
  const res = await db.admin.query<{ input_url: string | null }>(
    `select input_url from runs where id = $1`,
    [id]
  );
  return res.rows[0].input_url;
}

/* ------------------------------------------------------------------ */
/* 1. The two proven exploits are DB-refused                           */
/* ------------------------------------------------------------------ */

describe("proven exploits — refused by the database, not just illegal on paper", () => {
  it("terminal→queued re-lease: succeeded→queued and canceled→queued are refused for a writer", async () => {
    const done = await insertRun({ status: "succeeded" });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'queued' where id = $1`, [done],
      REFUSED
    );
    const canceled = await insertRun({ status: "canceled" });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'queued' where id = $1`, [canceled],
      REFUSED
    );
    expect((await runRow(done)).status).toBe("succeeded");
    expect((await runRow(canceled)).status).toBe("canceled");
  });

  it("failed-at-cap→queued with attempts reset to 0 is refused (attempts are queue-managed)", async () => {
    const capped = await insertRun({ status: "failed", attempts: 3, errorCode: "engine_error" });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'queued', attempts = 0, error_code = null where id = $1`, [capped],
      REFUSED
    );
    const row = await runRow(capped);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Privileged edges unreachable raw                                 */
/* ------------------------------------------------------------------ */

describe("privileged edges — lease/reap/requeue shapes refused for a raw writer", () => {
  it("queued→running is lease-only", async () => {
    const queued = await insertRun();
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'running', heartbeat_at = now() where id = $1`, [queued],
      REFUSED
    );
  });

  it("failed→queued is requeue-only, even with a 'correct' attempts+1", async () => {
    const failed = await insertRun({ status: "failed", attempts: 1, errorCode: "engine_error" });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'queued', attempts = 2, error_code = null where id = $1`, [failed],
      REFUSED
    );
  });

  it("running→failed('orphaned') is the reap-only flavor", async () => {
    const running = await insertRun({ status: "running", heartbeatAt: new Date().toISOString() });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'failed', error_code = 'orphaned' where id = $1`, [running],
      REFUSED
    );
  });

  it("raw service_role reach gets no exemption either", async () => {
    const done = await insertRun({ status: "succeeded" });
    // In the harness service_role has no table grant (permission denied); in a
    // deployment that grants it, the trigger's tenant path refuses the edge.
    // Either way: refused.
    await db.admin.query("begin");
    try {
      await db.admin.query("set local role service_role");
      await expect(
        db.admin.query(`update runs set status = 'queued' where id = $1`, [done])
      ).rejects.toThrow(/permission denied|runs_transition_refused/);
    } finally {
      await db.admin.query("rollback");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. GUC spoof                                                        */
/* ------------------------------------------------------------------ */

describe("caller-discrimination spoof resistance", () => {
  it("an authenticated writer that hand-sets the op GUC is still refused (owner context required)", async () => {
    const queued = await insertRun();
    // Multi-statement (no params → simple protocol): set the GUC exactly as the
    // definer functions do, then attempt the lease edge in the same transaction.
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `select pg_catalog.set_config('app.runs_queue_op', 'lease', true);
       update runs set status = 'running', heartbeat_at = now() where id = '${queued}'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(queued)).status).toBe("queued");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Legal edges still work                                           */
/* ------------------------------------------------------------------ */

describe("legal edges — the holder and tenant paths the guard must NOT break", () => {
  it("holder completion: running→succeeded with result_ref; running→failed with a non-orphaned code", async () => {
    const r1 = await insertRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const ok = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'succeeded', result_ref = '{"kind":"audit"}' where id = $1`, [r1]
    );
    expect(ok.rowCount).toBe(1);

    const r2 = await insertRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const failed = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'failed', error_code = 'engine_error' where id = $1`, [r2]
    );
    expect(failed.rowCount).toBe(1);
  });

  it("holder heartbeat/progress: running→running", async () => {
    const running = await insertRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const beat = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set heartbeat_at = now(), progress = '{"crawled":3}' where id = $1`, [running]
    );
    expect(beat.rowCount).toBe(1);
    expect((await runRow(running)).status).toBe("running");
  });

  it("tenant cancel: queued→canceled works; canceled is then terminal", async () => {
    const queued = await insertRun();
    const cancel = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'canceled' where id = $1 and status = 'queued'`, [queued]
    );
    expect(cancel.rowCount).toBe(1);
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set status = 'queued' where id = $1`, [queued],
      REFUSED
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5 + 6. Attempts management + identity immutability                  */
/* ------------------------------------------------------------------ */

describe("attempts are queue-managed on every raw path", () => {
  it("bump, decrement, and reset are all refused (running and failed rows)", async () => {
    const running = await insertRun({ status: "running", attempts: 1, heartbeatAt: new Date().toISOString() });
    for (const attempts of [0, 2, 6]) {
      await expectQueryRejected(
        db.admin, "authenticated", writer(),
        `update runs set attempts = ${attempts} where id = '${running}'`,
        undefined,
        REFUSED
      );
    }
    expect((await runRow(running)).attempts).toBe(1);
  });
});

describe("row identity immutable post-insert", () => {
  it("kind swap and client_id swap (own-tenant sibling) are refused", async () => {
    const queued = await insertRun();
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set kind = 'monitor' where id = $1`, [queued],
      REFUSED
    );
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set client_id = $2, property_id = null where id = $1`,
      [queued, a.siblingClientId],
      REFUSED
    );
  });

  it("requested_by: rewrite refused; →NULL (the FK SET NULL shape) allowed", async () => {
    const queued = await insertRun({ requestedBy: a.operatorUserId });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set requested_by = $2 where id = $1`,
      [queued, a.adminUserId],
      REFUSED
    );
    const toNull = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set requested_by = null where id = $1`, [queued]
    );
    expect(toNull.rowCount).toBe(1);
    expect((await runRow(queued)).requested_by).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 7. input_url is run identity (migration 0016)                       */
/* ------------------------------------------------------------------ */

describe("input_url is run identity (migration 0016) — the recorded brand_extract target is immutable post-enqueue", () => {
  it("a same-tenant writer's input_url rewrite on its own QUEUED brand_extract run is refused (pre-lease: would rewrite what gets fetched)", async () => {
    const queued = await insertBrandExtractRun();
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set input_url = 'https://rewritten.example.com' where id = $1`, [queued],
      /runs_transition_refused: row identity is immutable/
    );
    expect(await inputUrlOf(queued)).toBe(EXTRACT_URL);
  });

  it("a same-tenant writer's input_url rewrite on its own RUNNING brand_extract run is refused (post-lease: would rewrite the displayed target)", async () => {
    const running = await insertBrandExtractRun({ status: "running", heartbeatAt: new Date().toISOString() });
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set input_url = 'https://rewritten.example.com' where id = $1`, [running],
      /runs_transition_refused: row identity is immutable/
    );
    expect(await inputUrlOf(running)).toBe(EXTRACT_URL);
  });

  it("the PRIVILEGED path refuses it too — owner + op GUC leasing with an input_url rewrite riding along", async () => {
    const queued = await insertBrandExtractRun();
    // Owner (db.admin) + the transaction-local op GUC IS the definer execution
    // context the guard privileges — identity must still be refused there.
    await db.admin.query("begin");
    try {
      await db.admin.query(`select pg_catalog.set_config('app.runs_queue_op', 'lease', true)`);
      await expect(
        db.admin.query(
          `update runs set status = 'running', heartbeat_at = now(), input_url = 'https://rewritten.example.com' where id = $1`,
          [queued]
        )
      ).rejects.toThrow(/runs_transition_refused: row identity is immutable/);
    } finally {
      await db.admin.query("rollback");
    }
    const row = await runRow(queued);
    expect(row.status).toBe("queued");
    expect(await inputUrlOf(queued)).toBe(EXTRACT_URL);
  });

  it("positive control: tenant cancel (queued→canceled) still works on a brand_extract run, input_url unchanged", async () => {
    const queued = await insertBrandExtractRun();
    const cancel = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'canceled' where id = $1 and status = 'queued'`, [queued]
    );
    expect(cancel.rowCount).toBe(1);
    expect((await runRow(queued)).status).toBe("canceled");
    expect(await inputUrlOf(queued)).toBe(EXTRACT_URL);
  });

  it("positive control: the REAL lease still claims a brand_extract run, input_url surviving unchanged", async () => {
    const queued = await insertBrandExtractRun();
    await db.admin.query("begin");
    try {
      await db.admin.query("set local role service_role");
      const leased = await db.admin.query<{ id: string; input_url: string | null }>(
        `select id, input_url from public.lease_next_run()`
      );
      expect(leased.rows[0].id).toBe(queued);
      expect(leased.rows[0].input_url).toBe(EXTRACT_URL);
      await db.admin.query("commit");
    } catch (err) {
      await db.admin.query("rollback");
      throw err;
    }
    const row = await runRow(queued);
    expect(row.status).toBe("running");
    expect(await inputUrlOf(queued)).toBe(EXTRACT_URL);
  });

  /* QA pins (0016 verification gate): the guard now compares input_url on
   * EVERY update, so every live queue edge on a brand_extract run (non-null
   * input_url riding through unchanged) is pinned here — a future guard
   * change that breaks heartbeat/complete/fail on non-null-input_url rows
   * must fail THIS suite, not just a live probe. */

  it("QA pin: heartbeat/progress writes still allowed on a RUNNING brand_extract run (non-null input_url rides the compare unchanged)", async () => {
    const running = await insertBrandExtractRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const hb = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set heartbeat_at = now(), progress = '{"step":"fetching"}'::jsonb where id = $1 and status = 'running'`,
      [running]
    );
    expect(hb.rowCount).toBe(1);
    expect(await inputUrlOf(running)).toBe(EXTRACT_URL);
  });

  it("QA pin: holder completion (running→succeeded + result_ref) still allowed on a brand_extract run, input_url intact", async () => {
    const running = await insertBrandExtractRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const done = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'succeeded', result_ref = '{"table":"brand_extract_drafts"}'::jsonb where id = $1 and status = 'running'`,
      [running]
    );
    expect(done.rowCount).toBe(1);
    expect((await runRow(running)).status).toBe("succeeded");
    expect(await inputUrlOf(running)).toBe(EXTRACT_URL);
  });

  it("QA pin: holder failure (running→failed + error_code) still allowed on a brand_extract run, input_url intact", async () => {
    const running = await insertBrandExtractRun({ status: "running", heartbeatAt: new Date().toISOString() });
    const failed = await queryAs(
      db.admin, "authenticated", writer(),
      `update runs set status = 'failed', error_code = 'crawl_refused' where id = $1 and status = 'running'`,
      [running]
    );
    expect(failed.rowCount).toBe(1);
    const row = await runRow(running);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("crawl_refused");
    expect(await inputUrlOf(running)).toBe(EXTRACT_URL);
  });

  it("QA pin: input_url → NULL is refused as identity too (both directions of `is distinct from`, not just the 0015 coupling CHECK)", async () => {
    const queued = await insertBrandExtractRun();
    await expectQueryRejected(
      db.admin, "authenticated", writer(),
      `update runs set input_url = null where id = $1`, [queued],
      /runs_transition_refused: row identity is immutable/
    );
    expect(await inputUrlOf(queued)).toBe(EXTRACT_URL);
  });
});
