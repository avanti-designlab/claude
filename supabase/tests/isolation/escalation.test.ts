/**
 * F1 isolation suite — PRIVILEGE ESCALATION + CLAIM-STATE ISOLATION
 * (doc 03 §7; contract §2, §3).
 *
 * Two attack surfaces:
 *
 * 1. ROLE ESCALATION. queryAs() runs on the SUPERUSER admin connection via
 *    `SET LOCAL ROLE authenticated`. RLS is enforced correctly there, but the
 *    session authorization stays superuser — so `SET ROLE postgres` would
 *    wrongly succeed on that connection. That is a harness artifact, NOT a real
 *    vulnerability. To test escalation faithfully we spin up a dedicated
 *    NOSUPERUSER / NOBYPASSRLS login role that mirrors Supabase's `authenticator`
 *    (member of authenticated + anon, NOINHERIT) and prove it cannot climb.
 *
 * 2. CLAIM-STATE ISOLATION. Every queryAs() must reflect ONLY the claims of
 *    that call — no bleed from a prior call, and RLS always scoped to exactly
 *    the currently-set tenant (never an accumulation across tenants).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";
import { claimsForRole } from "./fixtures";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;
let authr: Client;
const authrRole = `authr_test_${Date.now().toString(36)}`;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));

  // Supabase-exact request-role stack: `authenticator` is a NOSUPERUSER login
  // role that can only SET ROLE into authenticated / anon.
  await db.admin.query(
    `create role "${authrRole}" login noinherit nosuperuser nobypassrls password 'x'`
  );
  await db.admin.query(`grant authenticated, anon to "${authrRole}"`);

  const u = new URL(db.url);
  u.username = authrRole;
  u.password = "x";
  authr = new Client({ connectionString: u.toString() });
  await authr.connect();
});

afterAll(async () => {
  await authr?.end();
  await db?.admin.query(`drop role if exists "${authrRole}"`);
  await db?.teardown();
});

/** Run a statement on the authenticator connection AS authenticated + claims. */
async function runAsAuthenticated<T extends Record<string, unknown>>(
  claims: Record<string, unknown>,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  await authr.query("begin");
  try {
    await authr.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claims),
    ]);
    await authr.query("set local role authenticated");
    const res = await authr.query<T>(sql, params);
    await authr.query("commit");
    return res.rows;
  } catch (err) {
    await authr.query("rollback");
    throw err;
  }
}

describe("role escalation — a NOSUPERUSER authenticator cannot climb (mirrors Supabase)", () => {
  it("confirms the authenticator is not a superuser and RLS applies to it", async () => {
    const who = await authr.query<{ u: string; super: boolean }>(
      `select session_user as u, (select rolsuper from pg_roles where rolname = session_user) as super`
    );
    expect(who.rows[0].u).toBe(authrRole);
    expect(who.rows[0].super).toBe(false);

    // Real non-superuser RLS check: seated in tenant B, tenant-A rows are gone,
    // own rows are present — same result the superuser-based queryAs reports.
    const foreign = await runAsAuthenticated<{ n: number }>(
      claimsForRole("operator", b),
      `select count(*)::int as n from clients where tenant_id = $1`,
      [a.tenantId]
    );
    const own = await runAsAuthenticated<{ n: number }>(
      claimsForRole("operator", b),
      `select count(*)::int as n from clients where tenant_id = $1`,
      [b.tenantId]
    );
    expect(foreign[0].n).toBe(0);
    expect(own[0].n).toBeGreaterThanOrEqual(1);
  });

  it("SET ROLE postgres is denied", async () => {
    await expect(authr.query("set role postgres")).rejects.toThrow(
      /permission denied to set role/
    );
  });

  it("SET ROLE postgres is still denied after SET ROLE authenticated", async () => {
    await authr.query("set role authenticated");
    try {
      await expect(authr.query("set role postgres")).rejects.toThrow(
        /permission denied to set role/
      );
    } finally {
      await authr.query("reset role");
    }
  });

  it("SET SESSION AUTHORIZATION postgres is denied", async () => {
    await expect(authr.query("set session authorization postgres")).rejects.toThrow(
      /permission denied to set session authorization/
    );
  });

  it("CREATE ROLE (self-promotion to superuser) is denied", async () => {
    await expect(authr.query("create role hacker superuser login")).rejects.toThrow(
      /permission denied to create role/
    );
  });
});

describe("claim-state isolation — each queryAs reflects only its own claims", () => {
  it("sequential calls do not bleed: A → B → A each returns its own tenant only", async () => {
    const readClients = async (t: SeededTenant) => {
      const res = await queryAs<{ tenant_id: string }>(
        db.admin,
        "authenticated",
        claimsForRole("operator", t),
        `select tenant_id::text from clients`
      );
      return new Set(res.rows.map((r) => r.tenant_id));
    };
    const first = await readClients(a);
    const second = await readClients(b);
    const third = await readClients(a);

    expect([...first]).toEqual([a.tenantId]);
    expect([...second]).toEqual([b.tenantId]);
    expect([...third]).toEqual([a.tenantId]); // no leak from the tenant-B call
  });

  it("claims do not persist across calls: a following no-claims call sees ZERO rows", async () => {
    await queryAs(
      db.admin,
      "authenticated",
      claimsForRole("operator", a),
      `select 1 from clients`
    );
    const res = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      null,
      `select count(*)::int as n from clients`
    );
    expect(res.rows[0].n).toBe(0); // fail closed, not "still tenant A"
  });

  it("mutating claims mid-transaction re-scopes to the NEW tenant only (never both)", async () => {
    await db.admin.query("begin");
    try {
      await db.admin.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claimsForRole("operator", a)),
      ]);
      await db.admin.query("set local role authenticated");
      const asA = await db.admin.query<{ tid: string }>(
        `select distinct tenant_id::text as tid from clients`
      );
      // Attacker rewrites the claims GUC mid-transaction to tenant B:
      await db.admin.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claimsForRole("operator", b)),
      ]);
      const asB = await db.admin.query<{ tid: string }>(
        `select distinct tenant_id::text as tid from clients`
      );
      await db.admin.query("commit");

      expect(asA.rows.map((r) => r.tid)).toEqual([a.tenantId]);
      expect(asB.rows.map((r) => r.tid)).toEqual([b.tenantId]); // exactly B, never A+B
    } catch (err) {
      await db.admin.query("rollback");
      throw err;
    }
  });

  it("queryAs resets the role: the admin connection is superuser again afterwards", async () => {
    await queryAs(
      db.admin,
      "authenticated",
      claimsForRole("operator", a),
      `select 1 from clients`
    );
    const who = await db.admin.query<{ u: string; is_super: boolean }>(
      `select current_user as u,
              (select rolsuper from pg_roles where rolname = current_user) as is_super`
    );
    expect(who.rows[0].is_super).toBe(true); // role did not leak from the queryAs
  });
});
