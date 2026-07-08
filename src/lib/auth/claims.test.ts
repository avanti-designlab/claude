/**
 * Unit tests for the pure claim parser — the app-layer fail-closed rules that
 * mirror the DB's RLS. No live Postgres: this runs in the default `npm test`.
 * The end-to-end proof that these claims are minted server-side and drive RLS
 * lives in supabase/tests/auth/custom-access-token-hook.pg.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  isJwtRole,
  isStaffRole,
  parseSessionClaims,
} from "@/lib/auth/parse-claims";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const SUB = "33333333-3333-3333-3333-333333333333";

describe("parseSessionClaims — happy paths", () => {
  // The app role arrives in the `user_role` claim (migration 0008); the parsed
  // SessionClaims exposes it as `role` (the app's normalized field).
  it("agency_admin: tenantId + role + sub, no clientId", () => {
    expect(
      parseSessionClaims({ tenant_id: TENANT, user_role: "agency_admin", sub: SUB })
    ).toEqual({ tenantId: TENANT, role: "agency_admin", sub: SUB });
  });

  it("operator: tenantId + role + sub, no clientId", () => {
    expect(
      parseSessionClaims({ tenant_id: TENANT, user_role: "operator", sub: SUB })
    ).toEqual({ tenantId: TENANT, role: "operator", sub: SUB });
  });

  it("client_viewer WITH client_id: carries clientId", () => {
    expect(
      parseSessionClaims({
        tenant_id: TENANT,
        user_role: "client_viewer",
        client_id: CLIENT,
        sub: SUB,
      })
    ).toEqual({
      tenantId: TENANT,
      role: "client_viewer",
      clientId: CLIENT,
      sub: SUB,
    });
  });

  it("ignores extra JWT claims incl. the reserved `role` DB-role claim", () => {
    expect(
      parseSessionClaims({
        tenant_id: TENANT,
        user_role: "operator",
        role: "authenticated", // PostgREST's reserved DB-role claim — must be ignored
        sub: SUB,
        iss: "supabase",
        exp: 9999999999,
        email: "op@example.com",
        user_metadata: { tenant_id: "attacker-tenant" },
      })
    ).toEqual({ tenantId: TENANT, role: "operator", sub: SUB });
  });
});

describe("parseSessionClaims — fail closed", () => {
  it("client_viewer WITHOUT client_id => null (unscoped viewer sees nothing)", () => {
    expect(
      parseSessionClaims({ tenant_id: TENANT, user_role: "client_viewer", sub: SUB })
    ).toBeNull();
  });

  it("client_viewer with empty client_id => null", () => {
    expect(
      parseSessionClaims({
        tenant_id: TENANT,
        user_role: "client_viewer",
        client_id: "",
        sub: SUB,
      })
    ).toBeNull();
  });

  it("missing tenant_id => null", () => {
    expect(parseSessionClaims({ user_role: "operator", sub: SUB })).toBeNull();
  });

  it("empty tenant_id => null", () => {
    expect(
      parseSessionClaims({ tenant_id: "", user_role: "operator", sub: SUB })
    ).toBeNull();
  });

  it("missing sub => null", () => {
    expect(
      parseSessionClaims({ tenant_id: TENANT, user_role: "operator" })
    ).toBeNull();
  });

  it("unknown user_role => null", () => {
    expect(
      parseSessionClaims({ tenant_id: TENANT, user_role: "superadmin", sub: SUB })
    ).toBeNull();
  });

  it("membership-less hook output (no user_role, role='authenticated') => null", () => {
    // No membership => the hook mints NO `user_role` and leaves GoTrue's reserved
    // `role='authenticated'` in place. The parser reads the app role from
    // `user_role` only, so an absent user_role fails closed regardless of `role`.
    expect(
      parseSessionClaims({ tenant_id: TENANT, role: "authenticated", sub: SUB })
    ).toBeNull();
  });

  it("non-string tenant_id => null", () => {
    expect(
      parseSessionClaims({
        tenant_id: 12345 as unknown as string,
        user_role: "operator",
        sub: SUB,
      })
    ).toBeNull();
  });

  it("null / undefined / empty => null", () => {
    expect(parseSessionClaims(null)).toBeNull();
    expect(parseSessionClaims(undefined)).toBeNull();
    expect(parseSessionClaims({})).toBeNull();
  });

  it("non-viewer with a stray client_id => clientId is dropped, not surfaced", () => {
    const parsed = parseSessionClaims({
      tenant_id: TENANT,
      user_role: "agency_admin",
      client_id: CLIENT,
      sub: SUB,
    });
    expect(parsed).toEqual({ tenantId: TENANT, role: "agency_admin", sub: SUB });
    expect(parsed).not.toHaveProperty("clientId");
  });
});

describe("role predicates", () => {
  it("isJwtRole recognises exactly the four app roles", () => {
    for (const r of [
      "platform_owner",
      "agency_admin",
      "operator",
      "client_viewer",
    ]) {
      expect(isJwtRole(r)).toBe(true);
    }
    for (const r of ["authenticated", "anon", "superadmin", "", null, 1]) {
      expect(isJwtRole(r)).toBe(false);
    }
  });

  it("isStaffRole is true only for agency_admin + operator", () => {
    expect(isStaffRole("agency_admin")).toBe(true);
    expect(isStaffRole("operator")).toBe(true);
    expect(isStaffRole("client_viewer")).toBe(false);
    expect(isStaffRole("platform_owner")).toBe(false);
  });
});
