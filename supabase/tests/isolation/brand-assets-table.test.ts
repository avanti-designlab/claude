/**
 * F1 isolation suite — brand_assets STRUCTURAL GATES (migration 0014).
 *
 * These invariants live BELOW RLS: CHECK constraints, the storage_path
 * uniqueness key, the tenant/client PATH-SCOPE check, and the composite FK — all
 * hold even for the superuser (RLS-bypassing) connection. Run as `db.admin`
 * (superuser): RLS is bypassed, so ONLY the structural guards are under test.
 * (The RLS read/write/client_viewer sweeps over brand_assets are the shared
 * catalog-driven suites — read-isolation / write-isolation / client-viewer /
 * posture — which pick it up automatically via ALL_TABLES + CLIENT_SCOPED_TABLES
 * + the brand_assets WRITE_SPEC.)
 *
 * The one that matters most for the storage isolation gate: `storage_path` is
 * structurally forced to begin with the row's OWN tenant_id/client_id, so a row
 * can NEVER point at another tenant's/client's object path — the table-layer
 * half of the defense-in-depth path binding (the other half is the bucket's
 * storage.objects RLS, proven in supabase/tests/storage/).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupIsolationDb, type IsolationDb } from "../helpers/harness";
import {
  seedSiblingClientRows,
  seedTenantPair,
  type SeededTenant,
  type SiblingClientRows,
} from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;
let sibA: SiblingClientRows;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
  sibA = await seedSiblingClientRows(db.admin, a);
});

afterAll(async () => {
  await db?.teardown();
});

async function expectRejected(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await expect(db.admin.query(sql, params)).rejects.toThrow(pattern);
}

/** A valid, tenant/client-scoped object path with a fresh object name. */
function pathFor(t: SeededTenant, name = crypto.randomUUID()): string {
  return `${t.tenantId}/${t.clientId}/${name}.png`;
}

const COLS = `insert into brand_assets (tenant_id, client_id, type, storage_path, content_type, size_bytes`;

describe("brand_assets closed enums + bounds (CHECKs)", () => {
  it("rejects an unknown type", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'wordmark', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_type_allowed/
    );
  });

  it("rejects a content_type outside the raster+svg allowlist", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/tiff', 512)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_content_type_allowed/
    );
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'text/html', 512)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_content_type_allowed/
    );
  });

  it("rejects non-positive and over-cap sizes", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 0)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_size_positive/
    );
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 10485761)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_size_capped/
    );
  });

  it("rejects an over-long label", async () => {
    await expectRejected(
      `${COLS}, label) values ($1, $2, 'icon', $3, 'image/png', 512, repeat('x', 121))`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_label_len/
    );
  });

  it("rejects non-object variants and oversized variants", async () => {
    await expectRejected(
      `${COLS}, variants) values ($1, $2, 'icon', $3, 'image/png', 512, '[1,2,3]'::jsonb)`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_variants_is_object/
    );
    await expectRejected(
      `${COLS}, variants) values ($1, $2, 'icon', $3, 'image/png', 512,
        jsonb_build_object('note', repeat('x', 5000)))`,
      [a.tenantId, a.clientId, pathFor(a)],
      /brand_assets_variants_bounded/
    );
  });
});

describe("brand_assets storage_path is structurally tenant/client-scoped", () => {
  it("rejects a path NOT prefixed with the row's own tenant_id/client_id", async () => {
    // A tenant-A/client-A row whose path claims tenant B's namespace.
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, `${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`],
      /brand_assets_path_scoped/
    );
  });

  it("rejects a path scoped to a SIBLING client of the same tenant", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, `${a.tenantId}/${a.siblingClientId}/${crypto.randomUUID()}.png`],
      /brand_assets_path_scoped/
    );
  });

  it("rejects a '..' traversal suffix even under the correct tenant/client prefix (defense in depth)", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, `${a.tenantId}/${a.clientId}/../${a.clientId}/x.png`],
      /brand_assets_path_scoped/
    );
  });

  it("rejects a deeper-nested path (a further '/') under the correct prefix", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, `${a.tenantId}/${a.clientId}/sub/x.png`],
      /brand_assets_path_scoped/
    );
  });

  it("still ACCEPTS a valid single-segment object path (the CHECK didn't over-tighten)", async () => {
    const res = await db.admin.query(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, `${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`]
    );
    expect(res.rowCount).toBe(1);
  });

  it("rejects a duplicate storage_path (one object → one row)", async () => {
    const path = pathFor(a, "dup-object");
    await db.admin.query(`${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`, [
      a.tenantId,
      a.clientId,
      path,
    ]);
    await expectRejected(
      `${COLS}) values ($1, $2, 'imagery', $3, 'image/png', 512)`,
      [a.tenantId, a.clientId, path],
      /brand_assets_storage_path_key/
    );
  });
});

describe("brand_assets tenant/client consistency (composite FK, even for the superuser)", () => {
  it("cannot point at another TENANT's client", async () => {
    await expectRejected(
      `${COLS}) values ($1, $2, 'icon', $3, 'image/png', 512)`,
      // tenant A, client_id belongs to tenant B, and the path is B-namespaced so
      // the path CHECK passes and the FK is the sole rejection.
      [a.tenantId, b.clientId, `${a.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`],
      /foreign key constraint/
    );
  });

  it("CAN attach to any client of its OWN tenant (sibling client is valid)", async () => {
    const res = await db.admin.query(
      `${COLS}) values ($1, $2, 'imagery', $3, 'image/svg+xml', 1024)`,
      [a.tenantId, a.siblingClientId, `${a.tenantId}/${a.siblingClientId}/${crypto.randomUUID()}.svg`]
    );
    expect(res.rowCount).toBe(1);
    // (guards a false-green in the sibling-path CHECK test above)
    void sibA;
  });
});

describe("brand_assets positives", () => {
  it("accepts a valid asset and allows a soft-delete (archived_at) without dropping the row", async () => {
    const ins = await db.admin.query<{ id: string }>(
      `${COLS}, label, variants) values ($1, $2, 'primary_logo', $3, 'image/png', 4096, 'Logo',
        jsonb_build_object('width', 512, 'height', 512)) returning id`,
      [a.tenantId, a.clientId, pathFor(a)]
    );
    expect(ins.rowCount).toBe(1);
    const id = ins.rows[0].id;

    const archived = await db.admin.query(
      `update brand_assets set archived_at = now() where id = $1`,
      [id]
    );
    expect(archived.rowCount).toBe(1);
    const still = await db.admin.query(`select archived_at from brand_assets where id = $1`, [id]);
    expect(still.rowCount).toBe(1);
    expect(still.rows[0].archived_at).not.toBeNull();
  });

  it("allows many assets per client (distinct object paths)", async () => {
    for (const type of ["secondary_logo", "mono_logo", "favicon", "reversed_logo"]) {
      const res = await db.admin.query(
        `${COLS}) values ($1, $2, '${type}', $3, 'image/webp', 700)`,
        [a.tenantId, a.clientId, pathFor(a)]
      );
      expect(res.rowCount).toBe(1);
    }
  });
});
