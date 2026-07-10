/**
 * Pure audit-row mapping suite (frozen schema 0005). Pins: scoping ids pinned
 * on the row; the skill's fix list stored VERBATIM in `fixes`; per-check fixes
 * stored as ids only (single source of truth — no drifted duplicate); the
 * crawl-coverage honesty record travels inside `score`; and history reads
 * parse jsonb defensively (null, never NaN, never invented).
 */

import { describe, expect, it } from "vitest";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import { auditProperty } from "./engine";
import { auditHistoryEntry, auditInsertRow, parseStoredFixes } from "./rows";

const ORIGIN = "https://client.example";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

async function runEngine() {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: GPTBot\nDisallow: /\n"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(200, `<title>Home</title><h1>Advisory</h1><p>${"Real copy here. ".repeat(6)}</p>`),
  );
  return auditProperty({
    fetchPort: fetchPort.port,
    resolvePort: async () => [{ address: "93.184.216.34" }],
    startUrl: ORIGIN,
    playbook: PLAYBOOK,
    crawledAt: CRAWLED_AT,
  });
}

const IDS = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  propertyId: "33333333-3333-4333-8333-333333333333",
};

describe("auditInsertRow — the frozen 0005 mapping", () => {
  it("pins scoping ids and stores the skill's fixes verbatim under `fixes`", async () => {
    const result = await runEngine();
    const row = auditInsertRow({ ...IDS, playbookVersion: PLAYBOOK.version, result });

    expect(row.tenant_id).toBe(IDS.tenantId);
    expect(row.client_id).toBe(IDS.clientId);
    expect(row.property_id).toBe(IDS.propertyId);
    // `fixes` column is the skill's prioritized list, untouched (no re-scoring).
    expect(row.fixes).toEqual(result.audit.fixes);
    expect(row.fixes.length).toBeGreaterThan(0);
  });

  it("stores the rubric capture in `score`, with per-check fixes reduced to ids (no duplicate fix objects)", async () => {
    const result = await runEngine();
    const row = auditInsertRow({ ...IDS, playbookVersion: PLAYBOOK.version, result });

    expect(row.score.overallScore).toBe(result.audit.overallScore);
    expect(row.score.playbookVertical).toBe("real-estate");
    expect(row.score.playbookVersion).toBe(PLAYBOOK.version);
    expect(row.score.crawledAt).toBe(CRAWLED_AT);
    expect(row.score.fixCount).toBe(result.audit.fixes.length);
    expect(row.score.checks).toHaveLength(13);

    // Each stored check carries fix IDS, not full fix objects — the full
    // objects live once, in `fixes`. Every referenced id resolves there.
    const fixIds = new Set(row.fixes.map((fix) => fix.id));
    for (const check of row.score.checks) {
      expect("fixes" in check).toBe(false);
      for (const id of check.fixIds) expect(fixIds.has(id)).toBe(true);
    }
  });

  it("carries the crawl-coverage honesty record inside `score`", async () => {
    const result = await runEngine();
    const row = auditInsertRow({ ...IDS, playbookVersion: PLAYBOOK.version, result });
    expect(row.score.coverage).toEqual(result.coverage);
    expect(row.score.coverage.crawled).toBe(1);
  });

  it("the row is JSON-serializable (jsonb columns) with no undefined leaves", () => {
    // A skipped check has no skipReason omission surprises after round-trip.
    const rowLike = auditHistoryEntry({
      id: "a",
      property_id: "p",
      created_at: "2026-07-01T00:00:00.000Z",
      score: { overallScore: 72.5, fixCount: 3, playbookVersion: "1.0.0", coverage: { attempted: 4, crawled: 3 } },
    });
    expect(rowLike).toEqual({
      id: "a",
      propertyId: "p",
      createdAt: "2026-07-01T00:00:00.000Z",
      overallScore: 72.5,
      fixCount: 3,
      pagesCrawled: 3,
      pagesFailed: 1,
      playbookVersion: "1.0.0",
    });
  });
});

describe("auditHistoryEntry — defensive jsonb parsing (null, never invented)", () => {
  it("hostile/garbage `score` yields nulls, never NaN or fabricated numbers", () => {
    for (const score of [null, "not an object", 42, [], { overallScore: "high", coverage: "nope" }]) {
      const entry = auditHistoryEntry({ id: "x", property_id: "p", created_at: "t", score });
      expect(entry.overallScore).toBeNull();
      expect(entry.fixCount).toBeNull();
      expect(entry.pagesCrawled).toBeNull();
      expect(entry.pagesFailed).toBeNull();
      expect(entry.playbookVersion).toBeNull();
    }
  });

  it("a non-finite stored overallScore collapses to null (never NaN into a trend line)", () => {
    const entry = auditHistoryEntry({
      id: "x",
      property_id: "p",
      created_at: "t",
      score: { overallScore: Number.NaN, fixCount: Number.POSITIVE_INFINITY },
    });
    expect(entry.overallScore).toBeNull();
    expect(entry.fixCount).toBeNull();
  });
});

describe("parseStoredFixes — the fix-list render projection", () => {
  it("parses the engine's real fixes verbatim, preserves priority order, drops internal codes", async () => {
    const result = await runEngine();
    const stored = result.audit.fixes; // exactly what `fixes` column holds
    expect(stored.length).toBeGreaterThan(0);

    const { rawCount, fixes } = parseStoredFixes(stored);

    // Nothing lost: every real fix carries a title, so rawCount === rendered.
    expect(rawCount).toBe(stored.length);
    expect(fixes).toHaveLength(stored.length);

    // Order is the engine's priority order (highest first), preserved.
    expect(fixes.map((f) => f.title)).toEqual(stored.map((f) => f.title));

    // The interface-voice fields survive; the internal codes are gone.
    for (let i = 0; i < fixes.length; i += 1) {
      const view = fixes[i];
      const src = stored[i];
      expect(view.title).toBe(src.title);
      expect(view.detail).toBe(src.detail);
      expect(view.impact).toBe(src.impact);
      expect(view.impactEstimate).toBe(src.impactEstimate);
      // No engine bookkeeping leaks into the render projection.
      expect(view).not.toHaveProperty("checkId");
      expect(view).not.toHaveProperty("module");
      expect(view).not.toHaveProperty("priorityScore");
      expect(view).not.toHaveProperty("automationLevel");
    }
  });

  it("reports the raw-vs-rendered delta honestly (a title-less entry is dropped, still counted)", () => {
    const { rawCount, fixes } = parseStoredFixes([
      { id: "a/x", title: "Write titles for 2 pages", impact: "high", targetUrls: ["https://e.com/a"] },
      { id: "a/y", title: "", impact: "low" }, // no plain-language title → dropped
      { id: "a/z", detail: "orphan detail" }, // no title → dropped
    ]);
    expect(rawCount).toBe(3);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].title).toBe("Write titles for 2 pages");
  });

  it("an unrecognized impact collapses to null (never an invented level)", () => {
    const { fixes } = parseStoredFixes([
      { id: "a/x", title: "Fix", impact: "URGENT!!" },
      { id: "a/y", title: "Fix 2" }, // impact absent
    ]);
    expect(fixes[0].impact).toBeNull();
    expect(fixes[1].impact).toBeNull();
  });

  it("dedupes and drops empty target URLs; a bad targetUrls shape becomes []", () => {
    const { fixes } = parseStoredFixes([
      {
        id: "a/x",
        title: "Fix",
        targetUrls: ["https://e.com/a", "https://e.com/a", "", "  ", 42, null],
      },
      { id: "a/y", title: "Fix 2", targetUrls: "not-an-array" },
    ]);
    expect(fixes[0].targetUrls).toEqual(["https://e.com/a"]);
    expect(fixes[1].targetUrls).toEqual([]);
  });

  it("hostile / absent payloads yield an empty result, never a throw", () => {
    for (const value of [null, undefined, "nope", 7, {}, [1, "x", null]]) {
      const parsed = parseStoredFixes(value);
      expect(parsed.fixes).toEqual([]);
      // A non-array reports rawCount 0; an array of junk reports its length.
      expect(parsed.rawCount).toBe(Array.isArray(value) ? value.length : 0);
    }
  });

  it("falls back to a stable render key when a stored fix has no id", () => {
    const { fixes } = parseStoredFixes([
      { title: "No id here" },
      { title: "Also no id" },
    ]);
    expect(fixes.map((f) => f.id)).toEqual(["fix-0", "fix-1"]);
  });
});
