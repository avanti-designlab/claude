/**
 * F1 smoke suite (build step 0.3). Proves the foundation is sound:
 * migrations apply to a fresh database; RLS is enabled AND forced everywhere;
 * tenant_id is present + leading-indexed everywhere; the auth shim
 * round-trips; and a two-tenant seed with cross-tenant canaries returns
 * zero rows. The full adversarial isolation suite (every role x every table
 * x read+write) is the QA agent's deliverable on top of this harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_TABLES,
  TENANT_ID_TABLES,
  claimsFor,
  expectQueryRejected,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "./helpers/harness";
import { seedTenantPair, type SeededTenant } from "./helpers/seed";

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

describe("migrations", () => {
  it("apply cleanly to a fresh database and create exactly the F1 tables", async () => {
    expect(db.migrations.length).toBeGreaterThanOrEqual(6);
    const res = await db.admin.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`
    );
    const actual = res.rows.map((r) => r.tablename).sort();
    expect(actual).toEqual([...ALL_TABLES].sort());
  });
});

describe("row-level security", () => {
  it("is ENABLED and FORCED on every table in public", async () => {
    const res = await db.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`
    );
    expect(res.rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLES].sort());
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS must be ENABLED`).toBe(true);
      expect(
        row.relforcerowsecurity,
        `${row.relname}: RLS must be FORCED (owner not exempt)`
      ).toBe(true);
    }
  });

  it("grants anon nothing on tenant data", async () => {
    await expectQueryRejected(
      db.admin,
      "anon",
      null,
      "select * from clients",
      undefined,
      /permission denied/
    );
  });
});

describe("tenant_id column + index", () => {
  it("every tenant-owned table has a NOT NULL tenant_id", async () => {
    for (const table of TENANT_ID_TABLES) {
      const res = await db.admin.query<{ attnotnull: boolean }>(
        `select attnotnull from pg_attribute
         where attrelid = ('public.' || quote_ident($1))::regclass
           and attname = 'tenant_id' and not attisdropped`,
        [table]
      );
      expect(res.rowCount, `${table}: tenant_id column must exist`).toBe(1);
      expect(res.rows[0].attnotnull, `${table}: tenant_id must be NOT NULL`).toBe(true);
    }
  });

  it("every tenant-owned table has an index leading with tenant_id", async () => {
    for (const table of TENANT_ID_TABLES) {
      const res = await db.admin.query<{ n: number }>(
        `select count(*)::int as n
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid = ('public.' || quote_ident($1))::regclass
           and a.attname = 'tenant_id'`,
        [table]
      );
      expect(
        res.rows[0].n,
        `${table}: needs at least one index whose FIRST column is tenant_id`
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("auth shim (Supabase-exact auth.jwt())", () => {
  it("round-trips claims: set request.jwt.claims -> auth.jwt() returns them", async () => {
    const claims = claimsFor("operator", a.tenantId, { sub: a.operatorSub });
    const res = await queryAs<{
      jwt: Record<string, unknown>;
      tid: string;
      role: string;
      uid: string;
    }>(
      db.admin,
      "authenticated",
      claims,
      `select auth.jwt() as jwt,
              app.tenant_id()::text as tid,
              app.user_role() as role,
              app.auth_user_id()::text as uid`
    );
    expect(res.rows[0].jwt).toEqual(claims);
    expect(res.rows[0].tid).toBe(a.tenantId);
    expect(res.rows[0].role).toBe("operator");
    expect(res.rows[0].uid).toBe(a.operatorSub);
  });

  it("returns NULL claims when none are set (fail closed)", async () => {
    const res = await queryAs<{ is_null: boolean; tid: string | null }>(
      db.admin,
      "authenticated",
      null,
      `select auth.jwt() is null as is_null, app.tenant_id()::text as tid`
    );
    expect(res.rows[0].is_null).toBe(true);
    expect(res.rows[0].tid).toBeNull();
  });
});

describe("two-tenant canary (full suite is QA's deliverable)", () => {
  it("tenant A operator sees only tenant A clients", async () => {
    const claims = claimsFor("operator", a.tenantId, { sub: a.operatorSub });
    const res = await queryAs<{ id: string; tenant_id: string }>(
      db.admin,
      "authenticated",
      claims,
      "select id, tenant_id from clients order by created_at"
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of res.rows) {
      expect(row.tenant_id).toBe(a.tenantId);
    }
    expect(res.rows.map((r) => r.id)).not.toContain(b.clientId);
  });

  it("cross-tenant SELECT returns zero rows on EVERY tenant-owned table", async () => {
    const claims = claimsFor("operator", a.tenantId, { sub: a.operatorSub });
    for (const table of TENANT_ID_TABLES) {
      const res = await queryAs<{ n: number }>(
        db.admin,
        "authenticated",
        claims,
        // table name comes from the harness constant, not user input
        `select count(*)::int as n from ${table} where tenant_id = $1`,
        [b.tenantId]
      );
      expect(
        res.rows[0].n,
        `${table}: tenant A must see ZERO tenant B rows`
      ).toBe(0);
    }
  });

  it("tenants root: tenant A member cannot see tenant B's row", async () => {
    const claims = claimsFor("agency_admin", a.tenantId, { sub: a.adminSub });
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claims,
      "select id from tenants"
    );
    expect(res.rows.map((r) => r.id)).toEqual([a.tenantId]);
  });

  it("cross-tenant INSERT is rejected by RLS", async () => {
    const claims = claimsFor("agency_admin", a.tenantId, { sub: a.adminSub });
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claims,
      `insert into clients (tenant_id, name, vertical) values ($1, 'intruder', 'ecommerce')`,
      [b.tenantId],
      /row-level security/
    );
  });

  it("composite FKs make cross-tenant references impossible even for the superuser", async () => {
    // Structural tenant-consistency: tenant A task pointing at tenant B's
    // plan must fail at the constraint layer, below RLS entirely.
    await expect(
      db.admin.query(
        `insert into tasks (tenant_id, client_id, plan_id, module)
         values ($1, $2, $3, 'audit')`,
        [a.tenantId, a.clientId, b.planId]
      )
    ).rejects.toThrow(/foreign key constraint/);
  });
});
