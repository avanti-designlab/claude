/**
 * metrics(source='reviews') row mapping (M15) + the read entry + the greppable
 * schema-gap flags. Pure; no DB.
 */

import { describe, expect, it } from "vitest";
import {
  reviewSignalEntry,
  reviewSignalMetricRow,
  REVIEWS_TABLE_GAP,
  REVIEW_RESPONSE_CONTENT_TYPE_GAP,
  REVIEW_RESPONSE_GENERATION_TYPE_GAP,
} from "./rows";
import { REVIEW_METRIC_SOURCE, type ReviewSignal } from "./types";

const SIGNAL: ReviewSignal = {
  windowDays: 30,
  capturedFor: "2026-07-09T00:00:00.000Z",
  totalIngested: 3,
  undatedCount: 0,
  coveredPlatforms: ["google"],
  excludedPlatforms: ["yelp"],
  sentiment: { positive: 2, neutral: 0, negative: 1, unknownBasis: 0, total: 3 },
  velocity: { currentCount: 2, priorCount: 1, perDay: 2 / 30, trend: "rising", delta: 1 },
};

describe("reviewSignalMetricRow — the honest home (metrics, source pinned)", () => {
  it("pins source='reviews' and carries claim/RLS-sourced scope + the signal", () => {
    const row = reviewSignalMetricRow({ tenantId: "tenant-1", clientId: "client-1", signal: SIGNAL });
    expect(row.source).toBe(REVIEW_METRIC_SOURCE);
    expect(row.source).toBe("reviews");
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.client_id).toBe("client-1");
    expect(row.data).toEqual({ schemaVersion: 1, signal: SIGNAL });
  });

  it("emits ONLY the columns M15 sets (captured_at/id default in-DB)", () => {
    const row = reviewSignalMetricRow({ tenantId: "t", clientId: "c", signal: SIGNAL });
    expect(Object.keys(row).sort()).toEqual(["client_id", "data", "source", "tenant_id"].sort());
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("captured_at");
  });

  it("carries NO individual review text/author in the persisted payload (counts only)", () => {
    const row = reviewSignalMetricRow({ tenantId: "t", clientId: "c", signal: SIGNAL });
    const json = JSON.stringify(row.data);
    // The signal is aggregate counts + platform names + window — no PII fields.
    expect(json).not.toContain("author");
    expect(json).not.toContain("externalId");
  });
});

describe("reviewSignalEntry — defensive read shaping", () => {
  it("shapes a well-formed row", () => {
    const entry = reviewSignalEntry({
      id: "m-1",
      source: "reviews",
      data: { schemaVersion: 1, signal: SIGNAL },
      captured_at: "2026-07-09T00:00:00Z",
    });
    expect(entry).toEqual({ id: "m-1", capturedAt: "2026-07-09T00:00:00Z", signal: SIGNAL });
  });

  it("degrades a corrupt/missing data jsonb to signal:null (never throws)", () => {
    expect(reviewSignalEntry({ id: "m-2", source: "reviews", data: "corrupt", captured_at: "t" }).signal).toBeNull();
    expect(reviewSignalEntry({ id: "m-3", source: "reviews", data: { schemaVersion: 1 }, captured_at: "t" }).signal).toBeNull();
  });
});

describe("schema-gap flags are present + descriptive (greppable, M3/M4/M8 precedent)", () => {
  it("names the three genuine gaps and proposes post-freeze homes", () => {
    expect(REVIEWS_TABLE_GAP).toMatch(/No `reviews` table/);
    expect(REVIEW_RESPONSE_CONTENT_TYPE_GAP).toMatch(/no.*'review_response' type/i);
    expect(REVIEW_RESPONSE_GENERATION_TYPE_GAP).toMatch(/review_response/);
    // Each points at the Orchestrator + Code Review path (or the M8 owner).
    expect(REVIEWS_TABLE_GAP).toMatch(/post-freeze|Orchestrator/);
    expect(REVIEW_RESPONSE_CONTENT_TYPE_GAP).toMatch(/post-freeze|Orchestrator/);
  });
});
