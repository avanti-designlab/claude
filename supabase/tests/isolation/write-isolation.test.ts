/**
 * F1 isolation suite — CROSS-TENANT WRITE (doc 03 §7 criterion 2; doc 07 §0.3).
 *
 * Proves the WRITE half: under every role that CAN legitimately write, a caller
 * in tenant B can never (a) INSERT a row homed in tenant A, (b) re-home its own
 * row into tenant A, (c) UPDATE a tenant-A row, or (d) DELETE a tenant-A row.
 * INSERT/UPDATE re-home are rejected outright; UPDATE/DELETE of a foreign row
 * are invisible to the USING clause and touch ZERO rows (never an error that
 * could leak). Positive controls confirm legitimate writes DO succeed, so the
 * rejections above are isolation, not a blanket write failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectQueryRejected,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedTenantPair, type SeededTenant } from "../helpers/seed";
import {
  claimsForRole,
  REJECT_NO_GRANT,
  REJECT_RLS,
  REJECT_WRITE,
  WRITE_SPECS,
} from "./fixtures";
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

async function rowCountOf(
  role: JwtRole,
  sql: string,
  params: unknown[]
): Promise<number> {
  const res = await queryAs(db.admin, "authenticated", claimsForRole(role, b), sql, params);
  return res.rowCount ?? 0;
}

describe("cross-tenant WRITE sweep — a tenant-B writer cannot reach tenant-A data", () => {
  for (const spec of WRITE_SPECS) {
    for (const role of spec.writers) {
      it(`${role} cannot INSERT a tenant-A row into ${spec.table} (RLS WITH CHECK)`, async () => {
        const ins = spec.buildInsert(a); // row homed in tenant A; caller is tenant B
        await expectQueryRejected(
          db.admin,
          "authenticated",
          claimsForRole(role, b),
          ins.text,
          ins.params,
          REJECT_RLS
        );
      });

      it(`${role} cannot re-home its own ${spec.table} row into tenant A`, async () => {
        await expectQueryRejected(
          db.admin,
          "authenticated",
          claimsForRole(role, b),
          `update ${spec.table} set tenant_id = $1 where id = $2`,
          [a.tenantId, spec.ownRowId(b)],
          REJECT_WRITE
        );
      });

      it(`${role} UPDATE of a tenant-A ${spec.table} row touches ZERO rows`, async () => {
        const n = await rowCountOf(
          role,
          `update ${spec.table} set tenant_id = tenant_id where id = $1`,
          [spec.ownRowId(a)]
        );
        expect(n).toBe(0);
      });

      it(`${role} DELETE of a tenant-A ${spec.table} row touches ZERO rows`, async () => {
        const n = await rowCountOf(role, `delete from ${spec.table} where id = $1`, [
          spec.ownRowId(a),
        ]);
        expect(n).toBe(0);
      });
    }
  }
});

describe("tenants root — provisioning is service_role only (no authenticated INSERT/DELETE grant)", () => {
  it("agency_admin cannot INSERT a tenant (no grant — provisioning is service_role)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("agency_admin", b),
      `insert into tenants (name) values ('rogue agency')`,
      undefined,
      REJECT_NO_GRANT
    );
  });

  it("agency_admin cannot DELETE any tenant (no grant)", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("agency_admin", b),
      `delete from tenants where id = $1`,
      [a.tenantId],
      REJECT_NO_GRANT
    );
  });

  it("agency_admin UPDATE of tenant A's row touches ZERO rows", async () => {
    const n = await rowCountOf(
      "agency_admin",
      `update tenants set name = name where id = $1`,
      [a.tenantId]
    );
    expect(n).toBe(0);
  });

  it("agency_admin cannot re-home its own tenant id to collide with tenant A", async () => {
    await expectQueryRejected(
      db.admin,
      "authenticated",
      claimsForRole("agency_admin", b),
      `update tenants set id = $1 where id = $2`,
      [a.tenantId, b.tenantId],
      REJECT_WRITE
    );
  });
});

describe("write positive controls — legitimate in-tenant writes succeed (guards false-green)", () => {
  for (const spec of WRITE_SPECS) {
    const role = spec.writers[0];
    it(`${role} CAN INSERT a valid ${spec.table} row in its own tenant`, async () => {
      const ins = spec.buildInsert(b); // row homed in the caller's own tenant B
      const n = await rowCountOf(role, ins.text, ins.params);
      expect(n).toBe(1);
    });
  }
});
