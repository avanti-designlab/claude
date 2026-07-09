/**
 * M16 capture persistence — claim-sourced tenant scoping, un-homed sources
 * refused (never mis-filed), hostile sample payloads dead weight, whole-or-
 * nothing snapshot writes, and one redacted telemetry line per failure (marker
 * + stage + code — no tenant/client ids, no analytics figures, no messages).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest } from "@/lib/plans/postgrest-fake";
import type { RoiCollection, SourceOutcome } from "./collect";
import { persistRoiCaptures, type Supabase } from "./persist";
import type { OutcomePeriod, OutcomeSample, RoiSourceId } from "./sources";

vi.mock("server-only", () => ({}));

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CAPTURED_AT = "2026-07-09T12:00:00.000Z";
const PERIOD: OutcomePeriod = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z" };

function sample(source: RoiSourceId, metric: string, value: number): OutcomeSample {
  return { source, metric, value, period: PERIOD };
}

function contributed(
  sourceId: RoiSourceId,
  samples: OutcomeSample[],
  vendor = "in-memory",
): SourceOutcome {
  return { sourceId, status: "contributed", vendor, samples };
}

function collection(outcomes: SourceOutcome[]): RoiCollection {
  const samples = outcomes.flatMap((o) => (o.status === "contributed" ? o.samples : []));
  return {
    period: PERIOD,
    samples,
    outcomes,
    coverage: {
      requested: outcomes.map((o) => o.sourceId),
      contributing: outcomes.filter((o) => o.status === "contributed").map((o) => o.sourceId),
      absent: [],
      failed: [],
      coverage: 1,
    },
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
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("persistRoiCaptures", () => {
  it("stores homed captures, claim-scoped, one captured_at, one statement", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([
        contributed("ga4", [sample("ga4", "sessions", 1000), sample("ga4", "conversions", 12)], "ga4-data-api"),
        contributed("gsc", [sample("gsc", "clicks", 300)]),
      ]),
      CAPTURED_AT,
    );

    expect(outcome).toEqual({ kind: "persisted", rows: 2, capturedAt: CAPTURED_AT, unhomed: [] });
    expect(fake.inserts).toHaveLength(1); // ONE batch — whole snapshot or nothing
    expect(fake.inserts[0].table).toBe("metrics");
    expect(fake.inserts[0].values).toEqual([
      {
        tenant_id: TENANT_ID,
        client_id: CLIENT_ID,
        source: "ga4",
        data: { vendor: "ga4-data-api", period: PERIOD, metrics: { sessions: 1000, conversions: 12 } },
        captured_at: CAPTURED_AT,
      },
      {
        tenant_id: TENANT_ID,
        client_id: CLIENT_ID,
        source: "gsc",
        data: { vendor: "in-memory", period: PERIOD, metrics: { clicks: 300 } },
        captured_at: CAPTURED_AT,
      },
    ]);
  });

  it("refuses un-homed sources (form_fills/crm) — never mis-filed, surfaced structurally", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([
        contributed("ga4", [sample("ga4", "sessions", 500)]),
        contributed("form_fills", [sample("form_fills", "form_submissions", 20)]),
        contributed("crm", [sample("crm", "revenue", 10000)]),
      ]),
      CAPTURED_AT,
    );

    expect(outcome).toEqual({
      kind: "persisted",
      rows: 1,
      capturedAt: CAPTURED_AT,
      unhomed: ["form_fills", "crm"],
    });
    // Only the homed ga4 row is stored; nothing carries form/crm data.
    const values = fake.inserts[0].values as Array<Record<string, unknown>>;
    expect(values).toHaveLength(1);
    expect(values[0].source).toBe("ga4");
    expect(JSON.stringify(fake.inserts)).not.toContain("form_submissions");
    expect(JSON.stringify(fake.inserts)).not.toContain("revenue");
  });

  it("stores nothing when only un-homed sources contributed (no invented rows)", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([contributed("crm", [sample("crm", "qualified_leads", 5)])]),
      CAPTURED_AT,
    );
    expect(outcome).toEqual({ kind: "nothing_homed", unhomed: ["crm"] });
    expect(fake.inserts).toHaveLength(0);
    expect(loggedLines()).toEqual([]);
  });

  it("treats a hostile/foreign sample as dead weight (wrong source, junk value)", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([
        contributed("ga4", [
          sample("crm", "revenue", 999999), // wrong source smuggled into a ga4 outcome
          sample("ga4", "sessions", Number.NaN), // junk value
          sample("ga4", "sessions", 7), // the one real measurement
        ]),
      ]),
      CAPTURED_AT,
    );
    const values = fake.inserts[0].values as Array<Record<string, unknown>>;
    expect(values[0].data).toEqual({ vendor: "in-memory", period: PERIOD, metrics: { sessions: 7 } });
    expect(JSON.stringify(fake.inserts)).not.toContain("999999");
    expect(JSON.stringify(fake.inserts)).not.toContain("revenue");
  });

  it("always pins the CLAIM-SOURCED tenant on every row", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([contributed("ga4", [sample("ga4", "sessions", 1)])]),
      CAPTURED_AT,
    );
    for (const row of fake.inserts[0].values as Array<Record<string, unknown>>) {
      expect(row.tenant_id).toBe(TENANT_ID);
      expect(row.client_id).toBe(CLIENT_ID);
    }
  });

  it("returns failed + ONE redacted line on an insert error — no data in the log", async () => {
    const fake = fakePostgrest({
      metrics: {
        insert: {
          error: {
            message: `duplicate key for tenant ${TENANT_ID} revenue=250000`,
            code: "23505",
            details: "row payload verbatim",
          },
        },
      },
    });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([contributed("ga4", [sample("ga4", "sessions", 1)])]),
      CAPTURED_AT,
    );
    expect(outcome).toEqual({ kind: "failed" });
    const lines = loggedLines();
    expect(lines).toEqual(["[roi-write-failure] stage=captures_insert code=23505"]);
    expect(lines[0]).not.toContain(TENANT_ID);
    expect(lines[0]).not.toContain("250000");
  });

  it("returns failed + stage=thrown when the insert transport throws", async () => {
    const fake = fakePostgrest({ metrics: { insert: { throws: new TypeError("fetch failed") } } });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([contributed("ga4", [sample("ga4", "sessions", 1)])]),
      CAPTURED_AT,
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(loggedLines()).toEqual(["[roi-write-failure] stage=thrown code=unknown"]);
  });

  it("refuses a snapshot whose captured_at is not a timestamp (identity would be junk)", async () => {
    const fake = fakePostgrest({ metrics: { insert: {} } });
    const outcome = await persistRoiCaptures(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      collection([contributed("ga4", [sample("ga4", "sessions", 1)])]),
      "not-a-time",
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(fake.inserts).toHaveLength(0);
    expect(loggedLines()).toEqual(["[roi-write-failure] stage=captures_insert code=unknown"]);
  });
});
