/**
 * M2 server-action suite (`runPropertyAudit` + `listAuditHistory`).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the live FetchPort → a ScriptedFetch);
 * the role guard, uuid clamp, the REAL crawler, the REAL frozen aeo-audit
 * skill, and the real row mapping all run. Pins the review-gated hard
 * properties:
 *  - claim-sourced tenant on the persisted row (never client-supplied); the
 *    stored client_id comes from the RLS-scoped property read;
 *  - a hostile payload (extra fields, forged tenant) is dead weight;
 *  - the honesty gate: a zero-page crawl is REFUSED, never persisted;
 *  - RLS-mirrored auth (operator may run audits; wrong role → forbidden);
 *  - redacted telemetry: one line, marker + stage + code, no payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { AuditInsertRow } from "./rows";
import { runPropertyAudit, listAuditHistory } from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, fetchPortMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  fetchPortMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
// The live resolver is stubbed to a public answer so the REAL crawler's SSRF
// egress guard passes for the scripted (public) test host. The guard's blocked
// paths are pinned exhaustively at the crawler level (crawler.test.ts); here we
// pin the action's synchronous pre-check (isCrawlableUrl) instead.
vi.mock("./live-fetch", () => ({
  liveFetchPort: () => fetchPortMock,
  liveResolvePort: () => async () => [{ address: "93.184.216.34", family: 4 }],
}));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "user-1" };
const ADMIN_CLAIMS = { tenantId: "tenant-1", role: "agency_admin" as const, sub: "user-2" };

const PROPERTY_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const ORIGIN = "https://gg-realty.example";

const PROPERTY_ROW = { id: PROPERTY_ID, client_id: CLIENT_ID, type: "website", url: ORIGIN };
const CLIENT_ROW = { id: CLIENT_ID, name: "Gable & Grove Realty", vertical: "real-estate" };

const AUDIT_TELEMETRY = /^\[audit-run-failure\] stage=(audit_insert|thrown) code=[A-Za-z0-9_]{1,16}$/;

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** A crawlable site so the real skill produces a real score. */
function scriptCrawlableSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: GPTBot\nDisallow: /\n"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(200, `<title>GG Realty</title><h1>Advisory</h1><p>${"Real advisory copy. ".repeat(6)}</p>`),
  );
  return fetchPort;
}

/** A site that answers nothing crawlable (robots unreachable → zero pages). */
function scriptUncrawlableSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(503, "boom"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(503, "boom"));
  return fetchPort;
}

function setup(script: FakeScript, claims: unknown = OPERATOR_CLAIMS) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    return call[0] as string;
  });
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  fetchPortMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/** Point the mocked live FetchPort at a ScriptedFetch for this run. */
function useFetch(fetchPort: ScriptedFetch) {
  fetchPortMock.mockImplementation(fetchPort.port);
}

/* ------------------------------------------------------------------ */
/* authz + input clamp                                                 */
/* ------------------------------------------------------------------ */

describe("runPropertyAudit — authz and input clamp", () => {
  it("wrong role (client_viewer): forbidden, no Supabase client, no crawl", async () => {
    getClaimsMock.mockResolvedValue({ tenantId: "tenant-1", role: "client_viewer", clientId: CLIENT_ID, sub: "u" });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(fetchPortMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed (mirrors audits_insert app.is_writer): the crawl runs", async () => {
    useFetch(scriptCrawlableSite());
    const fake = setup(
      {
        properties: { select: { data: PROPERTY_ROW } },
        clients: { select: { data: CLIENT_ROW } },
        audits: { insert: { data: { id: "audit-1" } } },
      },
      OPERATOR_CLAIMS,
    );
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    expect(fake.inserts.map((i) => i.table)).toEqual(["audits"]);
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(runPropertyAudit({ propertyId: PROPERTY_ID })).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID propertyId: not_found before any DB call or crawl", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    for (const bad of ["not-a-uuid", "", "42 or 1=1"]) {
      const result = await runPropertyAudit({ propertyId: bad });
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    const hostile = await runPropertyAudit({ propertyId: 42 } as unknown as { propertyId: string });
    expect(hostile).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(fetchPortMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* not_found / not_crawlable / no_playbook                             */
/* ------------------------------------------------------------------ */

describe("runPropertyAudit — property/client resolution", () => {
  it("property not visible under RLS (nonexistent OR other tenant — same observation): not_found, no crawl", async () => {
    const fake = setup({ properties: { select: { data: null } } });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.selects.map((s) => s.table)).toEqual(["properties"]);
    expect(fetchPortMock).not.toHaveBeenCalled();
  });

  it("property read failure is audit_failed (retryable), never a false not_found", async () => {
    setup({ properties: { select: { error: { message: "connection reset" } } } });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
  });

  it("a non-website property is not crawlable — no crawl attempted", async () => {
    const fake = setup({ properties: { select: { data: { ...PROPERTY_ROW, type: "gbp", url: "" } } } });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "not_crawlable" });
    expect(fetchPortMock).not.toHaveBeenCalled();
    expect(fake.inserts).toEqual([]);
  });

  it("a website property with a non-http URL is not crawlable", async () => {
    setup({ properties: { select: { data: { ...PROPERTY_ROW, url: "ftp://x" } } } });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "not_crawlable" });
  });

  it("a website property pointed at an internal address is not_crawlable PRE-CRAWL (SSRF pre-check)", async () => {
    // A stored property URL aimed at cloud metadata / loopback is refused by the
    // synchronous isCrawlableUrl guard — no crawl, no fetch, no resolve.
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost", "http://127.0.0.1", "http://10.0.0.5"]) {
      fetchPortMock.mockReset();
      const fake = setup({ properties: { select: { data: { ...PROPERTY_ROW, url } } } });
      const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
      expect(result).toMatchObject({ ok: false, reason: "not_crawlable" });
      expect(fetchPortMock).not.toHaveBeenCalled();
      expect(fake.inserts).toEqual([]);
    }
  });

  it("dormant vertical: no_playbook, no crawl (Gate 1a)", async () => {
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: { ...CLIENT_ROW, vertical: "restaurants" } } },
    });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(fetchPortMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* honesty gate + persistence security                                 */
/* ------------------------------------------------------------------ */

describe("runPropertyAudit — honesty gate and persistence security", () => {
  it("persists with a CLAIM-SOURCED tenant and the property-read client_id; hostile inputs are dead weight", async () => {
    useFetch(scriptCrawlableSite());
    const fake = setup({
      // A hostile property row smuggling a forged tenant_id and junk fields —
      // the action must ignore them: tenant comes from the claim, client from
      // this row's client_id, and nothing else is trusted.
      properties: {
        select: { data: { ...PROPERTY_ROW, tenant_id: "tenant-EVIL", injected: "x" } },
      },
      clients: { select: { data: CLIENT_ROW } },
      audits: { insert: { data: { id: "audit-1" } } },
    });

    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.auditId).toBe("audit-1");
    // Real skill produced a real score + real fixes (no invented numbers).
    expect(Number.isFinite(result.audit.overallScore)).toBe(true);
    expect(result.audit.fixes.length).toBeGreaterThan(0);

    const row = fake.inserts[0].values as AuditInsertRow;
    expect(row.tenant_id).toBe("tenant-1"); // CLAIM, not the forged tenant-EVIL
    expect(row.client_id).toBe(CLIENT_ID); // from the property read
    expect(row.property_id).toBe(PROPERTY_ID);
    // The stored row carries only the mapped columns — no smuggled keys.
    expect(Object.keys(row).sort()).toEqual(["client_id", "fixes", "property_id", "score", "tenant_id"]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("HONESTY GATE: a zero-page crawl is REFUSED (crawl_failed), never persisted", async () => {
    useFetch(scriptUncrawlableSite());
    const fake = setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
    });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("crawl_failed");
    // The per-page record travels with the refusal — the operator sees WHY.
    expect(result.coverage?.crawled).toBe(0);
    expect(result.coverage?.robotsTxtStatus).toBe("unreachable");
    // Nothing persisted: a no-page pseudo-score would poison the trend line.
    expect(fake.inserts).toEqual([]);
  });

  it("save failure: audit still returns ok with the live result + a saveWarning + one redacted line", async () => {
    useFetch(scriptCrawlableSite());
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
      audits: {
        insert: {
          error: {
            message: `insert violates … ${CLIENT_ROW.name} tenant-1 SECRET-ROW-DATA`,
            details: "Failing row contains (…)",
            code: "23503",
          },
        },
      },
    });
    const result = await runPropertyAudit({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The audit RAN — results are real and shown; only history save failed.
    expect(result.auditId).toBeNull();
    expect(result.saveWarning).toContain("couldn’t save it to history");
    expect(result.audit.fixes.length).toBeGreaterThan(0);

    const lines = loggedLines();
    expect(lines).toEqual(["[audit-run-failure] stage=audit_insert code=23503"]);
    for (const forbidden of [CLIENT_ROW.name, CLIENT_ID, "tenant-1", "SECRET-ROW-DATA", "Failing row"]) {
      expect(lines[0]).not.toContain(forbidden);
    }
  });

  it("a hostile error `code` cannot smuggle data: non-token codes collapse to unknown", async () => {
    useFetch(scriptCrawlableSite());
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
      audits: { insert: { error: { message: "boom", code: "23505; drop table audits --" } } },
    });
    await runPropertyAudit({ propertyId: PROPERTY_ID });
    const lines = loggedLines();
    expect(lines).toEqual(["[audit-run-failure] stage=audit_insert code=unknown"]);
    expect(lines[0]).toMatch(AUDIT_TELEMETRY);
  });
});

/* ------------------------------------------------------------------ */
/* listAuditHistory                                                    */
/* ------------------------------------------------------------------ */

describe("listAuditHistory — the client trend line", () => {
  it("maps newest-first rows into history entries; parses jsonb defensively", async () => {
    setup(
      {
        audits: {
          select: {
            data: [
              {
                id: "a2",
                property_id: PROPERTY_ID,
                created_at: "2026-07-02T00:00:00.000Z",
                score: { overallScore: 81.2, fixCount: 2, playbookVersion: "1.0.0", coverage: { attempted: 3, crawled: 3 } },
              },
              {
                id: "a1",
                property_id: PROPERTY_ID,
                created_at: "2026-07-01T00:00:00.000Z",
                score: "corrupt", // hostile/garbage capture → nulls, never a throw
              },
            ],
          },
        },
      },
      ADMIN_CLAIMS,
    );
    const result = await listAuditHistory({ clientId: CLIENT_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entries).toEqual([
      {
        id: "a2",
        propertyId: PROPERTY_ID,
        createdAt: "2026-07-02T00:00:00.000Z",
        overallScore: 81.2,
        fixCount: 2,
        pagesCrawled: 3,
        pagesFailed: 0,
        playbookVersion: "1.0.0",
      },
      {
        id: "a1",
        propertyId: PROPERTY_ID,
        createdAt: "2026-07-01T00:00:00.000Z",
        overallScore: null,
        fixCount: null,
        pagesCrawled: null,
        pagesFailed: null,
        playbookVersion: null,
      },
    ]);
  });

  it("non-UUID clientId: not_found before any DB call", async () => {
    getClaimsMock.mockResolvedValue(ADMIN_CLAIMS);
    const result = await listAuditHistory({ clientId: "nope" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("read failure is read_failed (retryable, interface-voice)", async () => {
    setup({ audits: { select: { error: { message: "connection reset" } } } }, ADMIN_CLAIMS);
    const result = await listAuditHistory({ clientId: CLIENT_ID });
    expect(result).toMatchObject({ ok: false, reason: "read_failed" });
  });
});
