/** Shared assertions/helpers for the compliance skill test suite (not a test file). */

import { expect } from "vitest";
import type { ComplianceFinding, ComplianceResult } from "./types";

export function violation(result: ComplianceResult, ruleId: string): ComplianceFinding {
  const found = result.violations.find((v) => v.ruleId === ruleId);
  expect(
    found,
    `expected a "${ruleId}" violation; got: ${JSON.stringify(result.violations.map((v) => v.ruleId))}`,
  ).toBeDefined();
  return found as ComplianceFinding;
}

export function warning(result: ComplianceResult, ruleId: string): ComplianceFinding {
  const found = result.warnings.find((w) => w.ruleId === ruleId);
  expect(
    found,
    `expected a "${ruleId}" warning; got: ${JSON.stringify(result.warnings.map((w) => w.ruleId))}`,
  ).toBeDefined();
  return found as ComplianceFinding;
}

/** Assert a hard pass: no block violations AND no warnings. */
export function expectClean(result: ComplianceResult): void {
  expect(result.violations, "expected no violations").toEqual([]);
  expect(result.warnings, "expected no warnings").toEqual([]);
  expect(result.pass).toBe(true);
}

/** Assert the excerpt and its position both point at the same slice of the source text. */
export function expectExcerptAt(finding: ComplianceFinding, text: string, excerpt: string): void {
  expect(finding.match?.excerpt).toBe(excerpt);
  expect(finding.match?.index).toBe(text.indexOf(excerpt));
  expect(text.slice(finding.match!.index, finding.match!.index + excerpt.length)).toBe(excerpt);
}
