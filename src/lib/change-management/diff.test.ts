/**
 * Diff-builder tests (doc 04 §2 PREVIEW). Deterministic before/after rendering;
 * `identical` marks a no-op (the §4 onboarding no-op test change relies on it).
 */

import { describe, expect, it } from "vitest";
import { buildStructuredDiff, toLines } from "./diff";
import type { ChangeTarget } from "./types";

const TARGET: ChangeTarget = { url: "https://x.example/", locator: "title" };

describe("toLines", () => {
  it("treats null as absent (no lines)", () => {
    expect(toLines(null)).toEqual([]);
  });
  it("splits strings on newlines and pretty-prints objects", () => {
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines({ k: 1 })).toContain('  "k": 1');
  });
});

describe("buildStructuredDiff", () => {
  it("flags identical before/after as a no-op with no added/removed lines", () => {
    const d = buildStructuredDiff("title", TARGET, "Same", "Same");
    expect(d.summary.identical).toBe(true);
    expect(d.summary.linesAdded).toBe(0);
    expect(d.summary.linesRemoved).toBe(0);
    expect(d.summary.label).toContain("no-op");
  });

  it("counts a single-line replacement as 1 removed + 1 added", () => {
    const d = buildStructuredDiff("title", TARGET, "Old", "New");
    expect(d.summary.identical).toBe(false);
    expect(d.summary.linesRemoved).toBe(1);
    expect(d.summary.linesAdded).toBe(1);
    expect(d.hunks.some((h) => h.kind === "removed" && h.lines.includes("Old"))).toBe(true);
    expect(d.hunks.some((h) => h.kind === "added" && h.lines.includes("New"))).toBe(true);
  });

  it("keeps shared leading/trailing lines as unchanged hunks", () => {
    const d = buildStructuredDiff("content", TARGET, "top\nMID\nbot", "top\nNEW\nbot");
    const kinds = d.hunks.map((h) => h.kind);
    expect(kinds[0]).toBe("unchanged");
    expect(kinds).toContain("removed");
    expect(kinds).toContain("added");
    expect(kinds[kinds.length - 1]).toBe("unchanged");
  });

  it("renders an absent before (null) as all-added", () => {
    const d = buildStructuredDiff("schema", TARGET, null, { "@type": "FAQPage" });
    expect(d.summary.linesRemoved).toBe(0);
    expect(d.summary.linesAdded).toBeGreaterThan(0);
  });

  it("does not mutate or drop the before/after payloads", () => {
    const before = { a: 1 };
    const after = { a: 2 };
    const d = buildStructuredDiff("meta", TARGET, before, after);
    expect(d.before).toBe(before);
    expect(d.after).toBe(after);
  });
});
