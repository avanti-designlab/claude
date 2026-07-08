/**
 * Check 5 — AI-crawler access (SKILL.md, doc 05 M5).
 * Two halves:
 *  - robots.txt: GPTBot / ClaudeBot / PerplexityBot / Google-Extended must not
 *    be blocked from the crawled paths (60% of the check score);
 *  - JS-render visibility: content must be present without client-side JS —
 *    most AI crawlers do not execute JS (40% of the check score).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { AI_CRAWLER_BOTS, isBotAllowed } from "../robots";
import { pathOf, pluralize, round1 } from "../util";

export function checkAiCrawlerAccess(ctx: CheckContext): CheckOutcome {
  const { site } = ctx;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];
  const robotsTxtUrl = `${site.baseUrl.replace(/\/$/, "")}/robots.txt`;

  // Paths tested per bot: the root plus every crawled page path (de-duplicated).
  const paths = ["/", ...site.pages.map((page) => pathOf(page.url, site.baseUrl))].filter(
    (path, index, all) => all.indexOf(path) === index,
  );

  const blockedBots: string[] = [];
  let robotsScoreSum = 0;
  for (const bot of AI_CRAWLER_BOTS) {
    const blockedPaths = paths.filter((path) => !isBotAllowed(site.robotsTxt, bot, path));
    robotsScoreSum += (paths.length - blockedPaths.length) / paths.length;
    if (blockedPaths.length > 0) {
      blockedBots.push(bot);
      evidence.push({
        url: robotsTxtUrl,
        field: bot,
        found: `blocked from ${blockedPaths.length}/${paths.length} tested paths`,
        message: `robots.txt blocks ${bot} from: ${blockedPaths.slice(0, 5).join(", ")}${blockedPaths.length > 5 ? ", …" : ""}`,
      });
    }
  }
  const robotsScore = robotsScoreSum / AI_CRAWLER_BOTS.length;

  const invisiblePages = site.pages.filter((page) => !page.rendersWithoutJs).map((page) => page.url);
  for (const url of invisiblePages) {
    evidence.push({
      url,
      field: "rendersWithoutJs",
      message: "Primary content is not present without client-side JS — most AI crawlers see an empty page.",
    });
  }
  const renderFraction =
    site.pages.length === 0 ? 1 : (site.pages.length - invisiblePages.length) / site.pages.length;

  const score = round1(robotsScore * 60 + renderFraction * 40);

  if (blockedBots.length > 0) {
    fixes.push({
      id: "ai_crawler_access/unblock-ai-crawlers",
      checkId: "ai_crawler_access",
      title: `Unblock ${blockedBots.join(", ")} in robots.txt`,
      detail:
        "A blocked AI crawler cannot read the site at all — a page uncited past ~37 days usually has exactly this kind of block. " +
        "Remove or scope down the blocking rules — you preview the exact diff and can roll it back with one click.",
      targetUrls: [robotsTxtUrl],
      impact: "critical",
      impactEstimate:
        "Critical — no citation is possible from the blocked engines until unblocked; unblocking typically restores crawlability immediately.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (invisiblePages.length > 0) {
    fixes.push({
      id: "ai_crawler_access/fix-js-render-visibility",
      checkId: "ai_crawler_access",
      title: `Serve ${pluralize(invisiblePages.length, "page")} without client-side JS (SSR/prerender)`,
      detail:
        "Content only present after client-side JS execution is invisible to most AI crawlers. Requires rendering-architecture work (SSR, prerendering, or static fallback) by the site's developers.",
      targetUrls: [...invisiblePages].sort(),
      impact: invisiblePages.length / Math.max(site.pages.length, 1) >= 0.5 ? "critical" : "high",
      impactEstimate:
        "High — JS-invisible pages contribute nothing citable regardless of content quality; fixing render visibility unlocks every other on-page investment.",
      module: "M13",
      automationLevel: "human_only",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
