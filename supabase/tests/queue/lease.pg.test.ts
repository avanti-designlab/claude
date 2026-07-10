/**
 * Run-queue infra — ADVERSARIAL concurrency/recovery + EXECUTE-lockdown suite
 * on the live-PG isolation harness (migration 0012; ARCHITECTURE RULING A8:
 * "Code Review + a QA adversarial concurrency/recovery suite ... the 1.2
 * precedent"). Proves the properties that can never fail silently:
 *
 *   1. EXECUTE LOCKDOWN (A1) — ONLY service_role may call lease_next_run /
 *      reap_orphaned_runs / requeue_failed_runs; authenticated (any writer
 *      claims) and anon are DENIED. The cross-tenant queue surface is
 *      unreachable from the tenant-facing API.
 *   2. LEASE SEMANTICS — the globally-oldest queued run is claimed, flipped
 *      queued→running, heartbeat stamped; leasing drains oldest-first ACROSS
 *      tenants; an empty queue returns NULL. Only queued rows are ever leased.
 *   3. DOUBLE-LEASE IMPOSSIBILITY under real concurrency — two overlapping
 *      lease transactions on the ONE queued run: exactly one wins (FOR UPDATE
 *      SKIP LOCKED), the other gets NULL. No run is ever leased twice.
 *   4. CRASH-MID-RUN ORPHAN DETECTION — a running run with a stale (or null)
 *      heartbeat is reaped to failed/'orphaned'; a fresh-heartbeat running run
 *      is untouched. State is never stuck-running.
 *   5. RETRY CAP + BACKOFF — a failed run under the cap and past its backoff
 *      re-queues (attempts+1, error_code cleared); one AT the cap does not; one
 *      still inside its backoff window does not.
 *
 * Requires local Postgres (supabase/tests/README.md).
 */

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimsFor, expectQueryRejected, setupIsolationDb, type IsolationDb } from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
});

afterAll(async () => {
  await db?.teardown();
});

/**
 * Lease via a MATERIALIZED CTE so the side-effecting function runs EXACTLY ONCE
 * and its composite result is expanded into readable columns (node-pg returns a
 * bare composite column as a string, and `(lease_next_run()).*` would re-invoke
 * the function per column — both avoided here). `id` is NULL on an empty queue.
 */
const LEASE_SQL = `
  with leased as materialized (select public.lease_next_run() as r)
  select (r).id as id, (r).status as status, (r).heartbeat_at as heartbeat_at, (r).attempts as attempts
  from leased`;

interface LeasedRow {
  id: string | null;
  status: string | null;
  heartbeat_at: Date | null;
  attempts: number | null;
}

/** Run a statement AS service_role (the processor's lease/sweep identity). */
async function asServiceRole<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  text: string,
  params?: unknown[]
): Promise<T[]> {
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const res = await client.query<T>(text, params);
    await client.query("commit");
    return res.rows;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Insert a run in an arbitrary state (superuser bypasses RLS + the CHECKs that
 *  the app enforces on the transition path — we need failed/running rows the
 *  app would only reach via the queue). */
async function insertRun(
  t: SeededTenant,
  opts: {
    status?: string;
    attempts?: number;
    errorCode?: string | null;
    heartbeatAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } = {}
): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into runs
       (tenant_id, client_id, property_id, kind, status, attempts, error_code, heartbeat_at, created_at, updated_at)
     values ($1,$2,$3,'audit',$4,$5,$6,$7, coalesce($8, now()), coalesce($9, now()))
     returning id`,
    [
      t.tenantId,
      t.clientId,
      t.propertyId,
      opts.status ?? "queued",
      opts.attempts ?? 0,
      opts.errorCode ?? null,
      opts.heartbeatAt ?? null,
      opts.createdAt ?? null,
      opts.updatedAt ?? null,
    ]
  );
  return res.rows[0].id;
}

async function runRow(id: string): Promise<{ status: string; attempts: number; error_code: string | null; heartbeat_at: string | null }> {
  const res = await db.admin.query(
    `select status, attempts, error_code, heartbeat_at from runs where id = $1`,
    [id]
  );
  return res.rows[0];
}

beforeEach(async () => {
  // Each test owns the whole queue — clear it (superuser bypasses RLS).
  await db.admin.query("delete from runs");
});

/* ------------------------------------------------------------------ */
/* 1. EXECUTE lockdown (A1)                                            */
/* ------------------------------------------------------------------ */

describe("EXECUTE lockdown — only service_role may call the queue functions", () => {
  it("authenticated (operator writer claims) CANNOT call lease_next_run", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("operator", a.tenantId, { sub: a.operatorSub }),
      "select public.lease_next_run()",
      undefined,
      /permission denied for function lease_next_run/i
    );
  });

  it("authenticated (agency_admin) CANNOT call the sweep functions", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("agency_admin", a.tenantId, { sub: a.adminSub }),
      "select public.reap_orphaned_runs(now())",
      undefined,
      /permission denied for function reap_orphaned_runs/i
    );
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsFor("agency_admin", a.tenantId, { sub: a.adminSub }),
      "select public.requeue_failed_runs(3, '30 seconds', '5 minutes')",
      undefined,
      /permission denied for function requeue_failed_runs/i
    );
  });

  it("anon CANNOT call lease_next_run", async () => {
    await expectQueryRejected(
      db.admin,
      "anon",
      null,
      "select public.lease_next_run()",
      undefined,
      /permission denied for function lease_next_run/i
    );
  });

  it("service_role CAN call lease_next_run (returns NULL on empty queue)", async () => {
    const rows = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);
    expect(rows[0].id).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2. Lease semantics                                                 */
/* ------------------------------------------------------------------ */

describe("lease semantics", () => {
  it("claims the globally-oldest queued run, flips it running + stamps heartbeat", async () => {
    const older = await insertRun(a, { createdAt: "2026-01-01T00:00:00Z" });
    await insertRun(a, { createdAt: "2026-01-02T00:00:00Z" });

    const rows = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);
    expect(rows[0].id).toBe(older);
    expect(rows[0].status).toBe("running");
    expect(rows[0].heartbeat_at).not.toBeNull();

    const persisted = await runRow(older);
    expect(persisted.status).toBe("running");
    expect(persisted.heartbeat_at).not.toBeNull();
  });

  it("drains oldest-first ACROSS tenants, then returns NULL", async () => {
    const aOld = await insertRun(a, { createdAt: "2026-01-01T00:00:00Z" });
    const bMid = await insertRun(b, { createdAt: "2026-01-02T00:00:00Z" });

    const l1 = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);
    const l2 = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);
    const l3 = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);

    expect(l1[0].id).toBe(aOld); // tenant A's older run first
    expect(l2[0].id).toBe(bMid); // then tenant B's — cross-tenant lease
    expect(l3[0].id).toBeNull(); // queue drained
  });

  it("never leases a non-queued row", async () => {
    await insertRun(a, { status: "running", heartbeatAt: new Date().toISOString() });
    await insertRun(a, { status: "succeeded" });
    await insertRun(a, { status: "failed", errorCode: "engine_error" });
    const rows = await asServiceRole<LeasedRow>(db.admin, LEASE_SQL);
    expect(rows[0].id).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Double-lease impossibility under concurrency                    */
/* ------------------------------------------------------------------ */

describe("double-lease impossibility (FOR UPDATE SKIP LOCKED, two connections)", () => {
  it("two overlapping leases on ONE queued run: exactly one wins", async () => {
    const only = await insertRun(a, { createdAt: "2026-01-01T00:00:00Z" });

    const c1 = new Client({ connectionString: db.url });
    const c2 = new Client({ connectionString: db.url });
    await c1.connect();
    await c2.connect();
    try {
      // c1 leases and HOLDS its transaction open (row locked + flipped running,
      // uncommitted) — the crash-window a peer processor could double-lease in.
      await c1.query("begin");
      await c1.query("set local role service_role");
      const r1 = await c1.query<LeasedRow>(LEASE_SQL);

      // c2 leases concurrently while c1 holds the lock: SKIP LOCKED skips the
      // locked row → with no other queued row, it gets NULL.
      await c2.query("begin");
      await c2.query("set local role service_role");
      const r2 = await c2.query<LeasedRow>(LEASE_SQL);

      await c1.query("commit");
      await c2.query("commit");

      const got = [r1.rows[0].id, r2.rows[0].id];
      const winners = got.filter((id) => id !== null);
      const losers = got.filter((id) => id === null);
      expect(winners).toHaveLength(1); // exactly one lease succeeded
      expect(losers).toHaveLength(1); // the other saw the row locked → NULL
      expect(winners[0]).toBe(only);

      const persisted = await runRow(only);
      expect(persisted.status).toBe("running");
      expect(persisted.attempts).toBe(0); // leased exactly once, never twice
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Crash-mid-run orphan detection                                  */
/* ------------------------------------------------------------------ */

describe("orphan reaping (crash-mid-run recovery)", () => {
  it("reaps stale/null-heartbeat running runs; spares fresh ones", async () => {
    const now = Date.now();
    const stale = await insertRun(a, {
      status: "running",
      heartbeatAt: new Date(now - 200_000).toISOString(), // 200s ago — stale
    });
    const nullBeat = await insertRun(a, { status: "running", heartbeatAt: null });
    const fresh = await insertRun(b, {
      status: "running",
      heartbeatAt: new Date(now - 5_000).toISOString(), // 5s ago — alive
    });

    const cutoff = new Date(now - 120_000).toISOString(); // maxDuration+60s ago
    const reaped = await asServiceRole<{ id: string }>(
      db.admin,
      "select public.reap_orphaned_runs($1::timestamptz) as id",
      [cutoff]
    );
    const reapedIds = reaped.map((r) => r.id);
    expect(reapedIds).toContain(stale);
    expect(reapedIds).toContain(nullBeat);
    expect(reapedIds).not.toContain(fresh);

    expect((await runRow(stale)).status).toBe("failed");
    expect((await runRow(stale)).error_code).toBe("orphaned");
    expect((await runRow(nullBeat)).error_code).toBe("orphaned");
    expect((await runRow(fresh)).status).toBe("running"); // untouched
  });
});

/* ------------------------------------------------------------------ */
/* 5. Retry cap + backoff                                             */
/* ------------------------------------------------------------------ */

describe("requeue: attempt cap + capped backoff", () => {
  it("re-queues a failed run under cap and past backoff (attempts+1, error cleared)", async () => {
    const failed = await insertRun(a, {
      status: "failed",
      attempts: 0,
      errorCode: "engine_error",
      updatedAt: new Date(Date.now() - 600_000).toISOString(), // 10m in failed
    });
    const requeued = await asServiceRole<{ id: string }>(
      db.admin,
      "select public.requeue_failed_runs(3, '30 seconds', '5 minutes') as id"
    );
    expect(requeued.map((r) => r.id)).toContain(failed);
    const row = await runRow(failed);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error_code).toBeNull(); // a queued row may carry NO error_code
  });

  it("does NOT re-queue a run AT the attempt cap", async () => {
    const capped = await insertRun(a, {
      status: "failed",
      attempts: 3, // == cap
      errorCode: "engine_error",
      updatedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const requeued = await asServiceRole<{ id: string }>(
      db.admin,
      "select public.requeue_failed_runs(3, '30 seconds', '5 minutes') as id"
    );
    expect(requeued.map((r) => r.id)).not.toContain(capped);
    expect((await runRow(capped)).status).toBe("failed"); // stays honestly failed
  });

  it("does NOT re-queue a run still inside its backoff window", async () => {
    const young = await insertRun(a, {
      status: "failed",
      attempts: 0,
      errorCode: "engine_error",
      updatedAt: new Date().toISOString(), // just failed — backoff not elapsed
    });
    const requeued = await asServiceRole<{ id: string }>(
      db.admin,
      "select public.requeue_failed_runs(3, '30 seconds', '5 minutes') as id"
    );
    expect(requeued.map((r) => r.id)).not.toContain(young);
    expect((await runRow(young)).status).toBe("failed");
  });
});
