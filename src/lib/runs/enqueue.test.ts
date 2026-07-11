/**
 * enqueueRun suite — the writer floor, the A5 refuse-at-enqueue rules, and the
 * claim-sourced tenant-scoped insert + non-blocking kick. Seams mocked
 * (requireOperator, the Supabase server client, the kick); the uuid clamp,
 * kind gating, and crawlability pre-check run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireOperatorMock, createClientMock, kickMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(),
  createClientMock: vi.fn(),
  kickMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/guards", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/guards")>();
  return { ...actual, requireOperator: requireOperatorMock };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./kick", () => ({ kickProcessor: kickMock }));

import { AuthorizationError } from "@/lib/auth/guards";
import { enqueueRun } from "./enqueue";

const OPERATOR = { tenantId: "tenant-1", role: "operator" as const, sub: "auth-user-1" };
const PROPERTY_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";

type Result = { data: unknown; error: unknown };

/** A chainable supabase-js stub: per-table terminal results + captured insert +
 *  captured update. The update chain (.update().eq().eq()) is awaited directly,
 *  so the builder is thenable. */
function fakeClient(config: Record<string, Result>) {
  const captured: Record<string, { row?: unknown; update?: unknown }> = {};
  const client = {
    from(table: string) {
      captured[table] = captured[table] ?? {};
      const builder = {
        select: () => builder,
        eq: () => builder,
        insert: (row: unknown) => {
          captured[table].row = row;
          return builder;
        },
        update: (row: unknown) => {
          captured[table].update = row;
          return builder;
        },
        maybeSingle: async () => config[table],
        single: async () => config[table],
        then: (resolve: (v: Result) => void) => resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
  return { client, captured };
}

beforeEach(() => {
  requireOperatorMock.mockResolvedValue(OPERATOR);
  kickMock.mockReset();
  createClientMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("enqueueRun — writer floor", () => {
  it("wrong role → forbidden, no insert, no kick", async () => {
    requireOperatorMock.mockRejectedValueOnce(new AuthorizationError(["operator", "agency_admin"], "client_viewer"));
    const res = await enqueueRun({ kind: "audit", propertyId: PROPERTY_ID });
    expect(res).toEqual({ ok: false, reason: "forbidden", error: expect.any(String) });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(kickMock).not.toHaveBeenCalled();
  });
});

describe("enqueueRun — A5 refuse-at-enqueue (no queued-forever / doomed rows)", () => {
  it("visibility is vendor-gated → vendor_unavailable, no row", async () => {
    const res = await enqueueRun({ kind: "visibility" });
    expect(res).toMatchObject({ ok: false, reason: "vendor_unavailable" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("other vendor-free kinds not yet executable → unsupported_kind, no row", async () => {
    for (const kind of ["monitor", "decay", "local", "entity"] as const) {
      const res = await enqueueRun({ kind });
      expect(res).toMatchObject({ ok: false, reason: "unsupported_kind" });
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a non-uuid property → not_found (never reaches Postgres)", async () => {
    const res = await enqueueRun({ kind: "audit", propertyId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a non-website / non-crawlable property → not_crawlable, no run row", async () => {
    const { client, captured } = fakeClient({
      properties: { data: { id: PROPERTY_ID, client_id: CLIENT_ID, type: "gbp", url: "https://x.example" }, error: null },
    });
    createClientMock.mockResolvedValue(client);
    const res = await enqueueRun({ kind: "audit", propertyId: PROPERTY_ID });
    expect(res).toMatchObject({ ok: false, reason: "not_crawlable" });
    expect(captured.runs).toBeUndefined();
    expect(kickMock).not.toHaveBeenCalled();
  });

  it("an RLS-empty property read → not_found (another tenant's id looks the same)", async () => {
    const { client } = fakeClient({ properties: { data: null, error: null } });
    createClientMock.mockResolvedValue(client);
    const res = await enqueueRun({ kind: "audit", propertyId: PROPERTY_ID });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("enqueueRun — happy path", () => {
  it("inserts a claim-sourced, tenant-scoped queued run and fires the kick", async () => {
    const { client, captured } = fakeClient({
      properties: { data: { id: PROPERTY_ID, client_id: CLIENT_ID, type: "website", url: "https://gg.example" }, error: null },
      tenant_users: { data: { id: "tu-1" }, error: null },
      runs: { data: { id: "run-1" }, error: null },
    });
    createClientMock.mockResolvedValue(client);

    const res = await enqueueRun({ kind: "audit", propertyId: PROPERTY_ID });
    expect(res).toEqual({ ok: true, runId: "run-1" });

    // Tenant is CLAIM-SOURCED, client from the RLS property read, requested_by
    // resolved to the operator's tenant_users.id.
    expect(captured.runs.row).toEqual({
      tenant_id: "tenant-1",
      client_id: CLIENT_ID,
      property_id: PROPERTY_ID,
      kind: "audit",
      status: "queued",
      requested_by: "tu-1",
    });
    expect(kickMock).toHaveBeenCalledWith("process");
  });

  it("a failed insert → enqueue_failed (no fake success)", async () => {
    const { client } = fakeClient({
      properties: { data: { id: PROPERTY_ID, client_id: CLIENT_ID, type: "website", url: "https://gg.example" }, error: null },
      tenant_users: { data: { id: "tu-1" }, error: null },
      runs: { data: null, error: { code: "23503" } },
    });
    createClientMock.mockResolvedValue(client);
    const res = await enqueueRun({ kind: "audit", propertyId: PROPERTY_ID });
    expect(res).toMatchObject({ ok: false, reason: "enqueue_failed" });
    expect(kickMock).not.toHaveBeenCalled();
  });
});

describe("enqueueRun — brand_extract (client-scoped paste-URL path)", () => {
  const HOME = "https://client-site.example/";

  it("a non-uuid clientId → not_found (never reaches Postgres)", async () => {
    const res = await enqueueRun({ kind: "brand_extract", clientId: "nope", url: HOME });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a non-http(s) / blocked-literal / empty URL → invalid_url (shape check, no Postgres)", async () => {
    for (const url of ["", "ftp://x.example", "http://127.0.0.1/", "not-a-url", "http://localhost/"]) {
      const res = await enqueueRun({ kind: "brand_extract", clientId: CLIENT_ID, url });
      expect(res, url).toMatchObject({ ok: false, reason: "invalid_url" });
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("an RLS-empty client read → not_found (another tenant's client id looks the same)", async () => {
    const { client } = fakeClient({ clients: { data: null, error: null } });
    createClientMock.mockResolvedValue(client);
    const res = await enqueueRun({ kind: "brand_extract", clientId: CLIENT_ID, url: HOME });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(kickMock).not.toHaveBeenCalled();
  });

  it("happy path: inserts a client-scoped run carrying input_url, supersedes prior proposed drafts, kicks", async () => {
    const { client, captured } = fakeClient({
      clients: { data: { id: CLIENT_ID }, error: null },
      tenant_users: { data: { id: "tu-1" }, error: null },
      runs: { data: { id: "run-be-1" }, error: null },
    });
    createClientMock.mockResolvedValue(client);

    const res = await enqueueRun({ kind: "brand_extract", clientId: CLIENT_ID, url: HOME });
    expect(res).toEqual({ ok: true, runId: "run-be-1" });

    // Tenant CLAIM-SOURCED; property_id NULL; the pasted URL rides input_url.
    expect(captured.runs.row).toEqual({
      tenant_id: "tenant-1",
      client_id: CLIENT_ID,
      property_id: null,
      kind: "brand_extract",
      status: "queued",
      requested_by: "tu-1",
      input_url: HOME,
    });
    // SUPERSEDE RIDER: prior proposed drafts → discarded.
    expect(captured.brand_extract_drafts.update).toEqual({ status: "discarded" });
    expect(kickMock).toHaveBeenCalledWith("process");
  });

  it("a failed run insert → enqueue_failed (no kick, no supersede)", async () => {
    const { client, captured } = fakeClient({
      clients: { data: { id: CLIENT_ID }, error: null },
      tenant_users: { data: { id: "tu-1" }, error: null },
      runs: { data: null, error: { code: "23514" } },
    });
    createClientMock.mockResolvedValue(client);
    const res = await enqueueRun({ kind: "brand_extract", clientId: CLIENT_ID, url: HOME });
    expect(res).toMatchObject({ ok: false, reason: "enqueue_failed" });
    expect(captured.brand_extract_drafts?.update).toBeUndefined();
    expect(kickMock).not.toHaveBeenCalled();
  });
});
