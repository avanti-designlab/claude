import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { analyzeMonitor } from "./analyze";
import { monitorAlertRows, type AlertInsertRow } from "./rows";
import { makeCrawlResult, FIX_BASE_URL } from "./fixtures";
import { persistMonitorAlerts, type Supabase } from "./persist";
import type { PropertyMonitorReport } from "./types";

vi.mock("server-only", () => ({}));

const TENANT = "tenant-1";
const CLIENT = "client-1";
const PROPERTY = "property-1";

const BLOCK_REPORT: PropertyMonitorReport = analyzeMonitor(
  makeCrawlResult({ robotsTxt: "User-agent: GPTBot\nDisallow: /\n" })
);
const CLEAN_REPORT: PropertyMonitorReport = analyzeMonitor(
  makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, true]] })
);

/** The fingerprint monitorAlertRows would mint for BLOCK_REPORT (for dedup scripting). */
function blockFingerprint(): string {
  const rows = monitorAlertRows({ tenantId: TENANT, clientId: CLIENT, propertyId: PROPERTY, report: BLOCK_REPORT });
  return rows[0].payload.fingerprint;
}

function persist(script: FakeScript, report: PropertyMonitorReport) {
  const fake = fakePostgrest(script);
  return {
    fake,
    result: persistMonitorAlerts(fake.client as unknown as Supabase, TENANT, { clientId: CLIENT, propertyId: PROPERTY }, report),
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    return call[0] as string;
  });
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe("persistMonitorAlerts", () => {
  it("a clean report writes nothing and never touches the DB", async () => {
    const { fake, result } = persist({}, CLEAN_REPORT);
    expect(await result).toEqual({ kind: "no_alerts" });
    expect(fake.selects).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("no open alert → inserts the new alert with a CLAIM-SOURCED tenant + property-read client", async () => {
    const { fake, result } = persist(
      { alerts: { select: { data: [] }, insert: { error: null } } },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "inserted", inserted: 1, deduped: 0 });
    expect(fake.inserts).toHaveLength(1);
    const written = fake.inserts[0].values as AlertInsertRow[];
    expect(written).toHaveLength(1);
    expect(written[0].tenant_id).toBe(TENANT); // claim, never a caller value
    expect(written[0].client_id).toBe(CLIENT); // from the property read
    expect(written[0].type).toBe("crawler_blocked");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("DEDUP: an open alert with the same fingerprint suppresses a duplicate (no insert)", async () => {
    const { fake, result } = persist(
      {
        alerts: {
          select: { data: [{ id: "open-1", payload: { fingerprint: blockFingerprint() }, acknowledged: false, created_at: "t" }] },
        },
      },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "deduped", deduped: 1 });
    expect(fake.inserts).toEqual([]); // the standing block did NOT spam a new alert
  });

  it("a DIFFERENT open fingerprint does not dedup — the new block is inserted", async () => {
    const { fake, result } = persist(
      {
        alerts: {
          select: { data: [{ id: "open-1", payload: { fingerprint: "crawler_block|other|ClaudeBot" }, acknowledged: false, created_at: "t" }] },
          insert: { error: null },
        },
      },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "inserted", inserted: 1, deduped: 0 });
    expect(fake.inserts).toHaveLength(1);
  });

  it("FAIL CLOSED: a failed dedup read blocks the insert (no duplicate spam) + one redacted line", async () => {
    const { fake, result } = persist(
      { alerts: { select: { error: { message: `secret ${CLIENT}`, code: "PGRST301" } } } },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
    const lines = loggedLines();
    expect(lines).toEqual(["[monitoring-write-failure] stage=dedup_read code=PGRST301"]);
    expect(lines[0]).not.toContain(CLIENT);
  });

  it("an insert failure is reported failed with a redacted line (marker + stage + code only)", async () => {
    const { result } = persist(
      {
        alerts: {
          select: { data: [] },
          insert: { error: { message: `violates … ${CLIENT} SECRET`, details: "Failing row", code: "23503" } },
        },
      },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "failed" });
    const lines = loggedLines();
    expect(lines).toEqual(["[monitoring-write-failure] stage=alerts_insert code=23503"]);
    for (const forbidden of [CLIENT, "SECRET", "Failing row"]) expect(lines[0]).not.toContain(forbidden);
  });

  it("a hostile error `code` cannot smuggle data — non-token codes collapse to unknown", async () => {
    const { result } = persist(
      { alerts: { select: { data: [] }, insert: { error: { message: "boom", code: "23505; drop table alerts --" } } } },
      BLOCK_REPORT
    );
    expect(await result).toEqual({ kind: "failed" });
    expect(loggedLines()).toEqual(["[monitoring-write-failure] stage=alerts_insert code=unknown"]);
  });
});
