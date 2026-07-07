/**
 * F1 isolation suite — CROSS-TENANT READ (doc 03 §7 criterion 2; doc 07 §0.3).
 *
 * The one rule (doc 03): no query may let one tenant see another tenant's data.
 * Here we prove the READ half adversarially: seated as tenant B under EVERY app
 * role, a SELECT can never surface a single tenant-A row — on every one of the
 * 13 tables. Positive controls guard against the false-green where a broken
 * policy returns nothing (which would also pass a naive "0 foreign rows" check).
 * A live-catalog guard sweeps any future table automatically.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_TABLES,
  CLIENT_SCOPED_TABLES,
  introspectSchema,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";
import { APP_ROLES, claimsForRole, tenantColumnOf } from "./fixtures";
import type { JwtRole } from "@/lib/types/db";

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

/** Rows of tenant A visible to a tenant-B caller of the given role. Must be 0. */
async function foreignRowCount(role: JwtRole, table: string): Promise<number> {
  const col = tenantColumnOf(table);
  const res = await queryAs<{ n: number }>(
    db.admin,
    "authenticated",
    claimsForRole(role, b),
    `select count(*)::int as n from ${table} where ${col} = $1`,
    [a.tenantId]
  );
  return res.rows[0].n;
}

/** Rows of the caller's OWN tenant visible to the given role. */
async function ownRowCount(role: JwtRole, table: string): Promise<number> {
  const col = tenantColumnOf(table);
  const res = await queryAs<{ n: number }>(
    db.admin,
    "authenticated",
    claimsForRole(role, b),
    `select count(*)::int as n from ${table} where ${col} = $1`,
    [b.tenantId]
  );
  return res.rows[0].n;
}

describe("cross-tenant READ sweep — every table × every role returns ZERO foreign rows", () => {
  for (const role of APP_ROLES) {
    for (const table of ALL_TABLES) {
      it(`${role} scoped to tenant B cannot see any tenant-A row in ${table}`, async () => {
        expect(await foreignRowCount(role, table)).toBe(0);
      });
    }
  }
});

describe("positive controls — RLS is filtering, not blanket-denying (guards false-green)", () => {
  // agency_admin + operator read the whole tenant: every table has a B row.
  for (const role of ["agency_admin", "operator"] as const) {
    for (const table of ALL_TABLES) {
      it(`${role} DOES see its own tenant's ${table} rows`, async () => {
        expect(await ownRowCount(role, table)).toBeGreaterThanOrEqual(1);
      });
    }
  }

  it("client_viewer sees its own client rows on every client-scoped table", async () => {
    for (const table of CLIENT_SCOPED_TABLES) {
      expect(
        await ownRowCount("client_viewer", table),
        `client_viewer should see its own client's ${table} rows`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("client_viewer sees its own tenant row (white-label theme) and its own membership row", async () => {
    expect(await ownRowCount("client_viewer", "tenants")).toBe(1);
    expect(await ownRowCount("client_viewer", "tenant_users")).toBe(1);
  });
});

describe("platform_owner blindness — ZERO rows through tenant-facing policies (doc 03 §2, contract §9.1)", () => {
  for (const table of ALL_TABLES) {
    it(`platform_owner sees ZERO rows in ${table} — even in its own tenant`, async () => {
      // No foreign rows AND no own rows: the tenant-facing policies never match
      // platform_owner. Platform tooling runs server-side under service_role.
      expect(await foreignRowCount("platform_owner", table)).toBe(0);
      expect(await ownRowCount("platform_owner", table)).toBe(0);
    });
  }
});

describe("catalog-driven guard — no LIVE table escapes the read sweep", () => {
  it("every tenant-owned table in the live catalog denies cross-tenant reads to ALL FOUR roles", async () => {
    const schema = await introspectSchema(db.admin);
    const tenantOwned = [...schema.tenantIdTables, "tenants"];
    // A future migration table is swept here the moment it exists — even before
    // it is added to the ALL_TABLES constant. Defense in depth: sweep under
    // EVERY app role, not just one — a future policy could scope roles
    // differently, and this tripwire must catch the leaky one.
    for (const role of APP_ROLES) {
      for (const table of tenantOwned) {
        expect(
          await foreignRowCount(role, table),
          `${table}: ${role} in tenant B must see ZERO tenant-A rows`
        ).toBe(0);
      }
    }
    // And the documented constant must match the live schema (drift is loud):
    expect([...schema.tables]).toEqual([...ALL_TABLES].sort());
  });
});
