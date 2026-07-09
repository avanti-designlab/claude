/**
 * M6 → M1 seam: the decay refresh worklist, shaped to flow into plan
 * generation exactly like M2's audit fixes (doc 02 / doc 05).
 *
 * The plan generator already merges an audit's prioritized fixes into gap-
 * closing roadmap tasks (`generatePlan({ playbook, now, audit })`, src/lib/plan
 * → audit-merge). M6 REUSES that projection: it emits its refresh queue as the
 * same `FixDraft` shape the aeo-audit freshness check emits, so the identical
 * channel-anchoring, priority, automation-clamp, and task machinery applies —
 * no parallel merge logic.
 *
 * The fixes are namespaced `decay/…` so they never collide with the M2 audit's
 * own `freshness/…` fixes, and their owning modules route through the existing
 * `roadmapModuleForFix` mapping:
 *   • refresh queue           → M8 (content production executes the rewrite)
 *   • expose missing signal   → M13 → re-homed to M6 (metadata write, not a rewrite)
 *   • correct future-dated    → M13 → re-homed to M6
 *
 * ⚑ Plan-integration flag (for the plan-integration owner): M6's refresh queue
 * and the M2 audit's freshness check assess the SAME signal at different
 * granularity. Feeding BOTH a full `AuditResult` and this decay projection into
 * one `generatePlan` call would double-list the refresh work. The seam must
 * pick one source per regeneration — recommended: the audit's aggregate
 * freshness fix drives the scored roadmap when a full audit runs; this decay
 * projection drives plan regeneration on the freshness-only cadence (doc 05's
 * refresh sweep) when no full audit is in the loop. Roadmap tasks built this
 * way carry `source: "audit"` (the roadmap's only scan-derived source term);
 * a dedicated `source: "decay"` would require touching the frozen roadmap
 * contract (out of M6's scope) — flagged, not forced.
 */

import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import { generatePlan } from "@/lib/plan";
import type { DecayReport, PageDecayAssessment } from "./types";

/** Cap on target URLs listed inline on any single decay fix — keeps the plan
 *  task readable; the full per-page worklist lives on the DecayReport. The list
 *  is worst-first, so the cap keeps the most-decayed pages. */
const MAX_FIX_TARGET_URLS = 50;

function futureDatedPages(report: DecayReport): PageDecayAssessment[] {
  return report.pages.filter((p) => p.status === "suspect_future_dated");
}

/** age_unknown pages that have NO content decay (a metadata-signal gap, not a
 *  rewrite). age_unknown pages WITH content decay are already in the refresh
 *  queue and get a content refresh instead. */
function missingSignalPages(report: DecayReport): PageDecayAssessment[] {
  return report.pages.filter(
    (p) => p.status === "age_unknown" && !report.refreshQueue.some((q) => q.url === p.url)
  );
}

/**
 * Project a decay report into `FixDraft`s the plan generator can merge. Empty
 * when nothing is decayed — a clean site contributes no decay tasks.
 */
export function decayRefreshFixes(report: DecayReport): FixDraft[] {
  const fixes: FixDraft[] = [];

  // 1) Content refresh queue (worst-first). One fix carrying the ordered list.
  const queue = report.refreshQueue;
  if (queue.length > 0) {
    const staleCount = queue.filter((p) => p.status === "stale").length;
    const staleHeavy = staleCount / queue.length >= 0.5;
    fixes.push({
      id: "decay/refresh-decayed-pages",
      checkId: "freshness",
      title: `Refresh ${pluralize(queue.length, "decayed page")}, most-decayed first`,
      detail:
        `Pages past the ${report.refreshWindowDays}-day refresh window or carrying stale statistics / thin content, ordered worst-decay first. ` +
        "Queue genuine content refreshes (updated facts, stats, examples) through the content pipeline. " +
        "dateModified is updated ONLY where real edits were made — cosmetic date-bumping is discounted by Google and prohibited.",
      targetUrls: queue.slice(0, MAX_FIX_TARGET_URLS).map((p) => p.url),
      impact: staleHeavy ? "high" : "medium",
      impactEstimate: staleHeavy
        ? "High — most of the refresh queue is fully stale; freshness is a direct authority/citation signal."
        : "Medium — refreshing decayed pages restores freshness signals engines reward.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }

  // 2) Expose missing last-modified signals (age_unknown, no content decay).
  const missing = missingSignalPages(report);
  if (missing.length > 0) {
    fixes.push({
      id: "decay/expose-last-modified",
      checkId: "freshness",
      title: `Expose last-modified signals on ${pluralize(missing.length, "page")}`,
      detail:
        "These pages have no usable last-modified signal, so their freshness can't be shown to engines — they are age-UNKNOWN, not assumed stale. " +
        "Add dateModified to page schema and lastmod to the sitemap, reflecting REAL modification dates only — never bumped cosmetically.",
      targetUrls: sortedUrls(missing).slice(0, MAX_FIX_TARGET_URLS),
      impact: "low",
      impactEstimate: "Low — makes genuine freshness legible to engines; no signal reads as unmaintained.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }

  // 3) Correct suspect future-dated signals.
  const future = futureDatedPages(report);
  if (future.length > 0) {
    fixes.push({
      id: "decay/correct-future-dated",
      checkId: "freshness",
      title: `Correct future-dated last-modified signals on ${pluralize(future.length, "page")}`,
      detail:
        "last-modified is later than the crawl — impossible as genuine freshness (clock skew, CMS misconfig, or cosmetic date-bumping). " +
        "Set dateModified / sitemap lastmod to the REAL last-edit date. Updated ONLY where real edits were made — cosmetic date-bumping is prohibited.",
      targetUrls: sortedUrls(future).slice(0, MAX_FIX_TARGET_URLS),
      impact: "medium",
      impactEstimate:
        "Medium — engines discount implausible freshness metadata; a credible real date restores trust in the page's freshness signals.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return fixes;
}

/**
 * The `audit`-shaped input `generatePlan` consumes. `asAuditResult` (plan side)
 * only requires a `fixes` array, so this minimal object merges cleanly without
 * fabricating scores or checks the decay engine never computed.
 */
export function decayPlanInput(report: DecayReport): { fixes: FixDraft[] } {
  return { fixes: decayRefreshFixes(report) };
}

/**
 * Convenience: regenerate a plan folding the decay refresh queue in through the
 * real generator. Proves the flow end-to-end; also the entry the freshness-only
 * cadence uses. When a full audit is ALSO in the loop, concat fixes at the call
 * site instead (see the plan-integration ⚑ flag in the module header) rather
 * than calling this — do not merge both sources blindly.
 */
export function generatePlanWithDecay(args: {
  playbook: Playbook;
  now: string;
  report: DecayReport;
}): GeneratedRoadmap {
  return generatePlan({ playbook: args.playbook, now: args.now, audit: decayPlanInput(args.report) });
}

function sortedUrls(pages: PageDecayAssessment[]): string[] {
  return pages.map((p) => p.url).sort();
}

function pluralize(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
