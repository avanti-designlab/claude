/**
 * Check 6 — Internal-linking density (SKILL.md).
 * Orphan pages (no inbound internal links from crawled pages), dead-end pages
 * (no outbound internal links), and hub/pillar structure (at least one page
 * linking to a substantial share of the site).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { clamp, normalizeUrlForIdentity, round1 } from "../util";

const HUB_MIN_SITE_SIZE = 5; // hub structure only expected on sites larger than this
const HUB_LINK_SHARE = 0.3;

export function checkInternalLinking(ctx: CheckContext): CheckOutcome {
  const { site } = ctx;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  if (site.pages.length <= 1) {
    return {
      status: "scored",
      score: 100,
      evidence: [{ message: "Single-page crawl — internal-linking structure not assessable." }],
      fixes: [],
    };
  }

  const homeId = normalizeUrlForIdentity(site.baseUrl, site.baseUrl);
  const idByPage = new Map<string, string>();
  for (const page of site.pages) {
    const id = normalizeUrlForIdentity(page.url, site.baseUrl);
    if (id !== null) idByPage.set(page.url, id);
  }
  const knownIds = new Set(idByPage.values());

  // Inbound links between crawled pages (self-links excluded).
  const inboundCount = new Map<string, number>();
  for (const page of site.pages) {
    const selfId = idByPage.get(page.url);
    for (const href of page.internalLinks) {
      const targetId = normalizeUrlForIdentity(href, site.baseUrl);
      if (targetId === null || targetId === selfId || !knownIds.has(targetId)) continue;
      inboundCount.set(targetId, (inboundCount.get(targetId) ?? 0) + 1);
    }
  }

  const orphans: string[] = [];
  const deadEnds: string[] = [];
  let hasHub = false;
  const nonSelfShare = (page: (typeof site.pages)[number]): number => {
    const selfId = idByPage.get(page.url);
    const distinctTargets = new Set(
      page.internalLinks
        .map((href) => normalizeUrlForIdentity(href, site.baseUrl))
        .filter((id): id is string => id !== null && id !== selfId && knownIds.has(id)),
    );
    return distinctTargets.size / (site.pages.length - 1);
  };

  for (const page of site.pages) {
    const id = idByPage.get(page.url);
    const isHome = id !== undefined && id === homeId;
    if (!isHome && id !== undefined && (inboundCount.get(id) ?? 0) === 0) {
      orphans.push(page.url);
      evidence.push({
        url: page.url,
        field: "inbound links",
        found: "0",
        message: "Orphan page — no crawled page links to it; link-following crawlers cannot discover it.",
      });
    }
    if (page.internalLinks.length === 0) {
      deadEnds.push(page.url);
      evidence.push({
        url: page.url,
        field: "outbound links",
        found: "0",
        message: "Dead-end page — links out to nothing; passes no authority onward.",
      });
    }
    if (nonSelfShare(page) >= HUB_LINK_SHARE) hasHub = true;
  }

  const nonHomeCount = Math.max(site.pages.length - 1, 1);
  const orphanRatio = orphans.length / nonHomeCount;
  const deadEndRatio = deadEnds.length / site.pages.length;
  const needsHub = site.pages.length > HUB_MIN_SITE_SIZE;
  const hubPenalty = needsHub && !hasHub ? 20 : 0;
  if (hubPenalty > 0) {
    evidence.push({
      field: "hub structure",
      message: `No hub/pillar page links to ≥${Math.round(HUB_LINK_SHARE * 100)}% of the site — no pillar structure detected.`,
    });
  }

  const score = round1(clamp(100 - orphanRatio * 60 - deadEndRatio * 20 - hubPenalty));

  if (orphans.length > 0) {
    fixes.push({
      id: "internal_linking/link-orphan-pages",
      checkId: "internal_linking",
      title: `Add internal links to ${orphans.length} orphan page(s)`,
      detail: "Link each orphan from relevant hub/pillar and sibling pages so crawlers and engines can discover it.",
      targetUrls: [...orphans].sort(),
      impact: "high",
      impactEstimate: "High — orphan pages are effectively unpublished for link-following crawlers.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (deadEnds.length > 0) {
    fixes.push({
      id: "internal_linking/fix-dead-ends",
      checkId: "internal_linking",
      title: `Add outbound internal links to ${deadEnds.length} dead-end page(s)`,
      detail: "Dead-end pages should link onward to related pillar/sibling content.",
      targetUrls: [...deadEnds].sort(),
      impact: "low",
      impactEstimate: "Low — improves crawl flow and topical clustering.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (hubPenalty > 0) {
    fixes.push({
      id: "internal_linking/build-hub-structure",
      checkId: "internal_linking",
      title: "Build a hub/pillar page linking the topic cluster together",
      detail: "No page links to a substantial share of the site. Create or expand a pillar page per the playbook's content templates.",
      targetUrls: [site.baseUrl],
      impact: "medium",
      impactEstimate: "Medium — hub/pillar structure concentrates authority and is the playbook's content backbone.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
