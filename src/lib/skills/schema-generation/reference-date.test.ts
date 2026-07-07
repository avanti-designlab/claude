/**
 * FUTURE_DATE determinism (0.2 gate: CR/QA finding 3).
 *
 * `Date.now()` in the Article FUTURE_DATE check was the only nondeterminism
 * across the four skill libraries. The request now takes an optional
 * `referenceDate` (ISO string) used as "now" by that check; when absent,
 * behavior is unchanged (wall clock).
 */

import { describe, expect, it } from "vitest";
import { generateSchema } from "./generate";
import type { ArticleInput, ValidationIssue } from "./types";

const article: ArticleInput = {
  headline: "Dubai Freehold Zones: The Complete Guide",
  authorName: "Daniel Reyes",
  datePublished: "2030-06-01",
};
const pageText = "Dubai Freehold Zones: The Complete Guide\nBy Daniel Reyes";

function futureDateWarnings(referenceDate?: string, datePublished?: string): ValidationIssue[] {
  const result = generateSchema({
    schemaType: "Article",
    entity: datePublished === undefined ? article : { ...article, datePublished },
    visiblePageText: pageText,
    referenceDate,
  });
  // FUTURE_DATE is a warning — it flags, it never blocks.
  expect(result.status).toBe("ready");
  return result.warnings.filter((w) => w.code === "FUTURE_DATE");
}

describe("FUTURE_DATE with an injected referenceDate (deterministic)", () => {
  it("warns when datePublished is after the injected referenceDate", () => {
    const warnings = futureDateWarnings("2029-12-31");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("datePublished");
  });

  it("does not warn when datePublished is on or before the injected referenceDate", () => {
    // Same instant is not "future" (strict comparison)...
    expect(futureDateWarnings("2030-06-01")).toHaveLength(0);
    // ...and a later reference clearly is not.
    expect(futureDateWarnings("2031-01-01")).toHaveLength(0);
  });

  it("is fully deterministic: identical requests yield identical results, wall clock irrelevant", () => {
    const request = {
      schemaType: "Article" as const,
      entity: article,
      visiblePageText: pageText,
      referenceDate: "2029-12-31",
    };
    expect(generateSchema(request)).toEqual(generateSchema(request));
  });

  it("keeps default wall-clock behavior when referenceDate is absent", () => {
    // A genuinely past date never warns; a far-future date always does —
    // true on any realistic wall clock, so no time bomb in the suite.
    expect(futureDateWarnings(undefined, "2020-01-01")).toHaveLength(0);
    expect(futureDateWarnings(undefined, "9999-12-31")).toHaveLength(1);
  });

  it("falls back to the wall clock when referenceDate is not a valid ISO date", () => {
    expect(futureDateWarnings("not-a-date", "9999-12-31")).toHaveLength(1);
    expect(futureDateWarnings("not-a-date", "2020-01-01")).toHaveLength(0);
  });
});
