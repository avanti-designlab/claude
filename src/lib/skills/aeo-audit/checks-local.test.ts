import { describe, expect, it } from "vitest";
import { checkGbpCompleteness } from "./checks/gbp-completeness";
import { checkNapConsistency } from "./checks/nap-consistency";
import { checkReviewVelocity } from "./checks/review-velocity";
import type { GbpProfileInput } from "./types";
import { ctx, makeSite, realEstatePlaybook, restaurantPlaybook } from "./fixtures";

const completeProfile: GbpProfileInput = {
  locationName: "Main St",
  primaryCategory: "Real estate agency",
  description: "Full-service advisory for international buyers.",
  phone: "(619) 555-0100",
  address: "123 Main St, San Diego, CA 92101",
  websiteUrl: "https://example.com",
  hoursComplete: true,
  photoCount: 12,
  attributesComplete: true,
  postsLast30Days: 2,
};

const entity = { name: "Acme Realty", phone: "(619) 555-0100", address: "123 Main St, San Diego, CA 92101" };

describe("check 8 — GBP completeness", () => {
  it("skips as no_data when no profiles are supplied", () => {
    const outcome = checkGbpCompleteness(ctx(makeSite(), realEstatePlaybook));
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("no_data");
  });

  it("scores a complete profile at 100 with no fixes", () => {
    const site = makeSite({ gbpProfiles: [completeProfile] });
    const outcome = checkGbpCompleteness(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(100);
    expect(outcome.fixes).toHaveLength(0);
  });

  it("itemizes gaps per field and averages across locations", () => {
    const emptyish: GbpProfileInput = {
      locationName: "Downtown",
      primaryCategory: null,
      description: null,
      phone: null,
      address: null,
      websiteUrl: null,
      hoursComplete: false,
      photoCount: 0,
      attributesComplete: false,
      postsLast30Days: 0,
    };
    const site = makeSite({ gbpProfiles: [completeProfile, emptyish] });
    const outcome = checkGbpCompleteness(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(50); // (100 + 0) / 2
    expect(outcome.evidence.some((e) => e.url === "gbp:Downtown" && e.field === "primaryCategory")).toBe(true);
    expect(outcome.evidence.some((e) => e.url === "gbp:Downtown" && e.field === "hours")).toBe(true);
    const fix = outcome.fixes.find((f) => f.id === "gbp_completeness/complete-downtown");
    expect(fix).toMatchObject({ module: "M14", automationLevel: "ai_draft_human_approve", impact: "medium" });
  });

  it("escalates impact under a gbp_priority=critical playbook (restaurants)", () => {
    const weak: GbpProfileInput = { ...completeProfile, locationName: "Hillcrest", primaryCategory: null, hoursComplete: false, photoCount: 0, postsLast30Days: 0, attributesComplete: false };
    const site = makeSite({ gbpProfiles: [weak] });
    const outcome = checkGbpCompleteness(ctx(site, restaurantPlaybook));
    expect(outcome.score).toBe(40);
    expect(outcome.fixes[0]?.impact).toBe("critical");
  });
});

describe("check 9 — NAP consistency", () => {
  it("skips as no_data without a canonical entity or without records", () => {
    expect(checkNapConsistency(ctx(makeSite({ napRecords: [] }), realEstatePlaybook)).skipReason).toBe("no_data");
    expect(checkNapConsistency(ctx(makeSite({ entity }), realEstatePlaybook)).skipReason).toBe("no_data");
  });

  it("passes when every playbook directory has a matching listing", () => {
    const site = makeSite({
      entity,
      napRecords: [
        { directory: "Google", name: "Acme Realty", address: "123 Main Street San Diego CA 92101", phone: "+16195550100" },
        { directory: "yelp", name: "Acme Realty LLC", address: "123 Main St, San Diego, CA 92101", phone: "619 555 0100" },
      ],
    });
    const outcome = checkNapConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(100);
    expect(outcome.fixes).toHaveLength(0);
  });

  it("flags missing directories (human_only creation) and mismatches (draft correction)", () => {
    const site = makeSite({
      entity,
      napRecords: [
        { directory: "Google", name: "Acme Reality Group", address: "999 Other Rd", phone: "(619) 555-0100", url: "https://maps.google.com/acme" },
        // Yelp listing absent entirely
      ],
    });
    const outcome = checkNapConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(0); // both playbook directories inconsistent
    const missing = outcome.evidence.find((e) => e.url === "nap:Yelp");
    expect(missing?.found).toBe("no listing found");
    const mismatch = outcome.evidence.find((e) => e.field === "name");
    expect(mismatch).toMatchObject({ url: "https://maps.google.com/acme", expected: "Acme Realty", found: "Acme Reality Group" });
    const createFix = outcome.fixes.find((f) => f.id === "nap_consistency/create-missing-listings");
    const correctFix = outcome.fixes.find((f) => f.id === "nap_consistency/correct-mismatched-listings");
    expect(createFix).toMatchObject({ module: "M14", automationLevel: "human_only", targetUrls: ["nap:Yelp"] });
    expect(correctFix).toMatchObject({ module: "M14", automationLevel: "ai_draft_human_approve", targetUrls: ["nap:Google"] });
  });

  it("treats a listing missing a canonical field as inconsistent, with field evidence", () => {
    const site = makeSite({
      entity,
      napRecords: [
        { directory: "Google", name: "Acme Realty", address: "123 Main St, San Diego, CA 92101", phone: null },
        { directory: "Yelp", name: "Acme Realty", address: "123 Main St, San Diego, CA 92101", phone: "(619) 555-0100" },
      ],
    });
    const outcome = checkNapConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(50);
    expect(outcome.evidence.some((e) => e.field === "phone" && e.found === "missing on listing")).toBe(true);
  });
});

describe("check 10 — review velocity", () => {
  it("skips as no_data when no snapshots are supplied", () => {
    expect(checkReviewVelocity(ctx(makeSite(), realEstatePlaybook)).skipReason).toBe("no_data");
  });

  it("passes semi-local expectations with modest velocity (relative to crawledAt)", () => {
    const site = makeSite({
      reviewSnapshots: [{ source: "Google", totalCount: 40, recentReviewDates: ["2026-06-25T00:00:00.000Z"] }],
    });
    const outcome = checkReviewVelocity(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(100); // 1 review in 30d ≥ 1; 6 days old ≤ 60
  });

  it("holds hyper-local playbooks to a stricter bar for the same data", () => {
    const site = makeSite({
      reviewSnapshots: [{ source: "Google", totalCount: 40, recentReviewDates: ["2026-06-25T00:00:00.000Z"] }],
    });
    const outcome = checkReviewVelocity(ctx(site, restaurantPlaybook));
    expect(outcome.score).toBe(55); // 60×(1/4) + 40 recency
    expect(outcome.evidence.some((e) => e.field === "velocity" && e.found === "1")).toBe(true);
    const fix = outcome.fixes[0];
    expect(fix).toMatchObject({ module: "M15", automationLevel: "human_only", impact: "high" });
    expect(fix?.detail).toContain("prohibited");
  });

  it("decays the recency component when the last review is stale", () => {
    const site = makeSite({
      reviewSnapshots: [{ source: "Google", totalCount: 12, recentReviewDates: ["2026-03-01T00:00:00.000Z"] }],
    });
    // 122 days since last review; semi-local threshold 60 → recency ≈ 40×(1 − 62/60) → 0
    const outcome = checkReviewVelocity(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(0);
    expect(outcome.evidence.some((e) => e.field === "recency")).toBe(true);
  });

  it("scores an empty snapshot list as zero velocity (data present, no reviews)", () => {
    const outcome = checkReviewVelocity(ctx(makeSite({ reviewSnapshots: [] }), realEstatePlaybook));
    expect(outcome.status).toBe("scored");
    expect(outcome.score).toBe(0);
  });
});
