/**
 * Check 13 — Title / meta / H1 / alt coverage (SKILL.md).
 * On-page basics complete and non-duplicative. Per page (25 points each):
 * title present (duplicate −10, length advisory −5), meta description present
 * (duplicate −10, length advisory −5), exactly one H1 (none = 0, multiple =
 * 10), image alt coverage (fraction × 25; alt="" counts as covered).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { clamp, normalizeWhitespace, round1 } from "../util";

export function checkOnpageBasics(ctx: CheckContext): CheckOutcome {
  const { site } = ctx;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  if (site.pages.length === 0) {
    return { status: "scored", score: 100, evidence: [{ message: "No pages crawled." }], fixes: [] };
  }

  // Duplicate detection across pages.
  const titleCounts = new Map<string, number>();
  const metaCounts = new Map<string, number>();
  for (const page of site.pages) {
    if (page.title !== null && page.title.trim() !== "") {
      const key = normalizeWhitespace(page.title);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    if (page.metaDescription !== null && page.metaDescription.trim() !== "") {
      const key = normalizeWhitespace(page.metaDescription);
      metaCounts.set(key, (metaCounts.get(key) ?? 0) + 1);
    }
  }

  const missingTitles: string[] = [];
  const duplicateTitles: string[] = [];
  const missingMetas: string[] = [];
  const duplicateMetas: string[] = [];
  const h1Issues: string[] = [];
  const altGapPages: string[] = [];
  let pageScoreSum = 0;

  for (const page of site.pages) {
    let pageScore = 0;

    // Title (25)
    if (page.title === null || page.title.trim() === "") {
      missingTitles.push(page.url);
      evidence.push({ url: page.url, field: "title", message: "Missing <title>." });
    } else {
      let titleScore = 25;
      if ((titleCounts.get(normalizeWhitespace(page.title)) ?? 0) > 1) {
        titleScore -= 10;
        duplicateTitles.push(page.url);
        evidence.push({ url: page.url, field: "title", found: page.title, message: "Duplicate <title> shared with another page." });
      }
      if (page.title.length < 10 || page.title.length > 70) {
        titleScore -= 5;
        evidence.push({
          url: page.url,
          field: "title",
          found: `${page.title.length} chars`,
          message: "Title length outside the 10–70 character range.",
        });
      }
      pageScore += titleScore;
    }

    // Meta description (25)
    if (page.metaDescription === null || page.metaDescription.trim() === "") {
      missingMetas.push(page.url);
      evidence.push({ url: page.url, field: "metaDescription", message: "Missing meta description." });
    } else {
      let metaScore = 25;
      if ((metaCounts.get(normalizeWhitespace(page.metaDescription)) ?? 0) > 1) {
        metaScore -= 10;
        duplicateMetas.push(page.url);
        evidence.push({ url: page.url, field: "metaDescription", message: "Duplicate meta description shared with another page." });
      }
      if (page.metaDescription.length < 50 || page.metaDescription.length > 165) {
        metaScore -= 5;
        evidence.push({
          url: page.url,
          field: "metaDescription",
          found: `${page.metaDescription.length} chars`,
          message: "Meta description length outside the 50–165 character range.",
        });
      }
      pageScore += metaScore;
    }

    // H1 (25)
    if (page.h1s.length === 1) {
      pageScore += 25;
    } else if (page.h1s.length === 0) {
      h1Issues.push(page.url);
      evidence.push({ url: page.url, field: "h1", found: "0", message: "No H1 on the page." });
    } else {
      pageScore += 10;
      h1Issues.push(page.url);
      evidence.push({ url: page.url, field: "h1", found: `${page.h1s.length}`, message: "Multiple H1s on the page — exactly one expected." });
    }

    // Alt coverage (25) — alt="" (decorative) counts as covered; alt missing does not.
    if (page.images.length === 0) {
      pageScore += 25;
    } else {
      const covered = page.images.filter((image) => image.alt !== null).length;
      pageScore += (covered / page.images.length) * 25;
      if (covered < page.images.length) {
        altGapPages.push(page.url);
        evidence.push({
          url: page.url,
          field: "alt",
          found: `${covered}/${page.images.length} images with alt`,
          message: `${page.images.length - covered} image(s) missing alt attributes.`,
        });
      }
    }

    pageScoreSum += clamp(pageScore);
  }

  const score = round1(pageScoreSum / site.pages.length);

  const pushFix = (
    slug: string,
    title: string,
    detail: string,
    targets: string[],
    impact: "high" | "medium" | "low",
    impactEstimate: string,
  ): void => {
    if (targets.length === 0) return;
    fixes.push({
      id: `onpage_basics/${slug}`,
      checkId: "onpage_basics",
      title,
      detail,
      targetUrls: [...new Set(targets)].sort(),
      impact,
      impactEstimate,
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  };

  pushFix(
    "write-missing-titles",
    `Write titles for ${missingTitles.length} page(s)`,
    "Pages missing <title> tags. Draft per playbook keyword targets; publish via the auto-fix engine with diff preview.",
    missingTitles,
    "high",
    "High — the title is the primary on-page relevance signal for every engine.",
  );
  pushFix(
    "dedupe-titles",
    `De-duplicate titles on ${new Set(duplicateTitles).size} page(s)`,
    "Pages share identical titles — engines cannot differentiate them.",
    duplicateTitles,
    "medium",
    "Medium — duplicate titles cannibalize relevance between pages.",
  );
  pushFix(
    "write-missing-metas",
    `Write meta descriptions for ${missingMetas.length} page(s)`,
    "Pages missing meta descriptions.",
    missingMetas,
    "medium",
    "Medium — descriptions drive snippet quality and click-through.",
  );
  pushFix(
    "dedupe-metas",
    `De-duplicate meta descriptions on ${new Set(duplicateMetas).size} page(s)`,
    "Pages share identical meta descriptions.",
    duplicateMetas,
    "low",
    "Low — duplicated descriptions weaken snippet differentiation.",
  );
  pushFix(
    "fix-h1-structure",
    `Fix H1 structure on ${new Set(h1Issues).size} page(s)`,
    "Pages have zero or multiple H1s — exactly one is expected.",
    h1Issues,
    "medium",
    "Medium — a single clear H1 anchors the page's topic for parsers.",
  );
  const totalAltGaps = altGapPages.length;
  pushFix(
    "add-image-alt-text",
    `Add alt text on ${new Set(altGapPages).size} page(s)`,
    "Images missing alt attributes. Draft descriptive alts; decorative images get empty alts.",
    altGapPages,
    totalAltGaps > site.pages.length / 2 ? "medium" : "low",
    "Low–medium — alt text is an accessibility and image-understanding signal.",
  );

  return { status: "scored", score, evidence, fixes };
}
