/**
 * Check 12 — Freshness / staleness (SKILL.md, doc 05 M6).
 * Pages past the refresh window (relative to `crawledAt`, never wall-clock),
 * pages with no last-modified signal at all, and stale dated statistics in
 * visible text.
 *
 * HARD RULE carried on every refresh fix: `dateModified` is updated ONLY
 * where real edits were made — cosmetic date-bumping is prohibited.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { clamp, daysBetween, round1 } from "../util";

/** "as of 2023", "data from 2022", "updated 2021" … stale when ≥2 years old. */
const DATED_STAT = /\b(as of|updated(?: on| in)?|data from|statistics from|figures from|survey from)\s+((?:19|20)\d{2})\b/gi;

export function checkFreshness(ctx: CheckContext): CheckOutcome {
  const { site, options } = ctx;
  const windowDays = options.refreshWindowDays;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  if (site.pages.length === 0) {
    return { status: "scored", score: 100, evidence: [{ message: "No pages crawled." }], fixes: [] };
  }

  const stalePages: string[] = [];
  const noSignalPages: string[] = [];
  const staleStatPages: string[] = [];
  let freshCount = 0;

  const crawlYear = new Date(site.crawledAt).getUTCFullYear();

  for (const page of site.pages) {
    if (page.lastModified === null) {
      noSignalPages.push(page.url);
      evidence.push({
        url: page.url,
        field: "lastModified",
        message: "No last-modified signal (dateModified / sitemap lastmod) — freshness cannot be demonstrated to engines.",
      });
    } else {
      const age = daysBetween(page.lastModified, site.crawledAt);
      if (age !== null && age <= windowDays) {
        freshCount += 1;
      } else {
        stalePages.push(page.url);
        evidence.push({
          url: page.url,
          field: "lastModified",
          expected: `modified within ${windowDays} days of the crawl`,
          found: age === null ? `unparsable date "${page.lastModified}"` : `${Math.round(age)} days old`,
          message: `Page is past the refresh window (${windowDays} days).`,
        });
      }
    }

    // Stale dated statistics in visible text.
    DATED_STAT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DATED_STAT.exec(page.visibleText)) !== null) {
      const year = Number(match[2]);
      if (crawlYear - year >= 2) {
        if (!staleStatPages.includes(page.url)) staleStatPages.push(page.url);
        evidence.push({
          url: page.url,
          field: "stale statistic",
          found: match[0],
          message: `Dated statistic "${match[0]}" is ${crawlYear - year} years old — verify and refresh.`,
        });
      }
    }
  }

  const staleStatPenalty = Math.min(15, staleStatPages.length * 5);
  const score = round1(clamp((freshCount / site.pages.length) * 100 - staleStatPenalty));

  const refreshTargets = [...new Set([...stalePages, ...staleStatPages])].sort();
  if (refreshTargets.length > 0) {
    const staleRatio = refreshTargets.length / site.pages.length;
    fixes.push({
      id: "freshness/refresh-stale-pages",
      checkId: "freshness",
      title: `Refresh ${refreshTargets.length} stale page(s) with real content updates`,
      detail:
        `Pages are past the ${windowDays}-day refresh window or carry dated statistics. Queue genuine content refreshes ` +
        "(updated facts, stats, examples) through the content pipeline. dateModified is updated ONLY where real edits were " +
        "made — cosmetic date-bumping is discounted by Google and prohibited (doc 05 M6).",
      targetUrls: refreshTargets,
      impact: staleRatio >= 0.5 ? "high" : "medium",
      impactEstimate:
        staleRatio >= 0.5
          ? "High — most of the site reads as stale; freshness is a direct authority/citation signal."
          : "Medium — refreshing stale pages restores freshness signals engines reward.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (noSignalPages.length > 0) {
    fixes.push({
      id: "freshness/expose-lastmodified-signals",
      checkId: "freshness",
      title: `Expose last-modified signals on ${noSignalPages.length} page(s)`,
      detail:
        "Add dateModified to page schema and lastmod to the sitemap, reflecting REAL modification dates only — never bumped cosmetically.",
      targetUrls: [...noSignalPages].sort(),
      impact: "low",
      impactEstimate: "Low — makes genuine freshness legible to engines; no signal reads as unmaintained.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
