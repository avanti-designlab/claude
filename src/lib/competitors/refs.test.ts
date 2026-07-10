/**
 * Pins the SOV adapter — the transform whose absence (a hardcoded `[]`) meant
 * share of voice could structurally never name a competitor. Pure, no seams.
 */

import { describe, expect, it } from "vitest";
import { toCompetitorRefs } from "./refs";

describe("toCompetitorRefs", () => {
  it("maps a competitor WITH a domain to a single-element domains list", () => {
    expect(
      toCompetitorRefs([{ name: "Rival", domain: "rival.com" }])
    ).toEqual([{ name: "Rival", domains: ["rival.com"] }]);
  });

  it("maps a NAME-ONLY competitor to an empty domains list (an honest 0% slice, never dropped)", () => {
    expect(toCompetitorRefs([{ name: "No Domain Co", domain: null }])).toEqual([
      { name: "No Domain Co", domains: [] },
    ]);
  });

  it("preserves caller order across a mixed set (SOV renders one bar per competitor)", () => {
    expect(
      toCompetitorRefs([
        { name: "A", domain: "a.com" },
        { name: "B", domain: null },
        { name: "C", domain: "c.io" },
      ])
    ).toEqual([
      { name: "A", domains: ["a.com"] },
      { name: "B", domains: [] },
      { name: "C", domains: ["c.io"] },
    ]);
  });

  it("maps an empty list to an empty list (no competitors set → SOV shows client vs unattributed only)", () => {
    expect(toCompetitorRefs([])).toEqual([]);
  });
});
