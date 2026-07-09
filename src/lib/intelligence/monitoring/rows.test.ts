import { describe, expect, it } from "vitest";
import { analyzeMonitor } from "./analyze";
import { crawlerRenderStatusEntry, monitorAlertRows, type AlertInsertRow } from "./rows";
import { makeCrawlResult, FIX_BASE_URL } from "./fixtures";
import type { PropertyMonitorReport } from "./types";

const TENANT = "tenant-1";
const CLIENT = "client-1";
const PROPERTY = "property-1";

function rowsFor(report: PropertyMonitorReport): AlertInsertRow[] {
  return monitorAlertRows({ tenantId: TENANT, clientId: CLIENT, propertyId: PROPERTY, report });
}

describe("monitorAlertRows — mapping to the frozen `alerts` table", () => {
  it("a clean site produces NO alert rows", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, true]] }));
    expect(rowsFor(report)).toEqual([]);
  });

  it("a crawler block → one `crawler_blocked` alert, kind=crawler_block, claim-sourced scope", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt: "User-agent: GPTBot\nDisallow: /\n" }));
    const rows = rowsFor(report);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tenant_id).toBe(TENANT);
    expect(row.client_id).toBe(CLIENT);
    expect(row.type).toBe("crawler_blocked"); // the frozen enum value
    expect(row.payload.kind).toBe("crawler_block");
    expect(row.payload.propertyId).toBe(PROPERTY);
    expect(row.payload.blockedCrawlers?.map((c) => c.botId)).toEqual(["GPTBot"]);
    expect(row.severity).toBe("critical"); // GPTBot is citation-relevant
  });

  it("blocking ONLY a training-only third-party crawler is a warning, not critical", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt: "User-agent: Bytespider\nDisallow: /\n" }));
    const rows = rowsFor(report);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("warning");
  });

  it("a render risk → a `render_risk` alert; critical only when EVERY crawled page is JS-dependent", () => {
    const allInvisible = analyzeMonitor(makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, false]] }));
    const r1 = rowsFor(allInvisible);
    expect(r1).toHaveLength(1);
    expect(r1[0].payload.kind).toBe("render_risk");
    expect(r1[0].severity).toBe("critical");
    expect(r1[0].payload.jsDependentUrls).toEqual([`${FIX_BASE_URL}/a`]);

    const partial = analyzeMonitor(
      makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, false], [`${FIX_BASE_URL}/b`, true]] })
    );
    expect(rowsFor(partial)[0].severity).toBe("warning"); // /b is still visible
  });

  it("both a block AND a render risk → TWO rows (one per kind)", () => {
    const report = analyzeMonitor(
      makeCrawlResult({ robotsTxt: "User-agent: GPTBot\nDisallow: /\n", pages: [[`${FIX_BASE_URL}/a`, false]] })
    );
    const rows = rowsFor(report);
    expect(rows.map((r) => r.payload.kind).sort()).toEqual(["crawler_block", "render_risk"]);
  });

  it("fingerprints are stable + deterministic, and encode the finding set", () => {
    const mk = () => analyzeMonitor(makeCrawlResult({ robotsTxt: "User-agent: GPTBot\nDisallow: /\n" }));
    const fp1 = rowsFor(mk())[0].payload.fingerprint;
    const fp2 = rowsFor(mk())[0].payload.fingerprint;
    expect(fp1).toBe(fp2);
    expect(fp1).toContain(PROPERTY);
    expect(fp1).toContain("GPTBot");

    // A DIFFERENT blocked set yields a DIFFERENT fingerprint (a new condition).
    const other = analyzeMonitor(makeCrawlResult({ robotsTxt: "User-agent: ClaudeBot\nDisallow: /\n" }));
    expect(rowsFor(other)[0].payload.fingerprint).not.toBe(fp1);
  });

  it("UNKNOWN verdicts (unreachable robots) produce NO alert (unknown ≠ blocked)", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxtStatus: "unreachable" }));
    expect(rowsFor(report)).toEqual([]);
  });
});

describe("crawlerRenderStatusEntry — defensive jsonb parsing", () => {
  it("maps a well-formed row", () => {
    const entry = crawlerRenderStatusEntry({
      id: "alert-1",
      severity: "critical",
      payload: {
        kind: "crawler_block",
        fingerprint: "fp",
        propertyId: PROPERTY,
        baseUrl: FIX_BASE_URL,
        detectedAt: "2026-07-09T00:00:00.000Z",
        summary: "blocks 1 AI crawler(s): GPTBot",
        blockedCrawlers: [{ botId: "GPTBot", operator: "OpenAI", blockedPaths: ["/"] }],
      },
      acknowledged: false,
      created_at: "2026-07-09T01:00:00.000Z",
    });
    expect(entry).toMatchObject({
      alertId: "alert-1",
      kind: "crawler_block",
      propertyId: PROPERTY,
      baseUrl: FIX_BASE_URL,
      acknowledged: false,
    });
    expect(entry.blockedCrawlers?.[0].botId).toBe("GPTBot");
  });

  it("a hostile/garbage payload maps to nulls, never throws", () => {
    const entry = crawlerRenderStatusEntry({
      id: "alert-2",
      severity: "warning",
      payload: "corrupt",
      acknowledged: true,
      created_at: "2026-07-09T01:00:00.000Z",
    });
    expect(entry).toEqual({
      alertId: "alert-2",
      kind: null,
      severity: "warning",
      propertyId: null,
      baseUrl: null,
      summary: null,
      blockedCrawlers: null,
      jsDependentUrls: null,
      detectedAt: null,
      acknowledged: true,
      createdAt: "2026-07-09T01:00:00.000Z",
    });
  });

  it("drops non-string / malformed blocked-crawler entries without throwing", () => {
    const entry = crawlerRenderStatusEntry({
      id: "alert-3",
      severity: "critical",
      payload: {
        kind: "render_risk",
        jsDependentUrls: [`${FIX_BASE_URL}/a`, 42, null],
        blockedCrawlers: [{ botId: "GPTBot" }, { operator: "x" }, 7],
      },
      acknowledged: false,
      created_at: "2026-07-09T01:00:00.000Z",
    });
    expect(entry.jsDependentUrls).toEqual([`${FIX_BASE_URL}/a`]); // non-strings dropped
    expect(entry.blockedCrawlers).toEqual([{ botId: "GPTBot", operator: "", blockedPaths: [] }]);
  });
});
