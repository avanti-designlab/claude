/**
 * Workspace properties seam suite (createProperty / editProperty). Seams mocked
 * (claims, Supabase client); the guards, uuid clamp, the real validator run.
 * Pins: claim-sourced tenant, connection_method pinned 'none' (never a connected
 * value), auth_ref NEVER written, RLS-mirrored auth, and honest not-found.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { createProperty, editProperty } from "./actions";

const { getClaimsMock, createClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PROP_ID = "22222222-2222-4222-8222-222222222222";
const OPERATOR = { tenantId: "t1", role: "operator" as const, sub: "sub-1" };
const VIEWER = { tenantId: "t1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "sub-3" };

function setup(s: FakeScript, claims: unknown = OPERATOR) {
  const fake = fakePostgrest(s);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
});

describe("createProperty", () => {
  it("inserts a website: claim-sourced tenant, connection_method 'none', NEVER auth_ref", async () => {
    const fake = setup({
      clients: { select: { data: { id: CLIENT_ID } } },
      properties: { insert: { data: { id: PROP_ID } } },
    });
    const res = await createProperty({ clientId: CLIENT_ID, url: "https://s.com", platform: "webflow" });
    expect(res).toEqual({ ok: true, property: { id: PROP_ID, url: "https://s.com", platform: "webflow" } });
    const values = fake.inserts[0].values as Record<string, unknown>;
    expect(values).toMatchObject({
      tenant_id: "t1",
      client_id: CLIENT_ID,
      type: "website",
      platform: "webflow",
      url: "https://s.com",
      connection_method: "none",
    });
    expect("auth_ref" in values).toBe(false);
  });

  it("a nonexistent/foreign client is not_found (no insert)", async () => {
    const fake = setup({ clients: { select: { data: null } }, properties: {} });
    expect(await createProperty({ clientId: CLIENT_ID, url: "https://s.com", platform: "wix" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(fake.inserts).toHaveLength(0);
  });

  it("refuses a connected-looking connection_method and a missing platform (invalid_input)", async () => {
    setup({ clients: {}, properties: {} });
    expect((await createProperty({ clientId: CLIENT_ID, url: "https://s.com", platform: "wix", connectionMethod: "api" } as never)).ok).toBe(false);
    setup({ clients: {}, properties: {} });
    expect((await createProperty({ clientId: CLIENT_ID, url: "https://s.com", platform: "nope" } as never)).ok).toBe(false);
  });

  it("a client_viewer is forbidden", async () => {
    setup({ clients: {}, properties: {} }, VIEWER);
    expect(await createProperty({ clientId: CLIENT_ID, url: "https://s.com", platform: "wix" })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });
});

describe("editProperty", () => {
  it("updates url + platform only, tenant- and id-scoped", async () => {
    const fake = setup({ properties: { update: { data: { id: PROP_ID } } } });
    const res = await editProperty({ propertyId: PROP_ID, url: "https://new.com", platform: "nextjs" });
    expect(res).toEqual({ ok: true, property: { id: PROP_ID, url: "https://new.com", platform: "nextjs" } });
    expect(fake.updates[0].values).toEqual({ url: "https://new.com", platform: "nextjs" });
    expect(fake.updates[0].filters).toEqual({ tenant_id: "t1", id: PROP_ID });
  });

  it("a vanished/foreign row is not_found", async () => {
    setup({ properties: { update: { error: { message: "no row", code: "PGRST116" } } } });
    expect(await editProperty({ propertyId: PROP_ID, url: "https://new.com", platform: "wix" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("a client_viewer is forbidden", async () => {
    setup({ properties: {} }, VIEWER);
    expect(await editProperty({ propertyId: PROP_ID, url: "https://new.com", platform: "wix" })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });
});
