/**
 * STORAGE ISOLATION suite — the brand-assets bucket's storage.objects RLS
 * (Orchestrator ruling, conditions 3 + 4). Storage is a NEW isolation surface,
 * DISTINCT from table RLS: a private bucket whose object paths encode
 * tenant_id/client_id, with a policy that INDEPENDENTLY re-checks the caller's
 * JWT tenant (and, for client_viewer, client) against the path segments — never
 * path obscurity alone.
 *
 * HONEST COVERAGE. The local harness has no Supabase storage-api, so we install
 * a Supabase-EXACT shim of `storage.objects` + `storage.buckets` +
 * `storage.foldername(text)` (byte-for-byte the storage-api definitions) and
 * apply the SAME provisioning file the operator runs
 * (supabase/storage/brand-assets-bucket.sql). We then attack the seeded objects
 * through `queryAs()` — the exact PostgREST execution model — under every app
 * role. This proves the POLICY PREDICATES; what it CANNOT prove (and is flagged
 * as the live-staging canary) is the signed-URL token layer that storage-api
 * owns: URL generation, expiry, and replay/reuse across tenants. Those are
 * `it.todo` below — visible, never silently "covered".
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsFor,
  queryAs,
  setupIsolationDb,
  type IsolationDb,
} from "../helpers/harness";
import { seedSiblingClientRows, seedTenantPair, type SeededTenant } from "../helpers/seed";

const BUCKET_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../storage/brand-assets-bucket.sql"
);

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;

// Seeded object names (paths) inside the brand-assets bucket.
let objA: string; // tenant A, primary client
let objAsib: string; // tenant A, SIBLING client
let objB: string; // tenant B, primary client
const OBJ_NOFOLDER = "loose-object.png"; // no tenant/client segments — must be invisible to all

/**
 * Supabase-EXACT storage shim. Mirrors storage-api's own DDL: storage.objects,
 * storage.buckets, and storage.foldername() (path parts MINUS the filename). RLS
 * is enabled + FORCED and grants go to `authenticated` — exactly the real
 * bucket's app-facing surface. Installed ONLY by this test; migrations/harness
 * never create the storage schema (Supabase provides it).
 */
async function installStorageShim(client: IsolationDb["admin"]): Promise<void> {
  await client.query(`
    create schema if not exists storage;

    create table storage.buckets (
      id                 text primary key,
      name               text not null,
      public             boolean not null default false,
      file_size_limit    bigint,
      allowed_mime_types text[],
      created_at         timestamptz not null default now()
    );

    create table storage.objects (
      id         uuid primary key default gen_random_uuid(),
      bucket_id  text references storage.buckets (id),
      name       text,
      owner      uuid,
      metadata   jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    -- storage-api's definition: the folder segments, i.e. every "/"-part except
    -- the final filename. For "t/c/x.png" => {t, c}; for "loose.png" => {}.
    create or replace function storage.foldername(name text) returns text[]
    language plpgsql
    as $$
    declare _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1 : array_length(_parts, 1) - 1];
    end
    $$;

    grant usage on schema storage to authenticated, anon;
    grant execute on function storage.foldername(text) to authenticated, anon;
    grant select, insert, update, delete on storage.objects to authenticated;

    alter table storage.objects enable row level security;
    alter table storage.objects force row level security;
  `);
}

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
  await seedSiblingClientRows(db.admin, a);

  await installStorageShim(db.admin);
  await db.admin.query(await readFile(BUCKET_SQL, "utf8"));

  objA = `${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`;
  objAsib = `${a.tenantId}/${a.siblingClientId}/${crypto.randomUUID()}.svg`;
  objB = `${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`;

  // Seed objects as the superuser (bypasses RLS — like a service-role write).
  for (const name of [objA, objAsib, objB, OBJ_NOFOLDER]) {
    await db.admin.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('brand-assets', $1, '{"size":1024,"mimetype":"image/png"}')`,
      [name]
    );
  }
});

afterAll(async () => {
  await db?.teardown();
});

/** Count objects VISIBLE to `claims` whose name = `name` (the storage read policy). */
async function visibleCount(
  claims: Record<string, unknown>,
  name: string
): Promise<number> {
  const res = await queryAs<{ n: number }>(
    db.admin,
    "authenticated",
    claims,
    `select count(*)::int as n from storage.objects where bucket_id = 'brand-assets' and name = $1`,
    [name]
  );
  return res.rows[0].n;
}

const operatorA = () => claimsFor("operator", a.tenantId, { sub: a.operatorSub });
const operatorB = () => claimsFor("operator", b.tenantId, { sub: b.operatorSub });
const viewerA = () =>
  claimsFor("client_viewer", a.tenantId, { clientId: a.clientId, sub: a.viewerSub });

describe("bucket is PRIVATE", () => {
  it("brand-assets bucket has public=false and the raster+svg MIME/size limits", async () => {
    const res = await db.admin.query<{
      public: boolean;
      file_size_limit: string | number;
      allowed_mime_types: string[];
    }>(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'brand-assets'`);
    expect(res.rows[0].public).toBe(false);
    expect(Number(res.rows[0].file_size_limit)).toBe(10485760);
    expect(res.rows[0].allowed_mime_types).toContain("image/svg+xml");
    expect(res.rows[0].allowed_mime_types).not.toContain("text/html");
  });
});

describe("storage READ policy — tenant path segment is independently enforced", () => {
  it("a tenant-A writer CAN read its own object (positive control)", async () => {
    expect(await visibleCount(operatorA(), objA)).toBe(1);
  });

  it("a tenant-B writer canNOT read a tenant-A object — even with the EXACT (guessed/enumerated) path", async () => {
    expect(await visibleCount(operatorB(), objA)).toBe(0);
    expect(await visibleCount(operatorB(), objAsib)).toBe(0);
  });

  it("a tenant-B writer sees ZERO tenant-A objects in a blanket scan", async () => {
    const res = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      operatorB(),
      `select count(*)::int as n from storage.objects where name like $1`,
      [`${a.tenantId}/%`]
    );
    expect(res.rows[0].n).toBe(0);
  });

  it("path TRAVERSAL cannot re-home an object into another tenant (segments are LITERAL, never resolved)", async () => {
    // An object whose name visually contains tenant A's namespace deeper in the
    // path but whose LITERAL first segment is tenant B. storage.foldername keys
    // off the literal first segment (no "../" resolution), so a tenant-A caller
    // is DENIED — the traversal buys the attacker nothing across the boundary.
    // (Tenant B "sees" it because it literally lives in B's own namespace and
    // could only have been created by a B writer — not a leak, just B's object.)
    const traversal = `${b.tenantId}/../${a.tenantId}/${a.clientId}/evil.png`;
    await db.admin.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('brand-assets', $1, '{}')`,
      [traversal]
    );
    expect(await visibleCount(operatorA(), traversal)).toBe(0); // no cross-boundary reach
    expect(await visibleCount(operatorB(), traversal)).toBe(1); // literal-first-segment = B
  });

  it("an object with NO tenant/client folders (short path) is invisible to everyone (fail closed)", async () => {
    expect(await visibleCount(operatorA(), OBJ_NOFOLDER)).toBe(0);
    expect(await visibleCount(operatorB(), OBJ_NOFOLDER)).toBe(0);
    expect(await visibleCount(viewerA(), OBJ_NOFOLDER)).toBe(0);
  });
});

describe("storage READ policy — client_viewer is pinned to its own client's folder", () => {
  it("a client_viewer CAN read its OWN client's object", async () => {
    expect(await visibleCount(viewerA(), objA)).toBe(1);
  });

  it("a client_viewer is BLIND to a SIBLING client's object (same tenant, other client)", async () => {
    expect(await visibleCount(viewerA(), objAsib)).toBe(0);
  });

  it("a client_viewer canNOT read another tenant's object", async () => {
    expect(await visibleCount(viewerA(), objB)).toBe(0);
  });
});

describe("storage WRITE policy — is_writer + own-tenant path only", () => {
  it("a tenant-B writer canNOT INSERT an object into tenant A's namespace (RLS WITH CHECK)", async () => {
    await expect(
      queryAs(
        db.admin,
        "authenticated",
        operatorB(),
        `insert into storage.objects (bucket_id, name) values ('brand-assets', $1)`,
        [`${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`]
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a tenant-B writer CAN INSERT into its OWN namespace (positive control)", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      operatorB(),
      `insert into storage.objects (bucket_id, name) values ('brand-assets', $1)`,
      [`${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`]
    );
    expect(res.rowCount).toBe(1);
  });

  it("a client_viewer canNOT INSERT anywhere (read-only; no write policy matches it)", async () => {
    await expect(
      queryAs(
        db.admin,
        "authenticated",
        viewerA(),
        `insert into storage.objects (bucket_id, name) values ('brand-assets', $1)`,
        [`${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`]
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a tenant-B writer's DELETE of a tenant-A object touches ZERO rows", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      operatorB(),
      `delete from storage.objects where name = $1`,
      [objA]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });

  it("a client_viewer's DELETE of its OWN client's object touches ZERO rows (no delete policy)", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      viewerA(),
      `delete from storage.objects where name = $1`,
      [objA]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });
});

describe("platform_owner blindness on storage (mirrors table RLS, doc 03 §2)", () => {
  it("platform_owner sees ZERO objects — even in its own tenant's namespace", async () => {
    const claims = claimsFor("platform_owner", a.tenantId, { sub: a.adminSub });
    expect(await visibleCount(claims, objA)).toBe(0);
  });
});

/* ============================================================================
 * QA GATE EXTENSION (qa-testing, 2026-07-10) — additional adversarial vectors
 * on the storage.objects RLS surface, pushing past the architect's suite:
 *   - UPDATE / re-home: a rename across the tenant boundary (WITH CHECK) — a
 *     vector the architect's suite did not exercise at all;
 *   - segment EQUALITY vs string-prefix (tenant `abc` vs `abcd`, client `cl`
 *     vs `cl9`) — a LIKE/prefix policy would leak; `=` must not;
 *   - malformed / encoded paths (leading-slash, double-slash, empty, NULL)
 *     fail CLOSED;
 *   - client_viewer + deeper-path traversal: the LITERAL seg2 governs and the
 *     viewer still cannot reach the REAL sibling object;
 *   - anon lockout; platform_owner WRITE denial (write side, not just read);
 *   - policies are scoped to the brand-assets bucket only;
 *   - a WRITER legitimately sees the whole tenant (seg1 only) — the intended
 *     complement to the viewer's seg1-AND-seg2 pin.
 * ========================================================================== */

/** Seed one object as the superuser (service-role-analog; bypasses RLS). */
async function seedObject(name: string | null, bucket = "brand-assets"): Promise<void> {
  await db.admin.query(
    `insert into storage.objects (bucket_id, name, metadata) values ($1, $2, '{"size":1024,"mimetype":"image/png"}')`,
    [bucket, name]
  );
}

describe("storage UPDATE policy — no cross-tenant reach, no rename across the boundary", () => {
  it("a tenant-B writer's UPDATE of a tenant-A object touches ZERO rows (USING filters it out)", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      operatorB(),
      `update storage.objects set updated_at = now() where name = $1`,
      [objA]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });

  it("a tenant-B writer canNOT RENAME its OWN object into tenant A's namespace (WITH CHECK denies the re-home)", async () => {
    const own = `${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`;
    await seedObject(own);
    await expect(
      queryAs(
        db.admin,
        "authenticated",
        operatorB(),
        `update storage.objects set name = $1 where name = $2`,
        [`${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`, own]
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a tenant-B writer CAN rename WITHIN its own tenant (positive control — proves the deny above is isolation, not a blanket UPDATE failure)", async () => {
    const own = `${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`;
    await seedObject(own);
    const res = await queryAs(
      db.admin,
      "authenticated",
      operatorB(),
      `update storage.objects set name = $1 where name = $2`,
      [`${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`, own]
    );
    expect(res.rowCount).toBe(1);
  });

  it("a client_viewer's UPDATE of its OWN client's object touches ZERO rows (no update policy matches a viewer)", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      viewerA(),
      `update storage.objects set updated_at = now() where name = $1`,
      [objA]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });
});

describe("storage READ — the tenant segment is matched by EQUALITY, never string-prefix", () => {
  // The policy compares the RAW text claim (auth.jwt() ->> 'tenant_id') to the
  // literal path segment — no uuid cast, deliberately (a hostile path must
  // MISMATCH, never cast-error). So we can attack with adversarial prefix /
  // superstring tenant tokens. An object under tenant "abc" must be INVISIBLE
  // to a caller whose tenant is the prefix "ab" or the superstring "abcd".
  const objAbc = "abc/cl/obj.png";
  const objAbcd = "abcd/cl/obj.png";
  const writerOfTenant = (tenant: string) =>
    claimsFor("operator", tenant, { sub: crypto.randomUUID() });

  it("prefix/superstring tenants cannot read a sibling tenant's object (segment equality, not LIKE-prefix)", async () => {
    await seedObject(objAbc);
    await seedObject(objAbcd);
    // caller "abc" sees ONLY abc's object (NOT the superstring "abcd/..." one)
    expect(await visibleCount(writerOfTenant("abc"), objAbc)).toBe(1);
    expect(await visibleCount(writerOfTenant("abc"), objAbcd)).toBe(0);
    // reverse direction: caller "abcd" sees ONLY abcd's object
    expect(await visibleCount(writerOfTenant("abcd"), objAbcd)).toBe(1);
    expect(await visibleCount(writerOfTenant("abcd"), objAbc)).toBe(0);
    // shorter prefix "ab" sees NEITHER
    expect(await visibleCount(writerOfTenant("ab"), objAbc)).toBe(0);
    expect(await visibleCount(writerOfTenant("ab"), objAbcd)).toBe(0);
  });

  it("a client_viewer's CLIENT segment is matched by equality, not prefix (`cl` must not see `cl9`)", async () => {
    const t = "seg2tenant";
    const objCl = `${t}/cl/obj.png`;
    const objCl9 = `${t}/cl9/obj.png`;
    await seedObject(objCl);
    await seedObject(objCl9);
    const viewer = claimsFor("client_viewer", t, { clientId: "cl", sub: crypto.randomUUID() });
    expect(await visibleCount(viewer, objCl)).toBe(1);
    expect(await visibleCount(viewer, objCl9)).toBe(0);
  });
});

describe("storage READ — malformed / encoded paths fail CLOSED", () => {
  it("a LEADING-slash path (empty first segment) is invisible to everyone", async () => {
    const name = `/${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`; // seg1 = ''
    await seedObject(name);
    expect(await visibleCount(operatorA(), name)).toBe(0);
    expect(await visibleCount(operatorB(), name)).toBe(0);
    expect(await visibleCount(viewerA(), name)).toBe(0);
  });

  it("a DOUBLE-slash path (empty client segment) is invisible to the client_viewer (seg2 empty) and to a foreign tenant", async () => {
    const name = `${a.tenantId}//${a.clientId}/${crypto.randomUUID()}.png`; // seg2 = ''
    await seedObject(name);
    expect(await visibleCount(viewerA(), name)).toBe(0); // seg2 '' != own client_id
    expect(await visibleCount(operatorB(), name)).toBe(0); // seg1 is tenant A → B blind
  });

  it("a URL-ENCODED traversal (`%2e%2e`) is treated as literal text — no decoding, no cross-tenant escape", async () => {
    // The path textually embeds tenant B's namespace deeper, behind an encoded
    // '..' segment. Segments are LITERAL (never url-decoded, never '../'-
    // resolved), so seg1 is tenant A: a tenant-B caller is DENIED, and the
    // object only lives in A's own namespace.
    const encoded = `${a.tenantId}/%2e%2e/${b.tenantId}/${b.clientId}/${crypto.randomUUID()}.png`;
    await seedObject(encoded);
    expect(await visibleCount(operatorB(), encoded)).toBe(0); // no escape into B
    expect(await visibleCount(operatorA(), encoded)).toBe(1); // literal seg1 = A
  });

  it("an EMPTY-string name and a NULL name are invisible to everyone (foldername → NULL → fail closed)", async () => {
    await seedObject("");
    await seedObject(null);
    expect(await visibleCount(operatorA(), "")).toBe(0);
    const nulls = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      operatorA(),
      `select count(*)::int as n from storage.objects where bucket_id = 'brand-assets' and name is null`
    );
    expect(nulls.rows[0].n).toBe(0);
  });
});

describe("storage READ — client_viewer + traversal: the LITERAL seg2 governs, no reach to the REAL sibling", () => {
  it("a deeper-path traversal referencing the sibling does NOT let the viewer reach the sibling's real object", async () => {
    // An object a tenant-A WRITER placed at a weird literal path: seg2 is the
    // viewer's OWN client, but deeper segments name the sibling. storage keys off
    // the LITERAL seg2 (no '../' resolution), so the viewer sees THIS literal
    // object — while the sibling's REAL object (objAsib) stays invisible.
    const crafted = `${a.tenantId}/${a.clientId}/../${a.siblingClientId}/${crypto.randomUUID()}.png`;
    await seedObject(crafted);
    expect(await visibleCount(viewerA(), crafted)).toBe(1); // literal seg2 == own client
    expect(await visibleCount(viewerA(), objAsib)).toBe(0); // real sibling object: still blind
  });
});

describe("storage — anon has ZERO access (no table grant; every policy targets authenticated only)", () => {
  it("anon cannot SELECT storage.objects (permission denied at the grant layer)", async () => {
    await expect(
      queryAs(db.admin, "anon", null, `select count(*) from storage.objects`)
    ).rejects.toThrow(/permission denied/);
  });

  it("anon cannot INSERT into storage.objects (permission denied)", async () => {
    await expect(
      queryAs(
        db.admin,
        "anon",
        null,
        `insert into storage.objects (bucket_id, name) values ('brand-assets', $1)`,
        [`${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`]
      )
    ).rejects.toThrow(/permission denied/);
  });
});

describe("storage WRITE — platform_owner cannot write (is_writer() is false for it)", () => {
  const owner = () => claimsFor("platform_owner", a.tenantId, { sub: a.adminSub });

  it("platform_owner canNOT INSERT even into its OWN tenant's namespace (WITH CHECK)", async () => {
    await expect(
      queryAs(
        db.admin,
        "authenticated",
        owner(),
        `insert into storage.objects (bucket_id, name) values ('brand-assets', $1)`,
        [`${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`]
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("platform_owner DELETE of a real object touches ZERO rows", async () => {
    const res = await queryAs(
      db.admin,
      "authenticated",
      owner(),
      `delete from storage.objects where name = $1`,
      [objA]
    );
    expect(res.rowCount ?? 0).toBe(0);
  });
});

describe("storage — the brand-assets policies are scoped to that bucket only", () => {
  it("an identically-pathed object in a DIFFERENT bucket is invisible even to a same-tenant writer", async () => {
    await db.admin.query(
      `insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false) on conflict (id) do nothing`
    );
    const name = `${a.tenantId}/${a.clientId}/${crypto.randomUUID()}.png`;
    await seedObject(name, "other-bucket");
    // No policy grants 'other-bucket'; RLS is forced ⇒ invisible. (operatorA CAN
    // see objA in brand-assets — proven above — so this is scoping, not deny-all.)
    const res = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      operatorA(),
      `select count(*)::int as n from storage.objects where name = $1`,
      [name]
    );
    expect(res.rows[0].n).toBe(0);
  });
});

describe("storage READ — a WRITER sees the whole tenant (seg1 only), unlike a viewer (seg1 AND seg2)", () => {
  it("a tenant-A writer CAN read a SIBLING client's object — writer scope is tenant-wide (doc 03 §2)", async () => {
    // Complements the architect's cross-tenant deny (operatorB sees objAsib = 0):
    // the sibling-BLINDNESS that matters is the VIEWER's; a writer legitimately
    // manages every client in its own tenant.
    expect(await visibleCount(operatorA(), objAsib)).toBe(1);
  });
});

/* ---- LIVE-STAGING CANARY (storage-api token layer — not a DB policy) ---- */
describe("signed-URL token layer — requires the live-staging canary", () => {
  // These behaviors are owned by storage-api (token minting/verification), NOT
  // by the storage.objects policies, so they cannot be exercised against the
  // DB-only shim. The AUTHORITATIVE 6-item pre-ship checklist lives in
  // docs/ops/environments.md ("Live-staging canary"); the three markers below
  // are the token-layer subset.
  it.todo("a signed READ URL for a tenant-A object is unusable by a tenant-B caller (no cross-tenant reuse)");
  it.todo("an EXPIRED signed URL is rejected (TTL enforced by storage-api)");
  it.todo("a signed UPLOAD token is single-use and cannot be replayed to overwrite another path");
});
