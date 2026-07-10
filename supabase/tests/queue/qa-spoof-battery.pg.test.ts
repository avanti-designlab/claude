/**
 * QA SPOOF BATTERY — the caller-discrimination mechanism attacked to a 0-bypass
 * standard (Orchestrator QA-F2 ruling condition 4, QA-owned by name). The 0012
 * transition guard privileges a queue op ONLY when BOTH hold: the
 * transaction-local GUC `app.runs_queue_op` is set AND `current_user` is the
 * runs table owner (the definer execution context). This file proves that
 * combination is unreachable from the PostgREST-exposed surface — and that the
 * two proven F2 exploits are DB-refused (QA's own gate-blocking red pins, held
 * independently of the architect's transition-guard.pg.test.ts).
 *
 * Attack surface covered:
 *   A. QA red pins — terminal→queued re-lease; failed-at-cap→queued+attempts=0.
 *   B. GUC hand-set as authenticated (every op) → "outside definer context";
 *      and a GUC set over an OTHERWISE-LEGAL tenant cancel still fails closed.
 *   C. Claim-injected GUC — a JWT claim keyed `app.runs_queue_op` never becomes
 *      the standalone GUC (PostgREST claims land inside request.jwt.claims).
 *   D. Forged/minted-claims variants (operator / agency_admin / platform_owner)
 *      cannot drive any privileged edge raw.
 *   E. service_role WITHOUT the definer context — even GRANTED table UPDATE and
 *      with BYPASSRLS, an illegal edge is refused by the trigger (no exemption).
 *   F. requested_by →NULL carve-out cannot be leveraged: it never unlocks an
 *      illegal status edge, and the genuine FK ON DELETE SET NULL cascade (as a
 *      real authenticated admin) is the only thing it admits — on terminal rows
 *      too.
 *   G. Exposed-RPC reach — no public-schema function is EXECUTE-able by
 *      authenticated/anon; the guard function itself is not either.
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

function operator(): JwtClaims {
  return claimsFor("operator", a.tenantId, { sub: a.operatorSub });
}

/** Superuser INSERT (owner context) — seeding, not a guard-relevant edge. */
async function insertRun(opts: {
  status?: string;
  attempts?: number;
  errorCode?: string | null;
  heartbeatAt?: string | null;
  requestedBy?: string | null;
} = {}): Promise<string> {
  const res = await db.admin.query<{ id: string }>(
    `insert into runs (tenant_id, client_id, property_id, kind, status, attempts, error_code, heartbeat_at, requested_by)
     values ($1,$2,$3,'audit',$4,$5,$6,$7,$8) returning id`,
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

async function runRow(
  id: string
): Promise<{ status: string; attempts: number; error_code: string | null; requested_by: string | null }> {
  const res = await db.admin.query(
    `select status, attempts, error_code, requested_by from runs where id = $1`,
    [id]
  );
  return res.rows[0];
}

/* ------------------------------------------------------------------ */
/* A. QA-owned red pins for the two proven F2 exploits                 */
/* ------------------------------------------------------------------ */

describe("QA RED PINS — the two proven exploits, refused by the DATABASE", () => {
  it("EXPLOIT 1 terminal→queued re-lease: succeeded→queued via operator UPDATE is refused (was ACCEPTED pre-trigger)", async () => {
    const done = await insertRun({ status: "succeeded" });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `update runs set status = 'queued' where id = $1`, // the EXACT shape QA proved live
      [done],
      REFUSED
    );
    expect((await runRow(done)).status).toBe("succeeded"); // terminal, untouched
  });

  it("EXPLOIT 2 failed-at-cap→queued+attempts=0 via operator UPDATE is refused (was ACCEPTED pre-trigger)", async () => {
    const capped = await insertRun({ status: "failed", attempts: 3, errorCode: "engine_error" });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `update runs set status = 'queued', attempts = 0, error_code = null where id = $1`,
      [capped],
      REFUSED
    );
    const row = await runRow(capped);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3); // cap intact — no resurrection
  });
});

/* ------------------------------------------------------------------ */
/* B. GUC hand-set as authenticated                                   */
/* ------------------------------------------------------------------ */

describe("GUC hand-set spoof — set app.runs_queue_op then attempt the privileged edge", () => {
  it("all three ops set by hand are refused 'outside definer context'", async () => {
    // lease
    const queued = await insertRun();
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `select pg_catalog.set_config('app.runs_queue_op','lease',true);
       update runs set status='running', heartbeat_at=now() where id='${queued}'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(queued)).status).toBe("queued");

    // reap
    const running = await insertRun({ status: "running", heartbeatAt: new Date().toISOString() });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `select pg_catalog.set_config('app.runs_queue_op','reap',true);
       update runs set status='failed', error_code='orphaned' where id='${running}'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(running)).status).toBe("running");

    // requeue
    const failed = await insertRun({ status: "failed", attempts: 1, errorCode: "engine_error" });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `select pg_catalog.set_config('app.runs_queue_op','requeue',true);
       update runs set status='queued', attempts=2, error_code=null where id='${failed}'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(failed)).status).toBe("failed");
  });

  it("FAIL-CLOSED: a set GUC even over an OTHERWISE-LEGAL tenant cancel is refused (the op flag forces the definer-only path)", async () => {
    const queued = await insertRun();
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `select pg_catalog.set_config('app.runs_queue_op','lease',true);
       update runs set status='canceled' where id='${queued}' and status='queued'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(queued)).status).toBe("queued"); // cancel did NOT land
  });

  it("a BOGUS op value is refused too (unknown queue op), never silently ignored", async () => {
    const queued = await insertRun();
    // With a non-owner + a set (bogus) GUC, the privileged branch is entered and
    // the owner check fails first — still refused. (Owner-side bogus-op coverage
    // is the architect's 'unknown queue op' path.)
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `select pg_catalog.set_config('app.runs_queue_op','totally-bogus',true);
       update runs set status='running', heartbeat_at=now() where id='${queued}'`,
      undefined,
      /privileged queue op outside definer context/
    );
    expect((await runRow(queued)).status).toBe("queued");
  });
});

/* ------------------------------------------------------------------ */
/* C. Claim-injected GUC                                               */
/* ------------------------------------------------------------------ */

describe("claim-injected GUC — a JWT claim cannot create the standalone op GUC", () => {
  it("a claim keyed 'app.runs_queue_op' does NOT populate current_setting('app.runs_queue_op')", async () => {
    const spoofClaims: Record<string, unknown> = {
      tenant_id: a.tenantId,
      role: "authenticated",
      user_role: "operator",
      sub: a.operatorSub,
      "app.runs_queue_op": "lease", // the injection attempt
    };
    const res = await queryAs<{ v: string | null }>(
      db.admin,
      "authenticated",
      spoofClaims,
      `select current_setting('app.runs_queue_op', true) as v`
    );
    // PostgREST materialises claims inside request.jwt.claims, never as a
    // free-standing app.* GUC — so the guard sees NOTHING here.
    expect(res.rows[0].v === null || res.rows[0].v === "").toBe(true);
  });

  it("and with that claim present, the lease edge is still a plain tenant-path illegal transition (no privilege granted)", async () => {
    const queued = await insertRun();
    const spoofClaims: Record<string, unknown> = {
      tenant_id: a.tenantId,
      role: "authenticated",
      user_role: "operator",
      sub: a.operatorSub,
      "app.runs_queue_op": "lease",
    };
    await expectQueryRejected(
      db.admin,
      "authenticated",
      spoofClaims,
      `update runs set status='running', heartbeat_at=now() where id=$1`,
      [queued],
      /illegal transition queued -> running/
    );
    expect((await runRow(queued)).status).toBe("queued");
  });
});

/* ------------------------------------------------------------------ */
/* D. Forged / minted claim variants                                  */
/* ------------------------------------------------------------------ */

describe("forged/minted claim variants — no app-role escalates a raw privileged edge", () => {
  it("writer roles (operator, agency_admin) are REFUSED the lease edge by the guard", async () => {
    for (const role of ["operator", "agency_admin"] as const) {
      const queued = await insertRun();
      await expectQueryRejected(
        db.admin,
        "authenticated",
        claimsFor(role, a.tenantId, { sub: a.operatorSub }),
        `update runs set status='running', heartbeat_at=now() where id=$1`,
        [queued],
        REFUSED
      );
      expect((await runRow(queued)).status).toBe("queued");
      await db.admin.query("delete from runs");
    }
  });

  it("platform_owner claims cannot reach the edge at all — is_writer() is false, so RLS hides the row (0 rows, never the trigger)", async () => {
    // A forged platform_owner claim (the role never sits in tenant_users) is not
    // a writer: runs_update's USING (is_writer()) filters the row out BEFORE the
    // BEFORE-UPDATE trigger fires, so the write touches ZERO rows. Blocked even
    // earlier than the guard — and it leaves no run mutated either way.
    const queued = await insertRun();
    const res = await queryAs(
      db.admin,
      "authenticated",
      claimsFor("platform_owner", a.tenantId, { sub: a.operatorSub }),
      `update runs set status='running', heartbeat_at=now() where id=$1`,
      [queued]
    );
    expect(res.rowCount).toBe(0);
    expect((await runRow(queued)).status).toBe("queued");
  });
});

/* ------------------------------------------------------------------ */
/* E. service_role WITHOUT the definer context                        */
/* ------------------------------------------------------------------ */

describe("service_role raw table write — NO exemption from the trigger", () => {
  it("even GRANTED UPDATE + BYPASSRLS, an illegal edge by raw service_role is refused by the guard", async () => {
    const done = await insertRun({ status: "succeeded" });

    // Prove the trigger — not merely the harness's missing grant — is the
    // backstop: grant service_role UPDATE inside a transaction we roll back, so
    // the only thing standing between a leaked/misused service key and an
    // illegal terminal reopen is app.runs_transition_guard.
    await db.admin.query("begin");
    let refusedByTrigger = false;
    try {
      // Grant BOTH select + update (the WHERE reads columns) so the write
      // actually reaches the trigger — otherwise a missing SELECT grant, not the
      // guard, would be doing the refusing (the point is to prove the GUARD).
      await db.admin.query("grant select, update on public.runs to service_role");
      await db.admin.query("set local role service_role"); // BYPASSRLS, NOT the owner, no GUC
      try {
        await db.admin.query(`update runs set status='queued' where id='${done}'`);
      } catch (err) {
        refusedByTrigger = /runs_transition_refused/.test(err instanceof Error ? err.message : String(err));
      }
    } finally {
      await db.admin.query("rollback"); // undo the grant + role, aborted-tx-safe
    }
    expect(refusedByTrigger).toBe(true);
    expect((await runRow(done)).status).toBe("succeeded"); // never reopened
  });
});

/* ------------------------------------------------------------------ */
/* F. requested_by →NULL carve-out cannot be leveraged                */
/* ------------------------------------------------------------------ */

describe("requested_by →NULL carve-out — admits only the FK SET NULL shape", () => {
  it("nulling requested_by does NOT unlock an otherwise-illegal terminal reopen", async () => {
    const done = await insertRun({ status: "succeeded", requestedBy: a.operatorUserId });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      operator(),
      `update runs set status='queued', requested_by=null where id=$1`,
      [done],
      REFUSED
    );
    const row = await runRow(done);
    expect(row.status).toBe("succeeded");
    expect(row.requested_by).toBe(a.operatorUserId); // whole statement refused
  });

  it("the GENUINE FK ON DELETE SET NULL cascade (as a real authenticated admin) nulls requested_by on a TERMINAL run", async () => {
    // A fresh operator user we can delete without disturbing the shared seed.
    const doomed = (
      await db.admin.query<{ id: string }>(
        `insert into tenant_users (tenant_id, auth_user_id, role) values ($1, gen_random_uuid(), 'operator') returning id`,
        [a.tenantId]
      )
    ).rows[0].id;
    const run = await insertRun({ status: "succeeded", requestedBy: doomed });

    // Delete the tenant_user as an authenticated agency_admin (is_admin gate) —
    // the FK ON DELETE SET NULL fires the runs UPDATE as this non-owner role, so
    // the guard's tenant-path carve-out is what must admit requested_by→NULL.
    const del = await queryAs(
      db.admin,
      "authenticated",
      claimsFor("agency_admin", a.tenantId, { sub: a.adminSub }),
      `delete from tenant_users where id = $1`,
      [doomed]
    );
    expect(del.rowCount).toBe(1);

    const row = await runRow(run);
    expect(row.status).toBe("succeeded"); // terminal row survives the cascade
    expect(row.requested_by).toBeNull(); // attribution dropped, nothing else moved
  });
});

/* ------------------------------------------------------------------ */
/* G. Exposed-RPC reach (re-run of the public-function tripwire)       */
/* ------------------------------------------------------------------ */

describe("exposed-RPC reach — the PostgREST function surface stays sealed", () => {
  it("no PUBLIC-schema function is EXECUTE-able by authenticated or anon (the trio + any future add)", async () => {
    const res = await db.admin.query<{ signature: string; auth: boolean; anon: boolean }>(
      `select p.oid::regprocedure::text as signature,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' order by signature`
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of res.rows) {
      expect(r.auth, `${r.signature}: authenticated must NOT EXECUTE`).toBe(false);
      expect(r.anon, `${r.signature}: anon must NOT EXECUTE`).toBe(false);
    }
  });

  it("the guard function app.runs_transition_guard is not EXECUTE-able by authenticated/anon either (defense-in-depth; it fires as a trigger)", async () => {
    const res = await db.admin.query<{ auth: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'app.runs_transition_guard()', 'EXECUTE') as auth,
              has_function_privilege('anon', 'app.runs_transition_guard()', 'EXECUTE') as anon`
    );
    expect(res.rows[0].auth).toBe(false);
    expect(res.rows[0].anon).toBe(false);
  });
});
