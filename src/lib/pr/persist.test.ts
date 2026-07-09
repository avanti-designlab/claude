/**
 * M12 persistence — claim-sourced tenant scoping (security), redacted telemetry,
 * partial-failure fail-soft, and kind-filtered history reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest } from "@/lib/plans/postgrest-fake";

vi.mock("server-only", () => ({}));

import {
  ENTITY_FAILURE_MARKER,
  persistEntityAuthority,
  readEntityAuthorityHistory,
  type Supabase,
} from "./persist";
import { ENTITY_AUTHORITY_KIND } from "./rows";
import type { EntityAuthorityReport } from "./types";

function report(extra: Record<string, unknown> = {}): EntityAuthorityReport {
  return {
    vertical: "real-estate",
    crawledAt: "2026-07-01T00:00:00.000Z",
    assessable: true,
    person: { status: "assessed", keyPersonName: "Daniel Reyes", namePresentOnPage: true, personSchemaPresent: false, sameAsPresentInSchema: false, notes: [] },
    press: { status: "assessed", pressSectionPresent: false, claimedPress: [], corroboratedCount: 0, claimedCount: 0, notes: [] },
    coverage: null,
    fixes: [],
    ...(extra as object),
  } as EntityAuthorityReport;
}

afterEach(() => vi.restoreAllMocks());

describe("persistEntityAuthority — claim-sourced scoping (security)", () => {
  it("writes tenant/client/property from the PASSED values, never from the report", async () => {
    const fake = fakePostgrest({ audits: { insert: { data: { id: "row-1" } } } });
    const hostile = report({ tenant_id: "attacker-tenant", client_id: "attacker-client" });

    const res = await persistEntityAuthority(
      fake.client as unknown as Supabase,
      "tenant-real",
      { clientId: "client-real", propertyId: "prop-real" },
      hostile,
    );

    expect(res.entityId).toBe("row-1");
    const row = fake.inserts[0].values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-real");
    expect(row.client_id).toBe("client-real");
    expect(row.property_id).toBe("prop-real");
    expect(row.tenant_id).not.toBe("attacker-tenant");
    expect((row.score as Record<string, unknown>).kind).toBe(ENTITY_AUTHORITY_KIND);
  });

  it("fails soft with an interface-voice warning on a write error (assessment still real)", async () => {
    const fake = fakePostgrest({ audits: { insert: { error: { message: "boom", code: "23505" } } } });
    const res = await persistEntityAuthority(fake.client as unknown as Supabase, "t", { clientId: "c", propertyId: "p" }, report());
    expect(res.entityId).toBeNull();
    expect(res.saveWarning).toBeTruthy();
  });
});

describe("persistEntityAuthority — redacted telemetry", () => {
  it("logs ONLY the marker, stage, and bare code — never message/details or ids", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakePostgrest({
      audits: {
        insert: { error: { message: "duplicate key for tenant abc-123", code: "23505", details: "secret row data" } },
      },
    });
    await persistEntityAuthority(fake.client as unknown as Supabase, "tenant-xyz", { clientId: "c", propertyId: "p" }, report());

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toBe(`${ENTITY_FAILURE_MARKER} stage=entity_insert code=23505`);
    expect(line).not.toContain("duplicate key");
    expect(line).not.toContain("secret row data");
    expect(line).not.toContain("tenant-xyz");
  });

  it("collapses a hostile non-string / oversized error code to 'unknown'", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakePostgrest({ audits: { insert: { error: { message: "x", code: "not a valid code with spaces" } } } });
    await persistEntityAuthority(fake.client as unknown as Supabase, "t", { clientId: "c", propertyId: "p" }, report());
    expect((spy.mock.calls[0][0] as string)).toContain("code=unknown");
  });
});

describe("readEntityAuthorityHistory — kind-filtered (M2/M14 rows never leak in)", () => {
  it("returns ONLY entity-authority captures, newest-first, client-scoped", async () => {
    const fake = fakePostgrest({
      audits: {
        select: {
          data: [
            { id: "e1", property_id: "p", created_at: "2026-07-02T00:00:00Z", score: { kind: ENTITY_AUTHORITY_KIND, overallScore: 80, pressCorroborated: 1, pressClaimed: 2, fixCount: 3 } },
            { id: "a2", property_id: "p", created_at: "2026-07-01T00:00:00Z", score: { overallScore: 55 } }, // an M2 audit row — excluded
            { id: "l3", property_id: "p", created_at: "2026-07-01T00:00:00Z", score: { kind: "local_assessment", overallScore: 40 } }, // M14 — excluded
          ],
        },
      },
    });
    const res = await readEntityAuthorityHistory(fake.client as unknown as Supabase, "client-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(res.entries[0].overallScore).toBe(80);
    expect(fake.selects[0].filters.client_id).toBe("client-1");
  });

  it("reports failure honestly on a read error", async () => {
    const fake = fakePostgrest({ audits: { select: { error: { message: "denied", code: "42501" } } } });
    const res = await readEntityAuthorityHistory(fake.client as unknown as Supabase, "c");
    expect(res.ok).toBe(false);
  });
});
