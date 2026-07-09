import { describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { readActiveAlerts } from "./reads";
import type { Supabase } from "./persist";

vi.mock("server-only", () => ({}));

const CLIENT = "client-1";

function read(script: FakeScript, options?: Parameters<typeof readActiveAlerts>[2]) {
  const fake = fakePostgrest(script);
  return { fake, result: readActiveAlerts(fake.client as unknown as Supabase, CLIENT, options) };
}

const MIXED_ROWS = [
  { id: "a1", type: "visibility_drop", severity: "critical", payload: { summary: "drop", fingerprint: "visibility_drop|client-1", detectedAt: "r2" }, acknowledged: false, created_at: "t3" },
  { id: "a2", type: "crawler_blocked", severity: "warning", payload: { summary: "block" }, acknowledged: false, created_at: "t2" },
  { id: "a3", type: "auto_rollback_fired", severity: "critical", payload: { summary: "reverted" }, acknowledged: false, created_at: "t1" },
];

describe("readActiveAlerts — unified feed", () => {
  it("surfaces EVERY class in one feed (M17 unifies the read even though it writes only its own)", async () => {
    const { result } = read({ alerts: { select: { data: MIXED_ROWS } } });
    const res = await result;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.type)).toEqual(["visibility_drop", "crawler_blocked", "auto_rollback_fired"]);
  });

  it("defaults to OPEN alerts only (filters acknowledged=false); includeAcknowledged widens the query", async () => {
    const openOnly = read({ alerts: { select: { data: MIXED_ROWS } } });
    await openOnly.result;
    expect(openOnly.fake.selects[0].filters).toMatchObject({ client_id: CLIENT, acknowledged: false });

    const withAck = read({ alerts: { select: { data: MIXED_ROWS } } }, { includeAcknowledged: true });
    await withAck.result;
    expect(withAck.fake.selects[0].filters).not.toHaveProperty("acknowledged");
  });

  it("an optional types filter narrows to specific classes (e.g. only crawler_blocked)", async () => {
    const { result } = read({ alerts: { select: { data: MIXED_ROWS } } }, { types: ["crawler_blocked"] });
    const res = await result;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.type)).toEqual(["crawler_blocked"]);
  });

  it("a failed read returns ok:false (retryable — never mistaken for 'no alerts')", async () => {
    const { result } = read({ alerts: { select: { error: { message: "boom", code: "PGRST500" } } } });
    expect(await result).toEqual({ ok: false });
  });
});
