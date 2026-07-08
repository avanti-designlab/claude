/**
 * Check 11 — Core Web Vitals: pass/fail with the failing metric (SKILL.md).
 * Google thresholds: LCP ≤2500ms good / >4000ms poor; INP ≤200ms good /
 * >500ms poor; CLS ≤0.10 good / >0.25 poor. Per metric: good = 100,
 * needs-improvement = 50, poor = 0; sample score = mean of provided metrics.
 */

import type { CheckContext, CheckOutcome, CoreWebVitalsSample, EvidenceItem, FixDraft } from "../types";
import { pluralize, round1 } from "../util";

interface MetricSpec {
  key: "lcpMs" | "inpMs" | "cls";
  label: string;
  good: number;
  poor: number;
  unit: string;
}

const METRICS: MetricSpec[] = [
  { key: "lcpMs", label: "LCP", good: 2500, poor: 4000, unit: "ms" },
  { key: "inpMs", label: "INP", good: 200, poor: 500, unit: "ms" },
  { key: "cls", label: "CLS", good: 0.1, poor: 0.25, unit: "" },
];

function metricScore(spec: MetricSpec, value: number): { score: number; verdict: "good" | "needs-improvement" | "poor" } {
  if (value <= spec.good) return { score: 100, verdict: "good" };
  if (value <= spec.poor) return { score: 50, verdict: "needs-improvement" };
  return { score: 0, verdict: "poor" };
}

export function checkCoreWebVitals(ctx: CheckContext): CheckOutcome {
  const samples = (ctx.site.coreWebVitals ?? []).filter((sample: CoreWebVitalsSample) =>
    METRICS.some((spec) => sample[spec.key] !== null),
  );

  if (samples.length === 0) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No Core Web Vitals data supplied — connect field/lab data (CrUX/Lighthouse) to score." }],
      fixes: [],
    };
  }

  const evidence: EvidenceItem[] = [];
  const failingUrls: string[] = [];
  let hasPoor = false;
  let sampleScoreSum = 0;

  for (const sample of samples) {
    let metricSum = 0;
    let metricCount = 0;
    for (const spec of METRICS) {
      const value = sample[spec.key];
      if (value === null) continue;
      const { score, verdict } = metricScore(spec, value);
      metricSum += score;
      metricCount += 1;
      if (verdict !== "good") {
        if (verdict === "poor") hasPoor = true;
        if (!failingUrls.includes(sample.url)) failingUrls.push(sample.url);
        evidence.push({
          url: sample.url,
          field: spec.label,
          expected: `≤${spec.good}${spec.unit} (good)`,
          found: `${value}${spec.unit}`,
          message: `${spec.label} is ${verdict} (${value}${spec.unit}; good ≤${spec.good}${spec.unit}, poor >${spec.poor}${spec.unit}).`,
        });
      }
    }
    sampleScoreSum += metricSum / metricCount;
  }

  const score = round1(sampleScoreSum / samples.length);
  const fixes: FixDraft[] = [];

  if (failingUrls.length > 0) {
    fixes.push({
      id: "core_web_vitals/fix-failing-metrics",
      checkId: "core_web_vitals",
      title: `Fix Core Web Vitals on ${pluralize(failingUrls.length, "page")}`,
      detail:
        "Failing metrics per page are itemized in the check evidence. Performance remediation (image weight, script deferral, layout stability) is developer work on the client's stack.",
      targetUrls: [...failingUrls].sort(),
      impact: hasPoor ? "high" : "medium",
      impactEstimate: hasPoor
        ? "High — pages in the 'poor' band suppress rankings and user trust."
        : "Medium — 'needs improvement' pages leave ranking headroom on the table.",
      module: "M13",
      automationLevel: "human_only",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
