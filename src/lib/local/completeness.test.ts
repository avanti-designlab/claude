import { describe, expect, it } from "vitest";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

/** Seed playbooks are always present — unwrap getPlaybook's null for tests. */
const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
import type { GbpProfileInput } from "@/lib/skills/aeo-audit";
import { assessGbp, assessLocalPack, GBP_READY_MIN_SCORE } from "./completeness";
import type { CanonicalLocation } from "./locations";
import type { GbpAssessment, NapAssessment } from "./types";

const COMPLETE: GbpProfileInput = {
  locationName: "Downtown",
  primaryCategory: "Restaurant",
  description: "Great food.",
  phone: "619-555-0100",
  address: "100 Main St",
  websiteUrl: "https://x.test",
  hoursComplete: true,
  photoCount: 12,
  attributesComplete: true,
  postsLast30Days: 4,
};

const INCOMPLETE: GbpProfileInput = {
  ...COMPLETE,
  primaryCategory: null,
  hoursComplete: false,
  photoCount: 0,
  postsLast30Days: 0,
};

describe("assessGbp — honest not-connected", () => {
  it("reports not_connected + a human-only connect fix (score is null, NOT zero)", () => {
    const { assessment, fixes } = assessGbp({ connected: false }, getPlaybook("restaurants"));
    expect(assessment.status).toBe("not_connected");
    expect(assessment.completenessScore).toBeNull();
    expect(assessment.gaps).toEqual([]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].id).toBe("local/connect-gbp");
    expect(fixes[0].automationLevel).toBe("human_only");
    expect(fixes[0].module).toBe("M14");
  });
});

describe("assessGbp — reuses the skill's checkGbpCompleteness", () => {
  it("a complete profile scores 100 with no gaps or fixes", () => {
    const { assessment, fixes } = assessGbp({ connected: true, profile: COMPLETE }, getPlaybook("restaurants"));
    expect(assessment.status).toBe("connected");
    expect(assessment.completenessScore).toBe(100);
    expect(assessment.gaps).toEqual([]);
    expect(fixes).toEqual([]);
  });

  it("an incomplete profile scores <100, surfaces gaps, and emits the skill's fix (module M14)", () => {
    const { assessment, fixes } = assessGbp({ connected: true, profile: INCOMPLETE }, getPlaybook("restaurants"));
    expect(assessment.completenessScore).not.toBeNull();
    expect(assessment.completenessScore!).toBeLessThan(100);
    expect(assessment.gaps).toContain("primaryCategory");
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.module === "M14")).toBe(true);
    // restaurants gbp_priority "critical" → the skill grades a low score as critical.
    expect(fixes[0].impact).toBe("critical");
  });
});

describe("assessLocalPack — readiness by ZIP", () => {
  const loc = (zip: string | null): CanonicalLocation => ({
    index: 0,
    name: "Downtown",
    address: "100 Main St",
    phone: null,
    zip,
    geo: null,
    usable: true,
  });
  const consistentNap: NapAssessment = { fields: [], consistent: true, assessable: true };
  const readyGbp: GbpAssessment = { status: "connected", completenessScore: 90, gaps: [] };

  it("all three signals present → ready", () => {
    const r = assessLocalPack(loc("92101"), consistentNap, readyGbp, true);
    expect(r.readiness).toBe("ready");
    expect(r.zip).toBe("92101");
  });

  it("some signals present → partial", () => {
    const r = assessLocalPack(loc("92101"), consistentNap, { status: "not_connected", completenessScore: null, gaps: [] }, false);
    expect(r.readiness).toBe("partial");
  });

  it("no signals → not_ready", () => {
    const noNap: NapAssessment = { fields: [], consistent: false, assessable: true };
    const r = assessLocalPack(loc("92101"), noNap, { status: "not_connected", completenessScore: null, gaps: [] }, false);
    expect(r.readiness).toBe("not_ready");
  });

  it("no discoverable ZIP → not_assessable (never claims a ZIP we don't have)", () => {
    const r = assessLocalPack(loc(null), consistentNap, readyGbp, true);
    expect(r.readiness).toBe("not_assessable");
    expect(r.zip).toBeNull();
  });

  it("a connected-but-incomplete GBP (below the readiness floor) does not count as ready", () => {
    const belowFloor: GbpAssessment = { status: "connected", completenessScore: GBP_READY_MIN_SCORE - 1, gaps: [] };
    const r = assessLocalPack(loc("92101"), consistentNap, belowFloor, true);
    expect(r.readiness).toBe("partial"); // nap + schema ready, gbp not
  });
});
