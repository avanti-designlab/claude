import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import type { AlertDraft } from "@/lib/change-management";
import { AlertPersistError, autoRollbackRowFromDraft, createAlertingSink } from "./sink";
import { autoRollbackFingerprint, type AlertInsertRow } from "./rows";
import type { Supabase } from "./persist";

vi.mock("server-only", () => ({}));

const SINK_TENANT = "tenant-1";

/** The draft the ChangeManager emits (manager.ts emitAutoRollbackAlert). */
function draft(overrides: Partial<AlertDraft> = {}): AlertDraft {
  return {
    tenantId: "tenant-FROM-DRAFT",
    clientId: "client-1",
    type: "auto_rollback_fired",
    severity: "critical",
    payload: { changeId: "chg-9", method: "wordpress", revertedReason: "auto-rollback: visibility -34% breaches 30% threshold", at: "2026-07-09T00:00:00Z" },
    ...overrides,
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe("autoRollbackRowFromDraft — mapping", () => {
  it("pins tenant to the SINK tenant (never the draft), keys the fingerprint to the change", () => {
    const row = autoRollbackRowFromDraft(SINK_TENANT, draft());
    expect(row.tenant_id).toBe(SINK_TENANT); // draft.tenantId is ignored — RLS/claim owns tenant
    expect(row.client_id).toBe("client-1");
    expect(row.type).toBe("auto_rollback_fired");
    expect(row.payload.fingerprint).toBe(autoRollbackFingerprint("chg-9"));
    expect(row.severity).toBe("critical");
  });

  it("clamps severity to the frozen CHECK set and tolerates a missing/garbled payload", () => {
    const row = autoRollbackRowFromDraft(SINK_TENANT, draft({ severity: "warning", payload: {} as never }));
    expect(row.severity).toBe("warning");
    expect(row.payload.fingerprint).toBe(autoRollbackFingerprint("unknown")); // no changeId ⇒ safe fallback
  });
});

describe("createAlertingSink — unify, don't re-fire", () => {
  function sink(script: FakeScript) {
    const fake = fakePostgrest(script);
    return { fake, sink: createAlertingSink(fake.client as unknown as Supabase, SINK_TENANT) };
  }

  it("persists the change-management event into `alerts` (one write path, not a re-detection)", async () => {
    const { fake, sink: s } = sink({ alerts: { select: { data: [] }, insert: { error: null } } });
    await s.emit(draft());
    const written = fake.inserts[0].values as AlertInsertRow[];
    expect(written[0].type).toBe("auto_rollback_fired");
    expect(written[0].tenant_id).toBe(SINK_TENANT);
  });

  it("IDEMPOTENT: a re-emit for the SAME rollback is deduped (no second alert), resolves quietly", async () => {
    const { fake, sink: s } = sink({
      alerts: { select: { data: [{ id: "open-1", payload: { fingerprint: autoRollbackFingerprint("chg-9") }, acknowledged: false, created_at: "t" }] } },
    });
    await expect(s.emit(draft())).resolves.toBeUndefined();
    expect(fake.inserts).toEqual([]);
  });

  it("a rollback of a DIFFERENT change is a distinct event (inserted)", async () => {
    const { fake, sink: s } = sink({
      alerts: {
        select: { data: [{ id: "open-1", payload: { fingerprint: autoRollbackFingerprint("chg-OTHER") }, acknowledged: false, created_at: "t" }] },
        insert: { error: null },
      },
    });
    await s.emit(draft());
    expect(fake.inserts).toHaveLength(1);
  });

  it("on a persist failure it throws a SANITIZED marker error (no DB text) + logs one redacted line", async () => {
    const { sink: s } = sink({ alerts: { select: { error: { message: "secret client-1 detail", code: "PGRST301" } } } });
    let caught: unknown;
    try {
      await s.emit(draft());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AlertPersistError);
    expect((caught as Error).message).toBe("alert persistence failed");
    expect((caught as Error).message).not.toContain("client-1");
    const lines = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(lines.every((l: string) => l.startsWith("[alerting-write-failure]"))).toBe(true);
    expect(lines.join("\n")).not.toContain("client-1");
  });
});
