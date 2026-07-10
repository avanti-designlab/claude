/**
 * QA ADVERSARIAL concurrency/recovery suite — the A8 gate's independent proof
 * (BUILD-STATE 2026-07-10 ARCHITECTURE RULING, amendment A8: "queue/lease/
 * processor/sweeper = Code Review + QA adversarial concurrency/recovery suite").
 *
 * The architect's suite (lease.pg.test.ts) proves the deterministic-interleaving
 * cases. THIS file is the QA-owned adversarial layer that closes the ruling's
 * named proof obligations the architect's suite does not reach:
 *
 *   1. GENUINE RACES — M processors × N runs leasing in PARALLEL (separate
 *      connections, overlapping in-flight statements, repeated iterations):
 *      every run leased EXACTLY once, none twice, none missed.
 *   2. ORPHAN-REAP BOUNDARY — heartbeat exactly AT the cutoff, 1ms inside, 1ms
 *      outside, and null: pins reap_orphaned_runs' strict `<` semantics so a
 *      healthy run is NEVER reaped and the threshold cannot silently drift.
 *   3. KICK-FAILURE → RECOVERY, traced END-TO-END on the live DB — including
 *      the honest negative: the two sweep functions alone do NOT touch a stale
 *      QUEUED row (recovery of a dropped kick requires a processor poke/lease).
 *   4. RETRY-CAP EXHAUSTION as a LIFECYCLE — a run fails, retries to the cap
 *      through real lease→fail→requeue cycles, then stays failed FOREVER under
 *      repeated sweeping (cap+1 executions total; nothing in the queue infra
 *      resurrects it).
 *   5. TRANSITION LEGALITY of the three functions probed RAW — lease never
 *      touches non-queued (incl. canceled), reap never touches non-running even
 *      with a null heartbeat and a future cutoff, requeue never touches
 *      non-failed. Every illegal edge is unreachable THROUGH THE FUNCTIONS.
 *   6. MINTED-JWT TENANT ISOLATION (A1) — the per-run token's REAL claims
 *      (decoded from mintRunJwt output, not hand-copied) behave exactly like an
 *      operator of the run's tenant at the RLS layer: tenant B is invisible and
 *      unwritable; the minted context cannot call the queue functions.
 *   7. EXECUTE-LOCKDOWN COMPLETION + TRIPWIRE — client_viewer / platform_owner
 *      claims and anon denied on ALL THREE functions, plus a catalog tripwire:
 *      NO function in the PostgREST-exposed `public` schema is executable by
 *      authenticated/anon — so a future function added without a lockdown
 *      review fails this suite by default.
 *
 * Requires local Postgres (supabase/tests/README.md).
 */

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ORPHAN_STALE_MS,
  orphanCutoffIso,
  RETRY_ATTEMPT_CAP,
  RETRY_BASE_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
} from "@/lib/runs/config";
import { mintRunJwt } from "@/lib/runs/mint";
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
let b: SeededTenant;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
});

afterAll(async () => {
  await db?.teardown();
});

beforeEach(async () => {
  await db.admin.query("delete from runs");
});

/** Same materialized-CTE lease used by the architect's suite: the
 *  side-effecting function runs exactly once, composite expanded to columns. */
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

/** One statement as service_role on the shared admin connection. */
async function asServiceRole<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  await db.admin.query("begin");
  try {
    await db.admin.query("set local role service_role");
    const res = await db.admin.query<T>(text, params);
    await db.admin.query("commit");
    return res.rows;
  } catch (err) {
    await db.admin.query("rollback");
    throw err;
  }
}

/** reap + requeue exactly as the production sweeper drives them (sweep.ts order,
 *  live.ts param marshaling, config.ts values). */
async function sweepWithProductionConfig(): Promise<{ reaped: string[]; requeued: string[] }> {
  const reaped = await asServiceRole<{ id: string }>(
    "select public.reap_orphaned_runs($1::timestamptz) as id",
    [orphanCutoffIso(Date.now())]
  );
  const requeued = await asServiceRole<{ id: string }>(
    "select public.requeue_failed_runs($1, $2::interval, $3::interval) as id",
    [RETRY_ATTEMPT_CAP, `${RETRY_BASE_BACKOFF_MS} milliseconds`, `${RETRY_MAX_BACKOFF_MS} milliseconds`]
  );
  return { reaped: reaped.map((r) => r.id), requeued: requeued.map((r) => r.id) };
}

/** requeue with an explicit backoff (still through the real function) — used by
 *  lifecycle tests to advance past the backoff window without clock games; the
 *  backoff-window math itself is pinned separately with production values. */
async function requeueWithBackoff(cap: number, backoff: string): Promise<string[]> {
  const rows = await asServiceRole<{ id: string }>(
    "select public.requeue_failed_runs($1, $2::interval, $3::interval) as id",
    [cap, backoff, backoff]
  );
  return rows.map((r) => r.id);
}

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

async function runRow(
  id: string
): Promise<{ status: string; attempts: number; error_code: string | null; heartbeat_at: Date | null }> {
  const res = await db.admin.query(
    `select status, attempts, error_code, heartbeat_at from runs where id = $1`,
    [id]
  );
  return res.rows[0];
}

/** The REAL minted per-run claims: mint the production JWT for the tenant and
 *  decode its payload — the exact claim set PostgREST would verify and expose. */
function mintedClaims(tenantId: string): Record<string, unknown> {
  const jwt = mintRunJwt({ tenantId, secret: "qa-suite-verification-secret" });
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

/* ------------------------------------------------------------------ */
/* 1. Genuine races — M processors × N runs                            */
/* ------------------------------------------------------------------ */

describe("double-lease impossibility under GENUINE concurrency (M connections in parallel)", () => {
  async function openServiceConnections(count: number): Promise<Client[]> {
    const clients = await Promise.all(
      Array.from({ length: count }, async () => {
        const c = new Client({ connectionString: db.url });
        await c.connect();
        await c.query("set role service_role"); // session-scoped, like the processor
        return c;
      })
    );
    return clients;
  }

  it("4 parallel processors × 12 queued runs × 3 iterations: every run leased EXACTLY once", async () => {
    const processors = await openServiceConnections(4);
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        await db.admin.query("delete from runs");
        const inserted: string[] = [];
        for (let i = 0; i < 12; i++) {
          inserted.push(
            await insertRun(i % 2 === 0 ? a : b, {
              createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
            })
          );
        }

        // All four connections drain the queue CONCURRENTLY — overlapping
        // in-flight lease statements, each autocommitted like a real RPC.
        const drained = await Promise.all(
          processors.map(async (c) => {
            const got: string[] = [];
            for (;;) {
              const res = await c.query<LeasedRow>(LEASE_SQL);
              const id = res.rows[0].id;
              if (id === null) return got; // empty (or fully in-flight) queue
              expect(res.rows[0].status).toBe("running");
              got.push(id);
            }
          })
        );

        const all = drained.flat();
        // No run leased twice (no duplicates) and no run missed (union = N).
        expect(all).toHaveLength(12);
        expect(new Set(all).size).toBe(12);
        expect([...all].sort()).toEqual([...inserted].sort());

        const persisted = await db.admin.query<{ status: string; attempts: number; heartbeat_at: Date | null }>(
          `select status, attempts, heartbeat_at from runs`
        );
        for (const row of persisted.rows) {
          expect(row.status).toBe("running");
          expect(row.attempts).toBe(0); // lease never touches attempts
          expect(row.heartbeat_at).not.toBeNull();
        }
      }
    } finally {
      await Promise.all(processors.map((c) => c.end()));
    }
  });

  it("4 processors racing for ONE run, 5 rounds: exactly one winner each round", async () => {
    const processors = await openServiceConnections(4);
    try {
      for (let round = 0; round < 5; round++) {
        await db.admin.query("delete from runs");
        const only = await insertRun(a);

        const results = await Promise.all(processors.map((c) => c.query<LeasedRow>(LEASE_SQL)));
        const winners = results.map((r) => r.rows[0].id).filter((id) => id !== null);

        expect(winners).toHaveLength(1);
        expect(winners[0]).toBe(only);
        const persisted = await runRow(only);
        expect(persisted.status).toBe("running");
        expect(persisted.attempts).toBe(0);
      }
    } finally {
      await Promise.all(processors.map((c) => c.end()));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Orphan-reap boundary                                             */
/* ------------------------------------------------------------------ */

describe("orphan-reap boundary (pins reap_orphaned_runs' strict `<` cutoff)", () => {
  it("exactly-at-cutoff is SPARED; 1ms older is reaped; 1ms newer is spared; null is reaped", async () => {
    const cutoffMs = Date.parse("2026-07-10T12:00:00.000Z");
    const atCutoff = await insertRun(a, {
      status: "running",
      heartbeatAt: new Date(cutoffMs).toISOString(),
    });
    const justOutside = await insertRun(a, {
      status: "running",
      heartbeatAt: new Date(cutoffMs - 1).toISOString(),
    });
    const justInside = await insertRun(b, {
      status: "running",
      heartbeatAt: new Date(cutoffMs + 1).toISOString(),
    });
    const nullBeat = await insertRun(b, { status: "running", heartbeatAt: null });

    const reaped = (
      await asServiceRole<{ id: string }>("select public.reap_orphaned_runs($1::timestamptz) as id", [
        new Date(cutoffMs).toISOString(),
      ])
    ).map((r) => r.id);

    expect(reaped).toContain(justOutside);
    expect(reaped).toContain(nullBeat);
    expect(reaped).not.toContain(atCutoff); // strict <: the boundary beat survives
    expect(reaped).not.toContain(justInside);

    expect((await runRow(atCutoff)).status).toBe("running");
    expect((await runRow(justInside)).status).toBe("running");
    expect((await runRow(justOutside)).status).toBe("failed");
    expect((await runRow(justOutside)).error_code).toBe("orphaned");
    expect((await runRow(nullBeat)).error_code).toBe("orphaned");
  });

  it("a heartbeat fresher than the production threshold is never reaped by the production sweep", async () => {
    // Last beat HEARTBEAT-cadence-recent (well inside maxDuration+60s).
    const healthy = await insertRun(a, {
      status: "running",
      heartbeatAt: new Date(Date.now() - 12_000).toISOString(),
    });
    const { reaped } = await sweepWithProductionConfig();
    expect(reaped).not.toContain(healthy);
    expect((await runRow(healthy)).status).toBe("running");
    // Sanity-tie to A6: the production threshold really is maxDuration+60s.
    expect(ORPHAN_STALE_MS).toBe(120_000);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Transition legality — the functions probed RAW                   */
/* ------------------------------------------------------------------ */

describe("transition legality: the three functions cannot express an illegal edge", () => {
  it("lease never touches a CANCELED run (completes the non-queued sweep)", async () => {
    await insertRun(a, { status: "canceled" });
    const rows = await asServiceRole<LeasedRow>(LEASE_SQL);
    expect(rows[0].id).toBeNull();
  });

  it("reap never touches queued/succeeded/failed/canceled — even with null heartbeats and a FUTURE cutoff", async () => {
    const queued = await insertRun(a, { status: "queued", heartbeatAt: null });
    const succeeded = await insertRun(a, { status: "succeeded", heartbeatAt: null });
    const failed = await insertRun(b, { status: "failed", errorCode: "engine_error", heartbeatAt: null });
    const canceled = await insertRun(b, { status: "canceled", heartbeatAt: null });

    const reaped = (
      await asServiceRole<{ id: string }>("select public.reap_orphaned_runs($1::timestamptz) as id", [
        new Date(Date.now() + 3_600_000).toISOString(), // everything is "stale" vs this
      ])
    ).map((r) => r.id);
    expect(reaped).toEqual([]);

    expect((await runRow(queued)).status).toBe("queued");
    expect((await runRow(succeeded)).status).toBe("succeeded");
    expect((await runRow(failed)).status).toBe("failed");
    expect((await runRow(canceled)).status).toBe("canceled");
  });

  it("requeue never touches queued/running/succeeded/canceled — even with zero backoff and ancient rows", async () => {
    const old = new Date(Date.now() - 86_400_000).toISOString();
    const queued = await insertRun(a, { status: "queued", updatedAt: old });
    const running = await insertRun(a, { status: "running", heartbeatAt: old, updatedAt: old });
    const succeeded = await insertRun(b, { status: "succeeded", updatedAt: old });
    const canceled = await insertRun(b, { status: "canceled", updatedAt: old });

    const requeued = await requeueWithBackoff(RETRY_ATTEMPT_CAP, "0 milliseconds");
    expect(requeued).toEqual([]);

    expect((await runRow(queued)).attempts).toBe(0);
    expect((await runRow(running)).status).toBe("running");
    expect((await runRow(succeeded)).status).toBe("succeeded");
    expect((await runRow(canceled)).status).toBe("canceled");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Backoff-window math with PRODUCTION values                       */
/* ------------------------------------------------------------------ */

describe("requeue backoff window (production config values)", () => {
  it("attempts=0: eligible once 30s in failed; not before", async () => {
    const past = await insertRun(a, {
      status: "failed",
      attempts: 0,
      errorCode: "engine_error",
      updatedAt: new Date(Date.now() - (RETRY_BASE_BACKOFF_MS + 1_000)).toISOString(),
    });
    const young = await insertRun(a, {
      status: "failed",
      attempts: 0,
      errorCode: "engine_error",
      updatedAt: new Date(Date.now() - (RETRY_BASE_BACKOFF_MS - 10_000)).toISOString(),
    });
    const { requeued } = await sweepWithProductionConfig();
    expect(requeued).toContain(past);
    expect(requeued).not.toContain(young);
    expect((await runRow(past)).status).toBe("queued");
    expect((await runRow(past)).attempts).toBe(1);
    expect((await runRow(past)).error_code).toBeNull();
    expect((await runRow(young)).status).toBe("failed");
  });

  it("backoff GROWS with attempts: a 45s-old failure requeues at attempts=0 but NOT at attempts=1 (window 60s)", async () => {
    const fortyFiveSecondsAgo = new Date(Date.now() - 45_000).toISOString();
    const firstFailure = await insertRun(a, {
      status: "failed",
      attempts: 0,
      errorCode: "engine_error",
      updatedAt: fortyFiveSecondsAgo,
    });
    const secondFailure = await insertRun(b, {
      status: "failed",
      attempts: 1,
      errorCode: "engine_error",
      updatedAt: fortyFiveSecondsAgo,
    });
    const { requeued } = await sweepWithProductionConfig();
    expect(requeued).toContain(firstFailure); // 45s >= 30s*1
    expect(requeued).not.toContain(secondFailure); // 45s < 30s*2
    expect((await runRow(secondFailure)).status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ */
/* 5. Retry-cap exhaustion as a LIFECYCLE                              */
/* ------------------------------------------------------------------ */

describe("retry-cap exhaustion — at the cap a run stays failed FOREVER", () => {
  it("full lifecycle: cap+1 executions (initial + 3 retries), then permanently failed under repeated sweeps", async () => {
    const runId = await insertRun(a, { status: "queued" });
    const claims = mintedClaims(a.tenantId);

    let executions = 0;
    for (;;) {
      const leased = await asServiceRole<LeasedRow>(LEASE_SQL);
      if (leased[0].id === null) break; // nothing runnable — the queue gave up
      expect(leased[0].id).toBe(runId); // the SAME row retries (never a new row)
      executions += 1;
      expect(executions).toBeLessThanOrEqual(RETRY_ATTEMPT_CAP + 2); // hard stop against livelock

      // The processor fails the run through the MINTED tenant-scoped context —
      // the same write path production uses (live.ts complete()).
      const res = await queryAs(
        db.admin,
        "authenticated",
        claims,
        `update runs set status = 'failed', error_code = 'engine_error' where id = $1`,
        [runId]
      );
      expect(res.rowCount).toBe(1);

      // Sweep with zero backoff: retry immediately if under the cap.
      await requeueWithBackoff(RETRY_ATTEMPT_CAP, "0 milliseconds");
    }

    // Initial execution + exactly RETRY_ATTEMPT_CAP retries.
    expect(executions).toBe(RETRY_ATTEMPT_CAP + 1);

    // AT the cap: repeated full sweep+lease cycles never resurrect it.
    for (let i = 0; i < 5; i++) {
      const { reaped, requeued } = await sweepWithProductionConfig();
      expect(reaped).toEqual([]);
      expect(requeued).toEqual([]);
      await requeueWithBackoff(RETRY_ATTEMPT_CAP, "0 milliseconds"); // even with no backoff
      const leased = await asServiceRole<LeasedRow>(LEASE_SQL);
      expect(leased[0].id).toBeNull();
    }
    const final = await runRow(runId);
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(RETRY_ATTEMPT_CAP);
    expect(final.error_code).toBe("engine_error");
  });

  it("a run OVER the cap (attempts=4) is never requeued either", async () => {
    const over = await insertRun(a, {
      status: "failed",
      attempts: RETRY_ATTEMPT_CAP + 1,
      errorCode: "engine_error",
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(await requeueWithBackoff(RETRY_ATTEMPT_CAP, "0 milliseconds")).toEqual([]);
    expect((await runRow(over)).status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Kick-failure → recovery, traced end-to-end                       */
/* ------------------------------------------------------------------ */

describe("kick-failure recovery — the end-to-end trace on the live DB", () => {
  it("HONEST NEGATIVE: the two sweep functions alone do NOT touch a stale queued run (a dropped kick needs a processor poke/lease)", async () => {
    // Enqueue exactly as the enqueue action's insert lands (tenant-scoped,
    // through RLS as the operator), then NO kick.
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claimsFor("operator", a.tenantId, { sub: a.operatorSub }),
      `insert into runs (tenant_id, client_id, property_id, kind, status)
       values ($1, $2, $3, 'audit', 'queued') returning id`,
      [a.tenantId, a.clientId, a.propertyId]
    );
    const runId = res.rows[0].id;

    // Age it far past every window, then sweep with production config.
    await db.admin.query(`update runs set created_at = now() - interval '1 day' where id = $1`, [runId]);
    const { reaped, requeued } = await sweepWithProductionConfig();
    expect(reaped).toEqual([]); // reap only touches running
    expect(requeued).toEqual([]); // requeue only touches failed
    expect((await runRow(runId)).status).toBe("queued"); // still stranded

    // The path that DOES recover it: a processor invocation (poke or chained
    // kick) leases it...
    const leased = await asServiceRole<LeasedRow>(LEASE_SQL);
    expect(leased[0].id).toBe(runId);
    expect(leased[0].status).toBe("running");

    // ...and executes it under the A1 minted context: read the property and
    // client, persist the artifact, complete the run — all tenant-pinned.
    const claims = mintedClaims(a.tenantId);
    const property = await queryAs<{ id: string; client_id: string; url: string }>(
      db.admin,
      "authenticated",
      claims,
      `select id, client_id, url from properties where id = $1`,
      [a.propertyId]
    );
    expect(property.rows).toHaveLength(1);
    const client = await queryAs<{ id: string; vertical: string }>(
      db.admin,
      "authenticated",
      claims,
      `select id, vertical from clients where id = $1`,
      [property.rows[0].client_id]
    );
    expect(client.rows).toHaveLength(1);

    const audit = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claims,
      `insert into audits (tenant_id, client_id, property_id, score, fixes)
       values ($1, $2, $3, '{"total": 55}', '[]') returning id`,
      [a.tenantId, a.clientId, a.propertyId]
    );
    const auditId = audit.rows[0].id;

    const completed = await queryAs(
      db.admin,
      "authenticated",
      claims,
      `update runs set status = 'succeeded', result_ref = $2, error_code = null where id = $1`,
      [runId, JSON.stringify({ kind: "audit", id: auditId })]
    );
    expect(completed.rowCount).toBe(1);

    const final = await db.admin.query(
      `select status, error_code, result_ref from runs where id = $1`,
      [runId]
    );
    expect(final.rows[0].status).toBe("succeeded");
    expect(final.rows[0].error_code).toBeNull();
    expect(final.rows[0].result_ref).toEqual({ kind: "audit", id: auditId });
  });

  it("crash-mid-run: lease → processor dies → reap (NOT requeued same pass) → backoff → requeue SAME row attempts+1 → re-lease → succeed", async () => {
    const runId = await insertRun(a, { status: "queued" });

    // Leased, then the processor dies: heartbeat freezes.
    const leased = await asServiceRole<LeasedRow>(LEASE_SQL);
    expect(leased[0].id).toBe(runId);
    await db.admin.query(
      `update runs set heartbeat_at = now() - ($2::int * interval '1 millisecond') where id = $1`,
      [runId, ORPHAN_STALE_MS + 1_000]
    );

    // Sweep pass 1 (production config): reaped to failed/'orphaned'; NOT
    // requeued in the same pass (the reap just bumped updated_at — inside
    // backoff), and not leasable while failed.
    const pass1 = await sweepWithProductionConfig();
    expect(pass1.reaped).toEqual([runId]);
    expect(pass1.requeued).toEqual([]);
    let row = await runRow(runId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("orphaned");
    expect((await asServiceRole<LeasedRow>(LEASE_SQL))[0].id).toBeNull();

    // Backoff elapses → a later sweep requeues the SAME row, attempts+1.
    const requeued = await requeueWithBackoff(RETRY_ATTEMPT_CAP, "0 milliseconds");
    expect(requeued).toEqual([runId]);
    row = await runRow(runId);
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.error_code).toBeNull();

    // Re-leased and completed through the minted context: recovery is REAL.
    const released = await asServiceRole<LeasedRow>(LEASE_SQL);
    expect(released[0].id).toBe(runId);
    const completed = await queryAs(
      db.admin,
      "authenticated",
      mintedClaims(a.tenantId),
      `update runs set status = 'succeeded', result_ref = '{"kind":"audit"}' where id = $1`,
      [runId]
    );
    expect(completed.rowCount).toBe(1);
    expect((await runRow(runId)).status).toBe("succeeded");

    // Terminal means terminal for the queue infra: further sweeps + leases are no-ops.
    const quiet = await sweepWithProductionConfig();
    expect(quiet.reaped).toEqual([]);
    expect(quiet.requeued).toEqual([]);
    expect((await asServiceRole<LeasedRow>(LEASE_SQL))[0].id).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 7. Minted-JWT tenant isolation (A1)                                 */
/* ------------------------------------------------------------------ */

describe("A1 minted per-run context — RLS-identical to an operator of the run's tenant", () => {
  it("sees its OWN tenant's property/client (positive control: the context is a functional writer)", async () => {
    const claims = mintedClaims(a.tenantId);
    const props = await queryAs<{ id: string; tenant_id: string }>(
      db.admin,
      "authenticated",
      claims,
      `select id, tenant_id from properties`
    );
    expect(props.rows.map((r) => r.id)).toContain(a.propertyId);
    for (const r of props.rows) expect(r.tenant_id).toBe(a.tenantId);

    const audit = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claims,
      `insert into audits (tenant_id, client_id, property_id, score, fixes)
       values ($1, $2, $3, '{"total": 10}', '[]') returning id`,
      [a.tenantId, a.clientId, a.propertyId]
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("tenant B is INVISIBLE: zero rows from B's properties/clients/runs", async () => {
    const bRun = await insertRun(b, { status: "queued" });
    const claims = mintedClaims(a.tenantId);
    const probes = [
      [`select id from properties where id = $1`, b.propertyId],
      [`select id from clients where id = $1`, b.clientId],
      [`select id from clients where tenant_id = $1`, b.tenantId],
      [`select id from runs where id = $1`, bRun],
    ] as const;
    for (const [sql, param] of probes) {
      const res = await queryAs(db.admin, "authenticated", claims, sql, [param]);
      expect(res.rows, sql).toHaveLength(0);
    }
  });

  it("tenant B is UNWRITABLE: an audit insert for B is refused by RLS; a cross-tenant client ref is refused by the composite FK", async () => {
    const claims = mintedClaims(a.tenantId);
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claims,
      `insert into audits (tenant_id, client_id, property_id, score, fixes)
       values ($1, $2, $3, '{"total": 1}', '[]')`,
      [b.tenantId, b.clientId, b.propertyId],
      /row-level security/i
    );
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claims,
      `insert into audits (tenant_id, client_id, property_id, score, fixes)
       values ($1, $2, $3, '{"total": 1}', '[]')`,
      [a.tenantId, b.clientId, b.propertyId],
      /foreign key|row-level security/i
    );
  });

  it("cannot touch tenant B's run state: heartbeat/completion updates hit ZERO rows", async () => {
    const bRun = await insertRun(b, { status: "running", heartbeatAt: new Date().toISOString() });
    const claims = mintedClaims(a.tenantId);
    const beat = await queryAs(db.admin, "authenticated", claims, `update runs set heartbeat_at = now() where id = $1`, [bRun]);
    expect(beat.rowCount).toBe(0);
    const complete = await queryAs(
      db.admin,
      "authenticated",
      claims,
      `update runs set status = 'failed', error_code = 'engine_error' where id = $1`,
      [bRun]
    );
    expect(complete.rowCount).toBe(0);
    expect((await runRow(bRun)).status).toBe("running"); // untouched
  });

  it("the minted context is NOT service-role-ish: it cannot call the queue functions", async () => {
    const claims = mintedClaims(a.tenantId);
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claims,
      "select public.lease_next_run()",
      undefined,
      /permission denied for function lease_next_run/i
    );
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claims,
      "select public.reap_orphaned_runs(now())",
      undefined,
      /permission denied for function reap_orphaned_runs/i
    );
  });
});

/* ------------------------------------------------------------------ */
/* 8. EXECUTE-lockdown completion + PostgREST-surface tripwire          */
/* ------------------------------------------------------------------ */

describe("EXECUTE lockdown — remaining roles + the public-schema function tripwire", () => {
  const FUNCTION_CALLS = [
    ["lease_next_run", "select public.lease_next_run()"],
    ["reap_orphaned_runs", "select public.reap_orphaned_runs(now())"],
    ["requeue_failed_runs", "select public.requeue_failed_runs(3, '30 seconds', '5 minutes')"],
  ] as const;

  it("client_viewer claims are denied on ALL THREE functions", async () => {
    for (const [name, sql] of FUNCTION_CALLS) {
      await expectQueryRejected(
        db.admin,
        "authenticated",
        claimsFor("client_viewer", a.tenantId, { clientId: a.clientId, sub: a.viewerSub }),
        sql,
        undefined,
        new RegExp(`permission denied for function ${name}`, "i")
      );
    }
  });

  it("platform_owner claims are denied on ALL THREE functions (the DB role, not the app claim, gates EXECUTE)", async () => {
    for (const [name, sql] of FUNCTION_CALLS) {
      await expectQueryRejected(
        db.admin,
        "authenticated",
        claimsFor("platform_owner", a.tenantId),
        sql,
        undefined,
        new RegExp(`permission denied for function ${name}`, "i")
      );
    }
  });

  it("anon is denied on the two sweep functions too", async () => {
    for (const [name, sql] of FUNCTION_CALLS.slice(1)) {
      await expectQueryRejected(
        db.admin,
        "anon",
        null,
        sql,
        undefined,
        new RegExp(`permission denied for function ${name}`, "i")
      );
    }
  });

  it("TRIPWIRE: no function in the PostgREST-exposed `public` schema is executable by authenticated or anon", async () => {
    // PostgREST exposes every public-schema function the request role can
    // EXECUTE as /rpc/<name>. This sweep makes a future function added without
    // an EXECUTE-lockdown review fail the suite BY DEFAULT (the posture-suite
    // precedent, extended from tables to functions).
    const res = await db.admin.query<{
      signature: string;
      auth_exec: boolean;
      anon_exec: boolean;
    }>(
      `select p.oid::regprocedure::text as signature,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
       order by signature`
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(3); // at least the queue trio
    for (const r of res.rows) {
      expect(r.auth_exec, `${r.signature}: authenticated must NOT have EXECUTE`).toBe(false);
      expect(r.anon_exec, `${r.signature}: anon must NOT have EXECUTE`).toBe(false);
    }
  });

  it("STRUCTURAL PIN: the three queue functions are SECURITY DEFINER with an empty search_path, executable by service_role only", async () => {
    const res = await db.admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      service_exec: boolean;
    }>(
      `select p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('lease_next_run', 'reap_orphaned_runs', 'requeue_failed_runs')
       order by p.proname`
    );
    expect(res.rows.map((r) => r.proname)).toEqual([
      "lease_next_run",
      "reap_orphaned_runs",
      "requeue_failed_runs",
    ]);
    for (const r of res.rows) {
      expect(r.prosecdef, `${r.proname} must be SECURITY DEFINER`).toBe(true);
      expect(r.proconfig ?? [], `${r.proname} must pin an empty search_path`).toContainEqual(
        'search_path=""'
      );
      expect(r.service_exec, `${r.proname} must be executable by service_role`).toBe(true);
    }
  });
});
