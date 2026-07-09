/**
 * M5 server-action suite (`runPropertyMonitor` + `getCrawlerRenderStatus`).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the live FetchPort → a ScriptedFetch); the
 * role guard, the uuid clamp, the REAL reused crawler, the REAL analyzers, and
 * the real alert-row mapping all run. Pins the review-gated hard properties:
 *  - claim-sourced tenant on the persisted alert (never client-supplied);
 *  - a hostile property row (forged tenant, junk fields) is dead weight;
 *  - SSRF-by-parameter is impossible (internal URL refused pre-crawl);
 *  - RLS-mirrored auth (operator may run; wrong role → forbidden; reads → requireAuth);
 *  - honesty: an unreachable-robots run alerts NOTHING (unknown ≠ blocked);
 *  - a persistence failure does NOT fail the run (the live report is real);
 *  - redacted telemetry: one line, marker + stage + code, no payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { AlertInsertRow } from "./rows";
import { getCrawlerRenderStatus, runPropertyMonitor } from "./actions";

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
vi.mock("./live-fetch", () => ({
  liveFetchPort: () => fetchPortMock,
  liveResolvePort: () => async () => [{ address: "93.184.216.34", family: 4 }],
}));

const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "user-1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: "c", sub: "u" };

const PROPERTY_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const ORIGIN = "https://gg-realty.example";
const PROPERTY_ROW = { id: PROPERTY_ID, client_id: CLIENT_ID, type: "website", url: ORIGIN };

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** A site that blocks GPTBot in robots (our own AEO-AuditBot stays allowed). */
function scriptBlockingSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () =>
    textResponse(200, "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n")
  );
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(200, `<title>GG</title><h1>Advisory</h1><p>${"Real advisory copy ".repeat(20)}</p>`)
  );
  return fetchPort;
}

/** A clean site: no robots.txt, static content, no blocks. */
function scriptCleanSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(200, `<title>GG</title><h1>Advisory</h1><p>${"Real advisory copy ".repeat(20)}</p>`)
  );
  return fetchPort;
}

/** robots.txt unreachable (503) → every crawler verdict is unknown. */
function scriptUnreachableRobots(): ScriptedFetch {
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

function useFetch(fetchPort: ScriptedFetch) {
  fetchPortMock.mockImplementation(fetchPort.port);
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  fetchPortMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */
/* runPropertyMonitor — authz + input clamp                            */
/* ------------------------------------------------------------------ */

describe("runPropertyMonitor — authz and input clamp", () => {
  it("wrong role (client_viewer): forbidden, no Supabase client, no crawl", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const result = await runPropertyMonitor({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(fetchPortMock).not.toHaveBeenCalled();
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(runPropertyMonitor({ propertyId: PROPERTY_ID })).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID propertyId: not_found before any DB call or crawl", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    for (const bad of ["not-a-uuid", "", "42 or 1=1"]) {
      expect(await runPropertyMonitor({ propertyId: bad })).toMatchObject({ ok: false, reason: "not_found" });
    }
    const hostile = await runPropertyMonitor({ propertyId: 42 } as unknown as { propertyId: string });
    expect(hostile).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(fetchPortMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* runPropertyMonitor — property resolution + crawlability             */
/* ------------------------------------------------------------------ */

describe("runPropertyMonitor — property resolution", () => {
  it("property not visible under RLS (nonexistent OR other tenant): not_found, no crawl", async () => {
    const fake = setup({ properties: { select: { data: null } } });
    expect(await runPropertyMonitor({ propertyId: PROPERTY_ID })).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.selects.map((s) => s.table)).toEqual(["properties"]);
    expect(fetchPortMock).not.toHaveBeenCalled();
  });

  it("property read failure is monitor_failed (retryable), never a false not_found", async () => {
    setup({ properties: { select: { error: { message: "connection reset" } } } });
    expect(await runPropertyMonitor({ propertyId: PROPERTY_ID })).toMatchObject({ ok: false, reason: "monitor_failed" });
  });

  it("a non-website property is not crawlable — no crawl attempted", async () => {
    const fake = setup({ properties: { select: { data: { ...PROPERTY_ROW, type: "gbp", url: "" } } } });
    expect(await runPropertyMonitor({ propertyId: PROPERTY_ID })).toMatchObject({ ok: false, reason: "not_crawlable" });
    expect(fetchPortMock).not.toHaveBeenCalled();
    expect(fake.inserts).toEqual([]);
  });

  it("a website property pointed at an internal address is not_crawlable PRE-CRAWL (SSRF pre-check)", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost", "http://127.0.0.1", "http://10.0.0.5"]) {
      fetchPortMock.mockReset();
      const fake = setup({ properties: { select: { data: { ...PROPERTY_ROW, url } } } });
      expect(await runPropertyMonitor({ propertyId: PROPERTY_ID })).toMatchObject({ ok: false, reason: "not_crawlable" });
      expect(fetchPortMock).not.toHaveBeenCalled();
      expect(fake.inserts).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* runPropertyMonitor — run + persistence + honesty                    */
/* ------------------------------------------------------------------ */

describe("runPropertyMonitor — run, persistence, honesty", () => {
  it("operator IS allowed; a blocked crawler persists a `crawler_blocked` alert with a CLAIM-SOURCED tenant", async () => {
    useFetch(scriptBlockingSite());
    const fake = setup({
      // A hostile property row smuggling a forged tenant + junk fields — the
      // action must ignore them: tenant from the claim, client from this row.
      properties: { select: { data: { ...PROPERTY_ROW, tenant_id: "tenant-EVIL", injected: "x" } } },
      alerts: { select: { data: [] }, insert: { error: null } },
    });

    const result = await runPropertyMonitor({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.alerts).toEqual({ kind: "inserted", inserted: 1, deduped: 0 });
    // Real analyzers produced a real verdict (no invented data).
    const gpt = result.report.crawlers.find((c) => c.botId === "GPTBot");
    expect(gpt?.access).toBe("blocked");

    const written = fake.inserts[0].values as AlertInsertRow[];
    expect(written[0].tenant_id).toBe("tenant-1"); // CLAIM, not the forged tenant-EVIL
    expect(written[0].client_id).toBe(CLIENT_ID); // from the property read
    expect(written[0].type).toBe("crawler_blocked");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("HONESTY: an unreachable-robots run returns ok with all-unknown verdicts and alerts NOTHING", async () => {
    useFetch(scriptUnreachableRobots());
    const fake = setup({ properties: { select: { data: PROPERTY_ROW } } });
    const result = await runPropertyMonitor({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.report.robotsTxtStatus).toBe("unreachable");
    for (const c of result.report.crawlers) expect(c.access).toBe("unknown");
    expect(result.alerts).toEqual({ kind: "no_alerts" });
    expect(fake.inserts).toEqual([]); // unknown ≠ blocked → nothing written
  });

  it("a clean site returns ok and writes no alert", async () => {
    useFetch(scriptCleanSite());
    const fake = setup({ properties: { select: { data: PROPERTY_ROW } } });
    const result = await runPropertyMonitor({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.report.hasCrawlerBlock).toBe(false);
    expect(result.alerts).toEqual({ kind: "no_alerts" });
    expect(fake.inserts).toEqual([]);
  });

  it("a persistence failure does NOT fail the run — the live report is returned with alerts.kind=failed", async () => {
    useFetch(scriptBlockingSite());
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      alerts: { select: { error: { message: "boom", code: "PGRST301" } } }, // dedup read fails → fail closed
    });
    const result = await runPropertyMonitor({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.alerts).toEqual({ kind: "failed" });
    expect(result.report.blockedCrawlers).toContain("GPTBot"); // the report is real
    expect(loggedLines()).toEqual(["[monitoring-write-failure] stage=dedup_read code=PGRST301"]);
  });
});

/* ------------------------------------------------------------------ */
/* getCrawlerRenderStatus                                              */
/* ------------------------------------------------------------------ */

describe("getCrawlerRenderStatus — the dashboard status read", () => {
  it("maps stored open alerts into status entries", async () => {
    setup(
      {
        alerts: {
          select: {
            data: [
              {
                id: "alert-1",
                severity: "critical",
                payload: {
                  kind: "crawler_block",
                  propertyId: PROPERTY_ID,
                  baseUrl: ORIGIN,
                  summary: "blocks GPTBot",
                  blockedCrawlers: [{ botId: "GPTBot", operator: "OpenAI", blockedPaths: ["/"] }],
                },
                acknowledged: false,
                created_at: "2026-07-09T00:00:00.000Z",
              },
            ],
          },
        },
      },
      VIEWER_CLAIMS
    );
    const result = await getCrawlerRenderStatus({ clientId: CLIENT_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ alertId: "alert-1", kind: "crawler_block", propertyId: PROPERTY_ID });
  });

  it("non-UUID clientId: not_found before any DB call", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    expect(await getCrawlerRenderStatus({ clientId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a provided-but-invalid propertyId scopes to nothing (empty), no DB call", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const result = await getCrawlerRenderStatus({ clientId: CLIENT_ID, propertyId: "not-a-uuid" });
    expect(result).toEqual({ ok: true, entries: [] });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("read failure is read_failed (retryable)", async () => {
    setup({ alerts: { select: { error: { message: "connection reset" } } } }, OPERATOR_CLAIMS);
    expect(await getCrawlerRenderStatus({ clientId: CLIENT_ID })).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("filters entries to a valid propertyId", async () => {
    setup(
      {
        alerts: {
          select: {
            data: [
              { id: "a1", severity: "critical", payload: { kind: "crawler_block", propertyId: PROPERTY_ID }, acknowledged: false, created_at: "t1" },
              { id: "a2", severity: "warning", payload: { kind: "render_risk", propertyId: "other-prop" }, acknowledged: false, created_at: "t2" },
            ],
          },
        },
      },
      OPERATOR_CLAIMS
    );
    const result = await getCrawlerRenderStatus({ clientId: CLIENT_ID, propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entries.map((e) => e.alertId)).toEqual(["a1"]);
  });
});
