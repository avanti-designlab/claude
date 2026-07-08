/**
 * Custom Access Token hook — SECURITY tests (migration 0007) on the live-PG
 * isolation harness. Proves the core property: the tenant claims RLS trusts are
 * minted SOLELY from `tenant_users`, keyed off the authenticated user id, and
 * can NEVER be influenced by client-supplied token contents.
 *
 * What these prove:
 *   1. correct claims per role: the app role is minted into the NON-reserved
 *      `user_role` claim (admin/operator → no client_id; viewer → client_id),
 *      and GoTrue's reserved `role` claim is left as 'authenticated' (migr. 0008);
 *   2. no membership → NO app claims minted (no user_role/tenant_id/client_id);
 *      `role` stays GoTrue's 'authenticated' — untouched (fail closed);
 *   3. the hook DISCARDS any forged tenant_id/user_role/client_id in the input
 *      event and re-derives from tenant_users (a forged token cannot escalate);
 *   4. a client_viewer cannot influence its own tenant_id/user_role/client_id;
 *   5. multi-membership is resolved deterministically;
 *   6. only supabase_auth_admin may execute the hook (authenticated/anon denied);
 *   7. end-to-end: hook-minted claims drive RLS IDENTICALLY to the claims the
 *      existing isolation shim (claimsFor) feeds — the hook's output equals the
 *      shim's input, and passes RLS exactly as the suite expects.
 *
 * Requires local Postgres (supabase/tests/README.md):
 *   ISOLATION_DATABASE_URL or postgresql://postgres:postgres@127.0.0.1:5432/isolation_test
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callAccessTokenHook,
  claimsFor,
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

/** A realistic GoTrue-shaped event: base claims GoTrue would sign for a user. */
function baseEvent(userId: string, extraClaims: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    claims: {
      iss: "https://project.supabase.co/auth/v1",
      sub: userId,
      aud: "authenticated",
      role: "authenticated", // GoTrue's default DB-role claim
      email: "user@example.com",
      exp: 9999999999,
      iat: 1700000000,
      ...extraClaims,
    },
  };
}

describe("mints exactly the right claims from tenant_users", () => {
  it("agency_admin → tenant_id + user_role, role stays authenticated, NO client_id", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.adminSub));
    expect(out.claims.tenant_id).toBe(a.tenantId);
    expect(out.claims.user_role).toBe("agency_admin");
    // GoTrue's reserved DB-role claim is never overwritten by the hook.
    expect(out.claims.role).toBe("authenticated");
    expect(out.claims).not.toHaveProperty("client_id");
  });

  it("operator → tenant_id + user_role, role stays authenticated, NO client_id", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.operatorSub));
    expect(out.claims.tenant_id).toBe(a.tenantId);
    expect(out.claims.user_role).toBe("operator");
    expect(out.claims.role).toBe("authenticated");
    expect(out.claims).not.toHaveProperty("client_id");
  });

  it("client_viewer → tenant_id + user_role + client_id (sourced from tenant_users)", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.viewerSub));
    expect(out.claims.tenant_id).toBe(a.tenantId);
    expect(out.claims.user_role).toBe("client_viewer");
    expect(out.claims.client_id).toBe(a.clientId);
    expect(out.claims.role).toBe("authenticated");
  });

  it("preserves non-app claims (sub, email, iss, reserved role) untouched", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.operatorSub));
    expect(out.claims.sub).toBe(a.operatorSub);
    expect(out.claims.email).toBe("user@example.com");
    expect(out.claims.iss).toBe("https://project.supabase.co/auth/v1");
    expect(out.claims.role).toBe("authenticated"); // PostgREST's DB-role claim
    // and it returns the full event envelope, not a bare claims object
    expect(out.user_id).toBe(a.operatorSub);
  });
});

describe("no membership → mints NO tenant claims (fail closed)", () => {
  it("unknown user → no tenant_id/user_role/client_id, role left 'authenticated'", async () => {
    const ghost = randomUUID();
    const out = await callAccessTokenHook(db.admin, baseEvent(ghost));
    expect(out.claims).not.toHaveProperty("tenant_id");
    expect(out.claims).not.toHaveProperty("client_id");
    // no app role minted at all — not even a base one
    expect(out.claims).not.toHaveProperty("user_role");
    // GoTrue's reserved DB-role claim is untouched (not reset by the hook)
    expect(out.claims.role).toBe("authenticated");
    // identity claims still pass through — they can authenticate, just see nothing
    expect(out.claims.sub).toBe(ghost);
  });
});

describe("CORE — ignores forged input claims and re-derives from tenant_users", () => {
  it("forged tenant_id/user_role/client_id + real operator membership → re-derived, not escalated", async () => {
    const forged = baseEvent(a.operatorSub, {
      tenant_id: b.tenantId, // attacker: point at another tenant
      user_role: "agency_admin", // attacker: escalate the app role
      client_id: randomUUID(), // attacker: inject a scope
    });
    const out = await callAccessTokenHook(db.admin, forged);
    // Re-derived from tenant_users — the forged app claims are all discarded.
    expect(out.claims.tenant_id).toBe(a.tenantId);
    expect(out.claims.user_role).toBe("operator");
    expect(out.claims).not.toHaveProperty("client_id");
    expect(out.claims.role).toBe("authenticated"); // reserved claim untouched
  });

  it("forged tenant_id/user_role/client_id + NO membership → ALL stripped, nothing minted", async () => {
    const forged = baseEvent(randomUUID(), {
      tenant_id: a.tenantId,
      user_role: "agency_admin",
      client_id: a.clientId,
    });
    const out = await callAccessTokenHook(db.admin, forged);
    expect(out.claims).not.toHaveProperty("tenant_id");
    expect(out.claims).not.toHaveProperty("client_id");
    expect(out.claims).not.toHaveProperty("user_role"); // forged admin neutralised
    expect(out.claims.role).toBe("authenticated"); // reserved claim untouched
  });

  it("client_viewer CANNOT influence its own tenant_id/user_role/client_id claim", async () => {
    // The ratified obligation (contract §3): a viewer must never influence its
    // own claim. Forge every app claim; the hook still re-derives from the row.
    const forged = baseEvent(a.viewerSub, {
      tenant_id: b.tenantId,
      user_role: "agency_admin", // try to become an admin
      client_id: b.clientId, // try to scope to another tenant's client
    });
    const out = await callAccessTokenHook(db.admin, forged);
    expect(out.claims.user_role).toBe("client_viewer");
    expect(out.claims.tenant_id).toBe(a.tenantId);
    expect(out.claims.client_id).toBe(a.clientId);
    expect(out.claims.role).toBe("authenticated"); // reserved claim untouched
  });
});

describe("multi-membership is resolved deterministically", () => {
  it("a user in two tenants → oldest membership wins, stable across calls", async () => {
    const multiSub = randomUUID();
    // Same auth user, two tenants; A's membership is strictly older.
    await db.admin.query(
      `insert into tenant_users (tenant_id, auth_user_id, role, created_at)
       values ($1, $2, 'agency_admin', now() - interval '2 days')`,
      [a.tenantId, multiSub]
    );
    await db.admin.query(
      `insert into tenant_users (tenant_id, auth_user_id, role, created_at)
       values ($1, $2, 'operator', now() - interval '1 day')`,
      [b.tenantId, multiSub]
    );

    const first = await callAccessTokenHook(db.admin, baseEvent(multiSub));
    const second = await callAccessTokenHook(db.admin, baseEvent(multiSub));
    // Deterministic: the older (tenant A) membership is chosen both times.
    expect(first.claims.tenant_id).toBe(a.tenantId);
    expect(first.claims.user_role).toBe("agency_admin");
    expect(second.claims.tenant_id).toBe(first.claims.tenant_id);
    expect(second.claims.user_role).toBe(first.claims.user_role);
  });
});

describe("execute is locked to supabase_auth_admin", () => {
  it("authenticated cannot execute the hook (permission denied)", async () => {
    await expect(
      callAccessTokenHook(db.admin, baseEvent(a.operatorSub), {
        as: "authenticated",
      })
    ).rejects.toThrow(/permission denied/);
  });

  it("anon cannot execute the hook (permission denied)", async () => {
    await expect(
      callAccessTokenHook(db.admin, baseEvent(a.operatorSub), { as: "anon" })
    ).rejects.toThrow(/permission denied/);
  });
});

describe("end-to-end — hook-minted claims drive RLS exactly like the shim", () => {
  /** Distinct visible client ids for a claims set, via RLS (SET ROLE authenticated). */
  async function visibleClientIds(
    claims: Record<string, unknown>
  ): Promise<string[]> {
    const res = await queryAs<{ id: string }>(
      db.admin,
      "authenticated",
      claims,
      "select id from clients order by id"
    );
    return res.rows.map((r) => r.id);
  }

  it("operator: hook output equals the shim input, and reads exactly its tenant", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.operatorSub));
    const shim = claimsFor("operator", a.tenantId, { sub: a.operatorSub });

    // The hook's output EQUALS what the isolation shim feeds: same app role in
    // `user_role`, same reserved `role` (authenticated), same tenant.
    expect(out.claims.tenant_id).toBe(shim.tenant_id);
    expect(out.claims.user_role).toBe(shim.user_role);
    expect(out.claims.role).toBe(shim.role); // both 'authenticated'

    // The app.* readers resolve the minted claims correctly.
    const helpers = await queryAs<{ tid: string; role: string; cid: string | null }>(
      db.admin,
      "authenticated",
      out.claims,
      "select app.tenant_id()::text as tid, app.user_role() as role, app.client_id()::text as cid"
    );
    expect(helpers.rows[0]).toEqual({
      tid: a.tenantId,
      role: "operator",
      cid: null,
    });

    // And RLS returns the SAME rows for hook-minted claims and shim claims.
    const viaHook = await visibleClientIds(out.claims);
    const viaShim = await visibleClientIds(shim);
    expect(viaHook).toEqual(viaShim);
    expect(viaHook.length).toBeGreaterThanOrEqual(1);
    expect(viaHook).toContain(a.clientId);
    expect(viaHook).not.toContain(b.clientId); // never another tenant's client
  });

  it("client_viewer: hook-minted claims see only their own client, blind to siblings", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(a.viewerSub));
    const visible = await visibleClientIds(out.claims);
    expect(visible).toEqual([a.clientId]); // exactly its own client
    expect(visible).not.toContain(a.siblingClientId); // sibling client invisible
    expect(visible).not.toContain(b.clientId); // other tenant invisible
  });

  it("no-membership minted claims see ZERO clients (fail closed through RLS)", async () => {
    const out = await callAccessTokenHook(db.admin, baseEvent(randomUUID()));
    const res = await queryAs<{ n: number }>(
      db.admin,
      "authenticated",
      out.claims, // { role: 'authenticated', ... } — no tenant_id
      "select count(*)::int as n from clients"
    );
    expect(res.rows[0].n).toBe(0);
  });
});
