/**
 * F1 isolation suite — RLS POSTURE (doc 03 §7 criterion 1; contract §3, §10, §11).
 *
 * Structural, catalog-driven assertions that make policy drift fail loudly:
 *  - every table in `public` has RLS ENABLED and FORCED (owner not exempt);
 *  - every policy is PER-COMMAND (never FOR ALL) and targets `authenticated`
 *    ONLY (never PUBLIC / anon);
 *  - every table has at least a SELECT policy (no accidentally-invisible table);
 *  - `anon` holds ZERO privileges on every table;
 *  - the request roles `authenticated` / `anon` are neither superuser nor
 *    BYPASSRLS nor login (escalation surface closed at the role graph);
 *  - the LIVE catalog matches the documented ALL_TABLES / TENANT_ID_TABLES /
 *    CLIENT_SCOPED_TABLES constants — a new table without coverage fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_TABLES,
  CLIENT_SCOPED_TABLES,
  TENANT_ID_TABLES,
  introspectSchema,
  setupIsolationDb,
  type IsolationDb,
  type SchemaIntrospection,
} from "../helpers/harness";

let db: IsolationDb;
let schema: SchemaIntrospection;

beforeAll(async () => {
  db = await setupIsolationDb();
  schema = await introspectSchema(db.admin);
});

afterAll(async () => {
  await db?.teardown();
});

describe("RLS is ENABLED and FORCED on every public table (live catalog)", () => {
  it("no table in public escapes RLS enforcement", async () => {
    const res = await db.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`
    );
    expect(res.rows.length).toBe(schema.tables.length);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS must be ENABLED`).toBe(true);
      expect(
        row.relforcerowsecurity,
        `${row.relname}: RLS must be FORCED (owner not exempt)`
      ).toBe(true);
    }
  });
});

describe("every policy is per-command and scoped to `authenticated` only", () => {
  it("no policy is FOR ALL; none targets PUBLIC/anon; all target authenticated", async () => {
    const res = await db.admin.query<{
      table: string;
      polname: string;
      cmd: string;
      roles: string[];
      targets_public: boolean;
    }>(
      `select c.relname as table, p.polname, p.polcmd::text as cmd,
              (select coalesce(array_agg(rr.rolname::text order by rr.rolname::text), array[]::text[])
                 from unnest(p.polroles) as x(oid) join pg_roles rr on rr.oid = x.oid) as roles,
              (0 = any(p.polroles)) as targets_public
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
       order by c.relname, p.polname`
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const r of res.rows) {
      const label = `${r.table}.${r.polname}`;
      expect(r.cmd, `${label}: must be per-command, never FOR ALL ('*')`).not.toBe("*");
      expect(["r", "a", "w", "d"], `${label}: unexpected polcmd`).toContain(r.cmd);
      expect(r.targets_public, `${label}: must NOT target PUBLIC/anon`).toBe(false);
      expect(r.roles, `${label}: must target authenticated only`).toEqual(["authenticated"]);
    }
  });

  it("every table has at least a SELECT policy (no accidentally-invisible table)", async () => {
    const res = await db.admin.query<{ table: string }>(
      `select distinct c.relname as table
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and p.polcmd = 'r'`
    );
    const withSelect = res.rows.map((r) => r.table).sort();
    expect(withSelect).toEqual([...schema.tables]);
  });
});

describe("`anon` has ZERO privileges on tenant data (contract §10)", () => {
  it("anon cannot SELECT/INSERT/UPDATE/DELETE any table", async () => {
    for (const table of schema.tables) {
      const res = await db.admin.query<{
        s: boolean;
        i: boolean;
        u: boolean;
        d: boolean;
      }>(
        `select has_table_privilege('anon'::name, $1::regclass, 'SELECT') as s,
                has_table_privilege('anon'::name, $1::regclass, 'INSERT') as i,
                has_table_privilege('anon'::name, $1::regclass, 'UPDATE') as u,
                has_table_privilege('anon'::name, $1::regclass, 'DELETE') as d`,
        [`public.${table}`]
      );
      const { s, i, u, d } = res.rows[0];
      expect([s, i, u, d], `anon must have no privilege on ${table}`).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });
});

describe("request roles cannot escalate at the role-graph level", () => {
  it("authenticated and anon are neither superuser, BYPASSRLS, nor login roles", async () => {
    const res = await db.admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin
       from pg_roles where rolname in ('authenticated', 'anon') order by rolname`
    );
    expect(res.rows.map((r) => r.rolname)).toEqual(["anon", "authenticated"]);
    for (const r of res.rows) {
      expect(r.rolsuper, `${r.rolname} must NOT be superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} must NOT have BYPASSRLS`).toBe(false);
      expect(r.rolcanlogin, `${r.rolname} must be NOLOGIN (reached only via SET ROLE)`).toBe(false);
    }
  });
});

describe("catalog matches the documented constants — a new table without coverage fails here", () => {
  it("live public tables == ALL_TABLES", () => {
    expect(schema.tables).toEqual([...ALL_TABLES].sort());
  });
  it("live tenant_id tables == TENANT_ID_TABLES", () => {
    expect(schema.tenantIdTables).toEqual([...TENANT_ID_TABLES].sort());
  });
  it("live client_id columns == every viewer-scoped table except `clients` (scopes on id), plus `tenant_users`", () => {
    // The physical client_id column set differs from the semantic
    // CLIENT_SCOPED_TABLES list: `clients` is scoped on its own `id` (no
    // client_id column), while `tenant_users` carries client_id for the
    // viewer's own-membership row without being a "client-scoped" surface.
    const expectedClientIdColumns = [
      ...CLIENT_SCOPED_TABLES.filter((t) => t !== "clients"),
      "tenant_users",
    ].sort();
    expect(schema.clientIdTables).toEqual(expectedClientIdColumns);
  });
});
