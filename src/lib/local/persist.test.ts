import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest } from "@/lib/plans/postgrest-fake";

vi.mock("server-only", () => ({}));

import {
  LOCAL_FAILURE_MARKER,
  persistLocalAssessment,
  readLocalHistory,
  type Supabase,
} from "./persist";
import { LOCAL_ASSESSMENT_KIND } from "./rows";
import type { LocalReport } from "./types";

/** A minimal report carrying a would-be tenant field to prove it can't be smuggled. */
function report(extra: Record<string, unknown> = {}): LocalReport {
  return {
    vertical: "real-estate",
    intensity: "medium",
    active: true,
    crawledAt: "2026-07-01T00:00:00.000Z",
    locations: [],
    coverage: null,
    fixes: [],
    ...(extra as object),
  } as LocalReport;
}

afterEach(() => vi.restoreAllMocks());

describe("persistLocalAssessment — claim-sourced scoping (security)", () => {
  it("writes tenant/client/property from the PASSED (claim-sourced) values, never from the report", async () => {
    const fake = fakePostgrest({ audits: { insert: { data: { id: "row-1" } } } });
    const hostile = report({ tenant_id: "attacker-tenant", client_id: "attacker-client" });

    const res = await persistLocalAssessment(
      fake.client as unknown as Supabase,
      "tenant-real",
      { clientId: "client-real", propertyId: "prop-real" },
      hostile,
    );

    expect(res.localId).toBe("row-1");
    const row = fake.inserts[0].values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-real");
    expect(row.client_id).toBe("client-real");
    expect(row.property_id).toBe("prop-real");
    // A smuggled tenant/client in the report is inert — the row's scope is the claim's.
    expect(row.tenant_id).not.toBe("attacker-tenant");
    // The capture carries the local-assessment discriminator.
    expect((row.score as Record<string, unknown>).kind).toBe(LOCAL_ASSESSMENT_KIND);
  });

  it("fails soft with an interface-voice warning on a write error (assessment still real)", async () => {
    const fake = fakePostgrest({ audits: { insert: { error: { message: "boom", code: "23505" } } } });
    const res = await persistLocalAssessment(
      fake.client as unknown as Supabase,
      "t",
      { clientId: "c", propertyId: "p" },
      report(),
    );
    expect(res.localId).toBeNull();
    expect(res.saveWarning).toBeTruthy();
  });
});

describe("persistLocalAssessment — redacted telemetry", () => {
  it("logs ONLY the marker, stage, and bare code — never message/details or ids", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakePostgrest({
      audits: {
        insert: {
          error: { message: "duplicate key value for tenant abc-123", code: "23505", details: "secret row data" },
        },
      },
    });
    await persistLocalAssessment(fake.client as unknown as Supabase, "tenant-xyz", { clientId: "c", propertyId: "p" }, report());

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toBe(`${LOCAL_FAILURE_MARKER} stage=local_insert code=23505`);
    expect(line).not.toContain("duplicate key");
    expect(line).not.toContain("secret row data");
    expect(line).not.toContain("tenant-xyz");
  });

  it("collapses a hostile non-string / oversized error code to 'unknown'", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakePostgrest({ audits: { insert: { error: { message: "x", code: "not a valid code with spaces" } } } });
    await persistLocalAssessment(fake.client as unknown as Supabase, "t", { clientId: "c", propertyId: "p" }, report());
    expect(spy.mock.calls[0][0]).toBe(`${LOCAL_FAILURE_MARKER} stage=local_insert code=unknown`);
  });
});

describe("readLocalHistory — kind-filtered (M2 audit rows never leak into the local trend)", () => {
  it("returns ONLY local-assessment captures, newest-first mapping", async () => {
    const fake = fakePostgrest({
      audits: {
        select: {
          data: [
            { id: "a1", property_id: "p", created_at: "2026-07-02T00:00:00Z", score: { kind: LOCAL_ASSESSMENT_KIND, overallScore: 80, assessedLocations: 2, totalLocations: 2, fixCount: 3 } },
            { id: "a2", property_id: "p", created_at: "2026-07-01T00:00:00Z", score: { overallScore: 55 } }, // an M2 audit row — must be excluded
          ],
        },
      },
    });
    const res = await readLocalHistory(fake.client as unknown as Supabase, "client-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.id)).toEqual(["a1"]);
    expect(res.entries[0].overallScore).toBe(80);
    // The read is client-scoped (RLS mirror); the eq filter is recorded.
    expect(fake.selects[0].filters.client_id).toBe("client-1");
  });

  it("reports failure honestly on a read error", async () => {
    const fake = fakePostgrest({ audits: { select: { error: { message: "denied", code: "42501" } } } });
    const res = await readLocalHistory(fake.client as unknown as Supabase, "c");
    expect(res.ok).toBe(false);
  });
});
