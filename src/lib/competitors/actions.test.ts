/**
 * Competitors action suite. Seams mocked (claims, Supabase client); the guards,
 * uuid clamp, the real validator, and the real cap logic run. Pins the
 * app-enforced per-client cap of 10 (a CHECK can't count), duplicate/foreign
 * handling, claim-sourced tenant, and RLS-mirrored auth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import {
  addCompetitor,
  listCompetitors,
  removeCompetitor,
} from "./actions";
import { COMPETITORS_PER_CLIENT_CAP } from "./validate";

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
const COMP_ID = "33333333-3333-4333-8333-333333333333";
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

describe("addCompetitor — per-client cap of 10 (app-enforced)", () => {
  const capRows = Array.from({ length: COMPETITORS_PER_CLIENT_CAP }, (_, i) => ({ id: `c${i}` }));

  it("refuses at the cap and does NOT insert", async () => {
    const fake = setup({
      competitors: { select: { data: capRows }, insert: { data: { id: COMP_ID, name: "X", domain: null } } },
    });
    const res = await addCompetitor({ clientId: CLIENT_ID, name: "Eleventh" });
    expect(res).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(fake.inserts).toHaveLength(0);
  });

  it("inserts when under the cap (claim-sourced tenant, trimmed name, null domain)", async () => {
    const fake = setup({
      competitors: {
        select: { data: capRows.slice(0, 9) },
        insert: { data: { id: COMP_ID, name: "Rival", domain: null } },
      },
    });
    const res = await addCompetitor({ clientId: CLIENT_ID, name: "  Rival  " });
    expect(res).toEqual({ ok: true, competitor: { id: COMP_ID, name: "Rival", domain: null } });
    expect(fake.inserts[0].values).toMatchObject({
      tenant_id: "t1",
      client_id: CLIENT_ID,
      name: "Rival",
      domain: null,
    });
  });

  it("maps a duplicate-name unique violation (23505) to a duplicate reason", async () => {
    setup({
      competitors: { select: { data: [] }, insert: { error: { message: "dup", code: "23505" } } },
    });
    expect(await addCompetitor({ clientId: CLIENT_ID, name: "Rival" })).toMatchObject({
      ok: false,
      reason: "duplicate",
    });
  });

  it("maps a foreign/absent client (composite FK 23503) to not_found", async () => {
    setup({
      competitors: { select: { data: [] }, insert: { error: { message: "fk", code: "23503" } } },
    });
    expect(await addCompetitor({ clientId: CLIENT_ID, name: "Rival" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("refuses a bad clientId (not_found) and a bad name (invalid_input) before any DB call", async () => {
    setup({ competitors: {} });
    expect((await addCompetitor({ clientId: "nope", name: "Rival" })).ok).toBe(false);
    setup({ competitors: { select: { data: [] } } });
    expect(await addCompetitor({ clientId: CLIENT_ID, name: "" })).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("a client_viewer is forbidden from writing", async () => {
    setup({ competitors: {} }, VIEWER);
    expect(await addCompetitor({ clientId: CLIENT_ID, name: "Rival" })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });
});

describe("listCompetitors / removeCompetitor", () => {
  it("lists a client's competitors (RLS-scoped read)", async () => {
    setup({
      competitors: {
        select: { data: [{ id: COMP_ID, name: "Rival", domain: "rival.com" }] },
      },
    });
    const res = await listCompetitors({ clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true, competitors: [{ id: COMP_ID, name: "Rival", domain: "rival.com" }] });
  });

  it("removes a competitor; a nonexistent/foreign id is not_found (zero deleted)", async () => {
    setup({ competitors: { delete: { data: [{ id: COMP_ID }] } } });
    expect(await removeCompetitor({ competitorId: COMP_ID })).toEqual({ ok: true });

    setup({ competitors: { delete: { data: [] } } });
    expect(await removeCompetitor({ competitorId: COMP_ID })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("a client_viewer is forbidden from removing", async () => {
    setup({ competitors: {} }, VIEWER);
    expect(await removeCompetitor({ competitorId: COMP_ID })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });
});
