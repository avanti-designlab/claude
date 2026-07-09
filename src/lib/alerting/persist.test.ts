import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { persistWriterAlerts, type Supabase } from "./persist";
import { visibilityDropRule, siteDownRule } from "./rules";
import { visibilityDropFingerprint, type AlertInsertRow } from "./rows";
import type { AlertScope } from "./types";

vi.mock("server-only", () => ({}));

const SCOPE: AlertScope = { tenantId: "tenant-1", clientId: "client-1" };

const DROP_ROW = visibilityDropRule(SCOPE, {
  previousScore: 80,
  latestScore: 50,
  previousRunAt: "r1",
  latestRunAt: "r2",
})!;

function persist(script: FakeScript, rows: AlertInsertRow[], scope: AlertScope = SCOPE) {
  const fake = fakePostgrest(script);
  return { fake, result: persistWriterAlerts(fake.client as unknown as Supabase, scope, rows) };
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

describe("persistWriterAlerts", () => {
  it("no candidates → never touches the DB", async () => {
    const { fake, result } = persist({}, []);
    expect(await result).toEqual({ kind: "no_alerts" });
    expect(fake.selects).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("no open alert → inserts with a CLAIM-SOURCED tenant + scope-pinned client", async () => {
    const { fake, result } = persist(
      { alerts: { select: { data: [] }, insert: { error: null } } },
      [DROP_ROW],
    );
    expect(await result).toEqual({ kind: "inserted", inserted: 1, deduped: 0 });
    const written = fake.inserts[0].values as AlertInsertRow[];
    expect(written[0].tenant_id).toBe("tenant-1");
    expect(written[0].client_id).toBe("client-1");
    expect(written[0].type).toBe("visibility_drop");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("DEDUP: a standing condition does not spam — an open matching fingerprint suppresses the insert", async () => {
    const { fake, result } = persist(
      {
        alerts: {
          select: {
            data: [{ id: "open-1", payload: { fingerprint: visibilityDropFingerprint("client-1") }, acknowledged: false, created_at: "t" }],
          },
        },
      },
      [DROP_ROW],
    );
    expect(await result).toEqual({ kind: "deduped", deduped: 1 });
    expect(fake.inserts).toEqual([]);
  });

  it("a DIFFERENT open fingerprint does not dedup — the new alert is inserted", async () => {
    const { fake, result } = persist(
      {
        alerts: {
          select: { data: [{ id: "open-1", payload: { fingerprint: "visibility_drop|other-client" }, acknowledged: false, created_at: "t" }] },
          insert: { error: null },
        },
      },
      [DROP_ROW],
    );
    expect(await result).toEqual({ kind: "inserted", inserted: 1, deduped: 0 });
    expect(fake.inserts).toHaveLength(1);
  });

  it("FAIL CLOSED: a failed dedup read blocks the insert + one redacted line (no ids)", async () => {
    const { fake, result } = persist(
      { alerts: { select: { error: { message: "secret client-1 detail", code: "PGRST301" } } } },
      [DROP_ROW],
    );
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
    const lines = loggedLines();
    expect(lines).toEqual(["[alerting-write-failure] stage=dedup_read code=PGRST301"]);
    expect(lines[0]).not.toContain("client-1");
  });

  it("an insert failure is reported failed with a redacted line (marker + stage + code only)", async () => {
    const { result } = persist(
      { alerts: { select: { data: [] }, insert: { error: { message: "violates client-1 SECRET", details: "Failing row", code: "23503" } } } },
      [DROP_ROW],
    );
    expect(await result).toEqual({ kind: "failed" });
    const lines = loggedLines();
    expect(lines).toEqual(["[alerting-write-failure] stage=alerts_insert code=23503"]);
    for (const forbidden of ["client-1", "SECRET", "Failing row"]) expect(lines[0]).not.toContain(forbidden);
  });

  it("NO DOUBLE-WRITE: a non-writer type (crawler_blocked) is refused, nothing written", async () => {
    const hostile = { ...DROP_ROW, type: "crawler_blocked" } as unknown as AlertInsertRow;
    const { fake, result } = persist({ alerts: { insert: { error: null } } }, [hostile]);
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
    expect(loggedLines()).toEqual(["[alerting-write-failure] stage=alerts_insert code=M17_NONWRITER"]);
  });

  it("NO DOUBLE-WRITE: auto_rollback_fired cannot go through the writer path either", async () => {
    const hostile = { ...DROP_ROW, type: "auto_rollback_fired" } as unknown as AlertInsertRow;
    const { fake, result } = persist({ alerts: { insert: { error: null } } }, [hostile]);
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
  });

  it("SCOPE GUARD: a row whose tenant/client mismatch the scope is refused (never mis-attributed)", async () => {
    const wrongClient = { ...DROP_ROW, client_id: "other-client" };
    const { fake, result } = persist({ alerts: { insert: { error: null } } }, [wrongClient]);
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
    expect(loggedLines()).toEqual(["[alerting-write-failure] stage=alerts_insert code=M17_SCOPE"]);
  });

  it("dedups PER TYPE: a mixed bundle reads each type's open set; a failed read for any type fails closed", async () => {
    const siteRow = siteDownRule(SCOPE, { propertyId: "p1", baseUrl: "https://x", httpStatus: null, detectedAt: "d" })!;
    // visibility_drop select ok (empty), site_down select errors → whole batch fails closed, no insert.
    const { fake, result } = persist(
      {
        alerts: {
          select: [{ data: [] }, { error: { message: "boom", code: "PGRST500" } }],
          insert: { error: null },
        },
      },
      [DROP_ROW, siteRow],
    );
    expect(await result).toEqual({ kind: "failed" });
    expect(fake.inserts).toEqual([]);
  });
});
