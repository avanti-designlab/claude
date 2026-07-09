/**
 * M6 decay-scan server action (`runPropertyDecayScan`).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the live crawl ports → a ScriptedFetch);
 * the role guard, uuid clamp, the REAL guarded crawler, the REAL decay engine,
 * and the real assessment all run. Pins the review-gated hard properties:
 *  - RLS-mirrored auth (operator may scan; wrong role → forbidden);
 *  - claim-sourced isolation: the caller supplies ONLY propertyId; scope rests
 *    on the RLS-scoped property/client reads, never on caller input;
 *  - content_items is NEITHER READ NOR WRITTEN — no operation on that table
 *    under ANY input, and smuggled property-row fields are dead weight;
 *  - the SSRF pre-check refuses an internal property URL before any crawl;
 *  - the honesty gate: a zero-page crawl is REFUSED (crawl_failed);
 *  - redacted telemetry: one line, marker + stage + code, no payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import { runPropertyDecayScan } from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, liveFetchPortMock, fetchPortMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  liveFetchPortMock: vi.fn(),
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
// egress guard passes for the scripted (public) test host; blocked paths are
// pinned exhaustively at the crawler level. `liveFetchPort` is a factory mock so
// one test can make it throw INSIDE the action's try (the fail-closed guard
// means the real crawl never throws on valid input — the factory is the seam).
vi.mock("./live-fetch", () => ({
  liveFetchPort: liveFetchPortMock,
  liveResolvePort: () => async () => [{ address: "93.184.216.34", family: 4 }],
}));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "user-1" };

const PROPERTY_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const ORIGIN = "https://gg-realty.example";

const PROPERTY_ROW = { id: PROPERTY_ID, client_id: CLIENT_ID, type: "website", url: ORIGIN };
const CLIENT_ROW = { id: CLIENT_ID, vertical: "real-estate" };

const DECAY_TELEMETRY = /^\[decay-scan-failure\] stage=thrown code=[A-Za-z0-9_]{1,16}$/;

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** A crawlable site (a couple of pages) so the real engine assesses something. */
function scriptCrawlableSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: *\nAllow: /\n"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>GG Realty</title><h1>Advisory</h1>
       <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","dateModified":"2024-01-01"}</script>
       <p>${"Real advisory copy answering buyer questions. ".repeat(8)}</p><a href="/about">about</a>`,
    ),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/about`), () =>
    htmlResponse(200, `<h1>About</h1><p>${"Team background and credentials. ".repeat(8)}</p><a href="/">home</a>`),
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
  liveFetchPortMock.mockReset();
  fetchPortMock.mockReset();
  // Default: the factory returns the scriptable port (individual tests set the
  // ScriptedFetch behind it via useFetch, or override the factory to throw).
  liveFetchPortMock.mockReturnValue(fetchPortMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

function useFetch(fetchPort: ScriptedFetch) {
  fetchPortMock.mockImplementation(fetchPort.port);
}

/* ------------------------------------------------------------------ */
/* authz + input clamp                                                 */
/* ------------------------------------------------------------------ */

describe("runPropertyDecayScan — authz and input clamp", () => {
  it("wrong role (client_viewer): forbidden, no Supabase client, no crawl", async () => {
    getClaimsMock.mockResolvedValue({ tenantId: "tenant-1", role: "client_viewer", clientId: CLIENT_ID, sub: "u" });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(liveFetchPortMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed (mirrors app.is_writer): the scan runs and returns a report", async () => {
    useFetch(scriptCrawlableSite());
    const fake = setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
    });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.report.summary.assessed).toBeGreaterThan(0);
    expect(result.coverage.crawled).toBeGreaterThan(0);
    // M6 writes NOTHING — it is a derived, on-demand read.
    expect(fake.inserts).toEqual([]);
    expect(fake.updates).toEqual([]);
    expect(fake.deletes).toEqual([]);
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(runPropertyDecayScan({ propertyId: PROPERTY_ID })).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID propertyId: not_found before any DB call or crawl", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    for (const bad of ["not-a-uuid", "", "42 or 1=1"]) {
      const result = await runPropertyDecayScan({ propertyId: bad });
      expect(result).toMatchObject({ ok: false, reason: "not_found" });
    }
    const hostile = await runPropertyDecayScan({ propertyId: 42 } as unknown as { propertyId: string });
    expect(hostile).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(liveFetchPortMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* resolution / not_crawlable / no_playbook                            */
/* ------------------------------------------------------------------ */

describe("runPropertyDecayScan — property/client resolution", () => {
  it("property not visible under RLS (nonexistent OR other tenant — same observation): not_found, no crawl", async () => {
    const fake = setup({ properties: { select: { data: null } } });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.selects.map((s) => s.table)).toEqual(["properties"]);
    expect(liveFetchPortMock).not.toHaveBeenCalled();
  });

  it("property read failure is scan_failed (retryable), never a false not_found", async () => {
    setup({ properties: { select: { error: { message: "connection reset" } } } });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "scan_failed" });
  });

  it("a non-website property is not crawlable — no crawl attempted", async () => {
    setup({ properties: { select: { data: { ...PROPERTY_ROW, type: "gbp", url: "" } } } });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "not_crawlable" });
    expect(liveFetchPortMock).not.toHaveBeenCalled();
  });

  it("an internal property URL is not_crawlable PRE-CRAWL (SSRF pre-check)", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost",
      "http://127.0.0.1",
      "http://10.0.0.5",
      "ftp://x",
    ]) {
      liveFetchPortMock.mockClear();
      setup({ properties: { select: { data: { ...PROPERTY_ROW, url } } } });
      const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
      expect(result).toMatchObject({ ok: false, reason: "not_crawlable" });
      expect(liveFetchPortMock).not.toHaveBeenCalled();
    }
  });

  it("dormant vertical: no_playbook, no crawl (Gate 1a)", async () => {
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: { ...CLIENT_ROW, vertical: "restaurants" } } },
    });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(liveFetchPortMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* content_items security + claim-sourced isolation                    */
/* ------------------------------------------------------------------ */

describe("runPropertyDecayScan — content_items is neither read nor written; hostile input is dead weight", () => {
  it("a successful scan touches ONLY properties + clients (RLS-scoped); NEVER content_items; smuggled fields are dead weight", async () => {
    const scripted = scriptCrawlableSite();
    useFetch(scripted);
    const fake = setup({
      // A hostile property row smuggling a forged tenant, a content-item id, a
      // decay override, and junk — all must be dead weight.
      properties: {
        select: {
          data: {
            ...PROPERTY_ROW,
            tenant_id: "tenant-EVIL",
            content_item_id: "smuggled",
            decay: { decayScore: 0 },
            injected: "x",
          },
        },
      },
      clients: { select: { data: CLIENT_ROW } },
    });

    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);

    // content_items is never read and never written — no operation on that table.
    const allTables = [
      ...fake.selects.map((s) => s.table),
      ...fake.inserts.map((i) => i.table),
      ...fake.updates.map((u) => u.table),
      ...fake.deletes.map((d) => d.table),
    ];
    expect(allTables).not.toContain("content_items");
    // The only reads are the RLS-scoped property + client lookups.
    expect(fake.selects.map((s) => s.table)).toEqual(["properties", "clients"]);
    // Isolation rests on those RLS reads: filtered ONLY by id (no caller tenant
    // reaches a query filter); the smuggled tenant-EVIL is never used.
    expect(fake.selects[0].filters).toEqual({ id: PROPERTY_ID });
    expect(fake.selects[1].filters).toEqual({ id: CLIENT_ID });
    // No writes at all — the derived report is the only output.
    expect(fake.inserts).toEqual([]);
    expect(fake.updates).toEqual([]);
    expect(fake.deletes).toEqual([]);
    // The crawl went only to the DB-stored origin — never a smuggled URL.
    expect(scripted.requests.every((r) => r.url.startsWith(ORIGIN))).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* honesty gate + telemetry redaction                                  */
/* ------------------------------------------------------------------ */

describe("runPropertyDecayScan — honesty gate and redacted telemetry", () => {
  it("HONESTY GATE: a zero-page crawl is REFUSED (crawl_failed) with the coverage record", async () => {
    useFetch(scriptUncrawlableSite());
    const fake = setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
    });
    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("crawl_failed");
    expect(result.coverage?.crawled).toBe(0);
    expect(result.coverage?.robotsTxtStatus).toBe("unreachable");
    expect(fake.inserts).toEqual([]); // nothing derived, nothing to persist anyway
  });

  it("an unexpected throw during the crawl → ONE redacted line + scan_failed (no payload leak)", async () => {
    // Force a throw inside the action's try: the crawl-port factory throws a
    // hostile error carrying secrets + a poisoned code.
    const hostile = Object.assign(new Error("boom tenant-1 SECRET-ROW-DATA"), {
      details: "Failing row contains (…)",
      code: "23505; drop table content_items --",
    });
    liveFetchPortMock.mockImplementation(() => {
      throw hostile;
    });
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
    });

    const result = await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(result).toMatchObject({ ok: false, reason: "scan_failed" });

    const lines = loggedLines();
    expect(lines).toEqual(["[decay-scan-failure] stage=thrown code=unknown"]); // poisoned code collapses
    expect(lines[0]).toMatch(DECAY_TELEMETRY);
    for (const forbidden of ["SECRET-ROW-DATA", "tenant-1", "Failing row", "drop table"]) {
      expect(lines[0]).not.toContain(forbidden);
    }
  });

  it("a clean SQLSTATE code survives as the only detail on the telemetry line", async () => {
    liveFetchPortMock.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { code: "23503" });
    });
    setup({
      properties: { select: { data: PROPERTY_ROW } },
      clients: { select: { data: CLIENT_ROW } },
    });
    await runPropertyDecayScan({ propertyId: PROPERTY_ID });
    expect(loggedLines()).toEqual(["[decay-scan-failure] stage=thrown code=23503"]);
  });
});
