/**
 * M12 audits-row mapping — kind discriminator, null-not-fabricated score, and
 * defensive history parsing.
 */

import { describe, expect, it } from "vitest";
import {
  ENTITY_AUTHORITY_KIND,
  entityAuthorityHistoryEntry,
  entityAuthorityInsertRow,
  entityAuthorityScoreCapture,
  isEntityAuthorityScore,
} from "./rows";
import type { EntityAuthorityReport } from "./types";

function report(over: Partial<EntityAuthorityReport> = {}): EntityAuthorityReport {
  return {
    vertical: "real-estate",
    crawledAt: "2026-07-01T00:00:00.000Z",
    assessable: true,
    person: { status: "assessed", keyPersonName: "Daniel Reyes", namePresentOnPage: true, personSchemaPresent: true, sameAsPresentInSchema: true, notes: [] },
    press: { status: "assessed", pressSectionPresent: true, claimedPress: [], corroboratedCount: 2, claimedCount: 3, notes: [] },
    coverage: null,
    fixes: [],
    ...over,
  };
}

describe("entityAuthorityScoreCapture", () => {
  it("carries the entity-authority discriminator + a real roll-up", () => {
    const cap = entityAuthorityScoreCapture(report());
    expect(cap.kind).toBe(ENTITY_AUTHORITY_KIND);
    expect(cap.overallScore).toBe(100); // all 5 signals present
    expect(cap.pressCorroborated).toBe(2);
  });

  it("overallScore is null when the site was not assessable (never a fabricated 0)", () => {
    const cap = entityAuthorityScoreCapture(
      report({
        assessable: false,
        person: { status: "not_assessable", keyPersonName: "x", namePresentOnPage: false, personSchemaPresent: false, sameAsPresentInSchema: false, notes: [] },
        press: { status: "not_assessable", pressSectionPresent: false, claimedPress: [], corroboratedCount: 0, claimedCount: 1, notes: [] },
      }),
    );
    expect(cap.overallScore).toBeNull();
  });
});

describe("entityAuthorityInsertRow", () => {
  it("uses the PASSED (claim-sourced) scope, not anything from the report", () => {
    const row = entityAuthorityInsertRow({ tenantId: "t1", clientId: "c1", propertyId: "p1", report: report() });
    expect(row.tenant_id).toBe("t1");
    expect(row.client_id).toBe("c1");
    expect(row.property_id).toBe("p1");
    expect(row.score.kind).toBe(ENTITY_AUTHORITY_KIND);
  });
});

describe("isEntityAuthorityScore + history parsing", () => {
  it("recognizes only entity-authority captures", () => {
    expect(isEntityAuthorityScore({ kind: ENTITY_AUTHORITY_KIND })).toBe(true);
    expect(isEntityAuthorityScore({ kind: "local_assessment" })).toBe(false);
    expect(isEntityAuthorityScore(null)).toBe(false);
  });

  it("maps a raw row defensively (missing fields → null, never NaN)", () => {
    const entry = entityAuthorityHistoryEntry({ id: "a1", property_id: "p", created_at: "2026-07-02T00:00:00Z", score: { overallScore: 60 } });
    expect(entry.overallScore).toBe(60);
    expect(entry.fixCount).toBeNull();
  });
});
