/**
 * F1 isolation suite — ROLE MATRIX + FORGED/DEGENERATE CLAIMS
 * (doc 03 §2, §4; contract §3, §9).
 *
 * Covers: the operator-vs-agency_admin write split (clients / tenant_users /
 * tenants are admin-only; module tables are admin+operator); `anon` has zero
 * grants and is denied everywhere; platform_owner cannot write through tenant-
 * facing policies; and a battery of forged/degenerate JWT claims — each must
 * fail closed (zero rows or a rejection), never an error that leaks data.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALL_TABLES,
  CLIENT_SCOPED_TABLES,
  expectQueryRejected,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";
import { claimsForRole, REJECT_NO_GRANT, REJECT_RLS } from "./fixtures";
import { randomUUID } from "node:crypto";

let db: IsolationDb;
let b: SeededTenant;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ b } = await seedTenantPair(db.admin));
});

afterAll(async () => {
  await db?.teardown();
});

/** Affected-row count for a write, always executed as the `authenticated`
 *  request role with the given app claims (the app role travels in the JWT). */
async function rowCount(
  claims: Record<string, unknown> | null,
  sql: string,
  params?: unknown[]
): Promise<number> {
  const res = await queryAs(db.admin, "authenticated", claims, sql, params);
  return res.rowCount ?? 0;
}

async function selectCount(
  claims: Record<string, unknown> | null,
  table: string,
  where: string,
  params: unknown[]
): Promise<number> {
  const res = await queryAs<{ n: number }>(
    db.admin,
    "authenticated",
    claims,
    `select count(*)::int as n from ${table} where ${where}`,
    params
  );
  return res.rows[0].n;
}

describe("role matrix — operator is NOT an admin (clients / tenant_users / tenants are admin-only)", () => {
  const adminOnly = ["clients", "tenant_users"] as const;

  for (const table of adminOnly) {
    it(`operator cannot INSERT into ${table} (admin-only surface)`, async () => {
      const text =
        table === "clients"
          ? `insert into clients (tenant_id, name, vertical) values ($1, 'op-made', 'ecommerce')`
          : `insert into tenant_users (tenant_id, auth_user_id, role) values ($1, $2, 'operator')`;
      const params = table === "clients" ? [b.tenantId] : [b.tenantId, randomUUID()];
      await expectQueryRejected(
        db.admin,
        "authenticated",
        claimsForRole("operator", b),
        text,
        params,
        REJECT_RLS
      );
    });

    it(`operator UPDATE of a ${table} row touches ZERO rows (USING requires is_admin)`, async () => {
      const id = table === "clients" ? b.clientId : b.operatorUserId;
      expect(
        await rowCount(
          claimsForRole("operator", b),
          `update ${table} set tenant_id = tenant_id where id = $1`,
          [id]
        )
      ).toBe(0);
    });

    it(`operator DELETE of a ${table} row touches ZERO rows`, async () => {
      const id = table === "clients" ? b.clientId : b.operatorUserId;
      expect(
        await rowCount(
          claimsForRole("operator", b),
          `delete from ${table} where id = $1`,
          [id]
        )
      ).toBe(0);
    });
  }

  it("operator UPDATE of the tenants row touches ZERO rows (theme/billing is admin-only)", async () => {
    expect(
      await rowCount(
        claimsForRole("operator", b),
        `update tenants set name = name where id = $1`,
        [b.tenantId]
      )
    ).toBe(0);
  });

  it("operator cannot INSERT or DELETE a tenant (no grant)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("operator", b),
      `insert into tenants (name) values ('op agency')`,
      undefined,
      REJECT_NO_GRANT
    );
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("operator", b),
      `delete from tenants where id = $1`,
      [b.tenantId],
      REJECT_NO_GRANT
    );
  });

  it("positive: agency_admin CAN write the admin-only surfaces (clients, tenant_users) in its tenant", async () => {
    expect(
      await rowCount(
        claimsForRole("agency_admin", b),
        `insert into clients (tenant_id, name, vertical) values ($1, 'admin-made', 'ecommerce')`,
        [b.tenantId]
      )
    ).toBe(1);
    expect(
      await rowCount(
        claimsForRole("agency_admin", b),
        `insert into tenant_users (tenant_id, auth_user_id, role) values ($1, $2, 'operator')`,
        [b.tenantId, randomUUID()]
      )
    ).toBe(1);
  });

  it("positive: operator CAN write module tables in its tenant (runs modules)", async () => {
    expect(
      await rowCount(
        claimsForRole("operator", b),
        `insert into properties (tenant_id, client_id, type, platform, url) values ($1, $2, 'website', 'wix', 'https://op.example.com')`,
        [b.tenantId, b.clientId]
      )
    ).toBe(1);
  });
});

describe("anon — zero grants, denied on every table and every command", () => {
  for (const table of ALL_TABLES) {
    it(`anon SELECT on ${table} is permission-denied (no grant)`, async () => {
      await expectQueryRejected(
        db.admin,
        "anon",
        null,
        `select * from ${table}`,
        undefined,
        REJECT_NO_GRANT
      );
    });
  }

  it("anon INSERT / UPDATE / DELETE are all permission-denied", async () => {
    for (const sql of [
      `insert into clients (tenant_id, name, vertical) values ($1, 'x', 'ecommerce')`,
      `update clients set name = name where tenant_id = $1`,
      `delete from clients where tenant_id = $1`,
    ]) {
      await expectQueryRejected(db.admin, "anon", null, sql, [b.tenantId], REJECT_NO_GRANT);
    }
  });
});

describe("platform_owner — no writes through tenant-facing policies", () => {
  it("platform_owner INSERT into a module table is rejected (WITH CHECK requires is_writer)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("platform_owner", b),
      `insert into tasks (tenant_id, client_id, plan_id, module) values ($1, $2, $3, 'audit')`,
      [b.tenantId, b.clientId, b.planId],
      REJECT_RLS
    );
  });

  it("platform_owner UPDATE / DELETE of a module row touches ZERO rows", async () => {
    expect(
      await rowCount(
        claimsForRole("platform_owner", b),
        `update tasks set tenant_id = tenant_id where id = $1`,
        [b.taskId]
      )
    ).toBe(0);
    expect(
      await rowCount(
        claimsForRole("platform_owner", b),
        `delete from tasks where id = $1`,
        [b.taskId]
      )
    ).toBe(0);
  });
});

describe("forged / degenerate claims — all fail closed, never leak", () => {
  // Built lazily (inside each test) — `b` is only populated by beforeAll, which
  // runs AFTER the describe body is collected.
  const degenerate: {
    name: string;
    build: () => Record<string, unknown> | null;
  }[] = [
    // The app role lives in `user_role` (migration 0008); RLS ignores the
    // reserved `role` claim. Forge `user_role` — that is the escalation vector.
    { name: "missing tenant_id", build: () => ({ user_role: "operator", sub: b.operatorSub }) },
    { name: "empty claims object", build: () => ({}) },
    { name: "null user_role", build: () => ({ tenant_id: b.tenantId, user_role: null }) },
    {
      name: "unknown user_role string",
      build: () => ({ tenant_id: b.tenantId, user_role: "superadmin" }),
    },
    { name: "null claims (no JWT at all)", build: () => null },
  ];

  for (const { name, build } of degenerate) {
    it(`[${name}] SELECT returns ZERO rows on every table`, async () => {
      const claims = build();
      for (const table of ALL_TABLES) {
        const col = table === "tenants" ? "id" : "tenant_id";
        expect(
          await selectCount(claims, table, `${col} = $1`, [b.tenantId]),
          `${table}: ${name} must see zero rows`
        ).toBe(0);
      }
    });

    it(`[${name}] INSERT into a module table is rejected (fail closed)`, async () => {
      await expectQueryRejected(
        db.admin,
        "authenticated",
        build(),
        `insert into properties (tenant_id, client_id, type, platform, url) values ($1, $2, 'website', 'wix', 'https://x.example.com')`,
        [b.tenantId, b.clientId],
        REJECT_RLS
      );
    });
  }

  it("[wrong-type tenant_id] a non-uuid claim ERRORS on the cast — an error, never a leak", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      { tenant_id: "not-a-uuid", user_role: "operator" },
      `select * from clients`,
      undefined,
      /invalid input syntax for type uuid/
    );
  });

  it("[client_viewer without client_id] sees ZERO rows on every client-scoped table", async () => {
    const claims = { tenant_id: b.tenantId, user_role: "client_viewer", sub: b.viewerSub };
    for (const table of CLIENT_SCOPED_TABLES) {
      const col = table === "clients" ? "id" : "client_id";
      // With no client_id claim, client_scope(row) can never be true.
      expect(
        await selectCount(claims, table, `${col} = $1`, [b.clientId]),
        `${table}: a viewer with no client_id must be scoped to nothing`
      ).toBe(0);
    }
  });

  it("[nonexistent tenant UUID] self-consistent forged tenant reads nothing and cannot INSERT (FK backstop)", async () => {
    const ghostTenant = randomUUID();
    const ghost = { tenant_id: ghostTenant, user_role: "agency_admin", sub: randomUUID() };
    // Reads: the tenant does not exist, so zero rows everywhere.
    expect(await selectCount(ghost, "clients", `tenant_id = $1`, [ghostTenant])).toBe(0);
    // Writes: RLS WITH CHECK passes (claim == row), but the tenant_id FK to the
    // (nonexistent) tenants row is the structural backstop.
    await expectQueryRejected(
      db.admin,
      "authenticated",
      ghost,
      `insert into clients (tenant_id, name, vertical) values ($1, 'ghost', 'ecommerce')`,
      [ghostTenant],
      /foreign key constraint/
    );
  });
});
