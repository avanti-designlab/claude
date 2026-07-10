/**
 * acknowledge suite — the writer floor, the UUID clamp, and the CAS-on-open
 * acknowledge (acknowledged=false → true, the sanctioned thin loop-closing
 * write). Seams mocked (requireOperator, the Supabase server client); the uuid
 * clamp, the id de-dupe/cap, and the honest 0-row "already acknowledged" mapping
 * run for real.
 *
 * The REAL invariants (tenant scope, writer floor) are enforced by RLS
 * (`alerts_update`) at the database; this suite pins the action's shape + outcome
 * mapping + that it writes ONLY `acknowledged` and CAS-guards on the open state,
 * matching cancel.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireOperatorMock, createClientMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/guards", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/guards")>();
  return { ...actual, requireOperator: requireOperatorMock };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

import { AuthorizationError } from "@/lib/auth/guards";
import { acknowledgeAlert, acknowledgeAlerts } from "./acknowledge";
// The REAL cap the action imports (reads.ts) — no mirrored literal to drift.
import { ACTIVE_ALERTS_MAX } from "./reads";

const OPERATOR = { tenantId: "tenant-1", role: "operator" as const, sub: "auth-user-1" };
const ALERT_ID = "5f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const ALERT_ID_2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** A chainable supabase-js stub: captures the patch + eq filters + in-clause; `select`
 *  is the terminal (the action awaits `.update().eq()...select('id')`). */
function fakeClient(result: { data: unknown; error: unknown }) {
  const captured: {
    patch?: unknown;
    filters: Record<string, unknown>;
    inClause?: { col: string; values: unknown };
  } = { filters: {} };
  const builder: {
    update: (patch: unknown) => typeof builder;
    eq: (col: string, val: unknown) => typeof builder;
    in: (col: string, values: unknown) => typeof builder;
    select: () => Promise<{ data: unknown; error: unknown }>;
  } = {
    update(patch: unknown) {
      captured.patch = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      captured.filters[col] = val;
      return builder;
    },
    in(col: string, values: unknown) {
      captured.inClause = { col, values };
      return builder;
    },
    select: async () => result,
  };
  const client = { from: () => builder };
  return { client, captured };
}

beforeEach(() => {
  // Reset both shared mocks per test so the `not.toHaveBeenCalled` assertions are
  // order-independent (vi.restoreAllMocks does not clear vi.fn call history).
  createClientMock.mockReset();
  requireOperatorMock.mockReset();
  requireOperatorMock.mockResolvedValue(OPERATOR);
});
afterEach(() => vi.restoreAllMocks());

describe("acknowledgeAlert — writer floor", () => {
  it("wrong role → forbidden, never touches the DB", async () => {
    requireOperatorMock.mockRejectedValueOnce(
      new AuthorizationError(["operator", "agency_admin"], "client_viewer")
    );
    const res = await acknowledgeAlert({ alertId: ALERT_ID });
    expect(res).toEqual({ ok: false, reason: "forbidden", error: expect.any(String) });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("acknowledgeAlert — clamp", () => {
  it("a non-uuid alert id → not_found (never reaches Postgres)", async () => {
    const res = await acknowledgeAlert({ alertId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("acknowledgeAlert — CAS on open", () => {
  it("an open row → acknowledged: sets ONLY acknowledged, scoped to tenant + id + open", async () => {
    const { client, captured } = fakeClient({ data: [{ id: ALERT_ID }], error: null });
    createClientMock.mockResolvedValue(client);

    const res = await acknowledgeAlert({ alertId: ALERT_ID });
    expect(res).toEqual({ ok: true });
    // Only `acknowledged` is written (updated_at is the DB trigger's job).
    expect(captured.patch).toEqual({ acknowledged: true });
    // Claim-sourced tenant + id + the open CAS predicate.
    expect(captured.filters).toEqual({
      tenant_id: "tenant-1",
      id: ALERT_ID,
      acknowledged: false,
    });
  });

  it("0 rows (already acknowledged / foreign / gone) → already_acknowledged, no fake success", async () => {
    const { client } = fakeClient({ data: [], error: null });
    createClientMock.mockResolvedValue(client);
    const res = await acknowledgeAlert({ alertId: ALERT_ID });
    expect(res).toMatchObject({ ok: false, reason: "already_acknowledged" });
  });

  it("a DB error → acknowledge_failed (redacted, retryable)", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501" } });
    createClientMock.mockResolvedValue(client);
    const res = await acknowledgeAlert({ alertId: ALERT_ID });
    expect(res).toMatchObject({ ok: false, reason: "acknowledge_failed" });
  });
});

describe("acknowledgeAlerts — bounded sweep", () => {
  it("wrong role → forbidden, never touches the DB", async () => {
    requireOperatorMock.mockRejectedValueOnce(
      new AuthorizationError(["operator", "agency_admin"], "client_viewer")
    );
    const res = await acknowledgeAlerts({ alertIds: [ALERT_ID] });
    expect(res).toEqual({ ok: false, reason: "forbidden", error: expect.any(String) });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("no valid ids → not_found (never reaches Postgres)", async () => {
    const res = await acknowledgeAlerts({ alertIds: ["nope", ""] });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("scopes to tenant + the EXPLICIT id set + open, and reports the flipped count", async () => {
    const { client, captured } = fakeClient({
      data: [{ id: ALERT_ID }, { id: ALERT_ID_2 }],
      error: null,
    });
    createClientMock.mockResolvedValue(client);

    // Duplicate + a garbage id are dropped; only well-formed uuids reach `.in()`.
    const res = await acknowledgeAlerts({
      alertIds: [ALERT_ID, ALERT_ID, ALERT_ID_2, "garbage"],
    });
    expect(res).toEqual({ ok: true, acknowledged: 2 });
    expect(captured.patch).toEqual({ acknowledged: true });
    expect(captured.filters).toMatchObject({ tenant_id: "tenant-1", acknowledged: false });
    expect(captured.inClause).toEqual({ col: "id", values: [ALERT_ID, ALERT_ID_2] });
  });

  it("some ids already acknowledged → honest partial count (0-row subset simply not counted)", async () => {
    const { client } = fakeClient({ data: [{ id: ALERT_ID }], error: null });
    createClientMock.mockResolvedValue(client);
    const res = await acknowledgeAlerts({ alertIds: [ALERT_ID, ALERT_ID_2] });
    expect(res).toEqual({ ok: true, acknowledged: 1 });
  });

  it("caps the id set at ACTIVE_ALERTS_MAX — the feed's read ceiling (never an unbounded IN)", async () => {
    const { client, captured } = fakeClient({ data: [], error: null });
    createClientMock.mockResolvedValue(client);
    // Build MAX + 50 distinct valid uuids.
    const ids = Array.from({ length: ACTIVE_ALERTS_MAX + 50 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return `5f8e2a4b-5c6d-4e7f-8a9b-${hex}`;
    });
    await acknowledgeAlerts({ alertIds: ids });
    const values = captured.inClause?.values as string[];
    expect(values).toHaveLength(ACTIVE_ALERTS_MAX);
  });

  it("a DB error → acknowledge_failed (redacted, retryable)", async () => {
    const { client } = fakeClient({ data: null, error: { code: "42501" } });
    createClientMock.mockResolvedValue(client);
    const res = await acknowledgeAlerts({ alertIds: [ALERT_ID] });
    expect(res).toMatchObject({ ok: false, reason: "acknowledge_failed" });
  });
});
