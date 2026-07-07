/**
 * Check 4 — llms.txt present and correct (SKILL.md).
 * Correctness heuristic (llmstxt.org convention): non-empty markdown with an
 * H1 title and at least one markdown link to key content.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";

const H1_LINE = /^#\s+\S/m;
const MARKDOWN_LINK = /\[[^\]]+\]\([^)]+\)/;

export function checkLlmsTxt(ctx: CheckContext): CheckOutcome {
  const { site } = ctx;
  const llmsTxtUrl = `${site.baseUrl.replace(/\/$/, "")}/llms.txt`;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  if (site.llmsTxt === null) {
    evidence.push({ url: llmsTxtUrl, message: "llms.txt is absent." });
    fixes.push({
      id: "llms_txt/create",
      checkId: "llms_txt",
      title: "Create llms.txt",
      detail: "Publish an llms.txt at the site root: an H1 title, a short summary, and markdown links to the key citable pages.",
      targetUrls: [llmsTxtUrl],
      impact: "medium",
      impactEstimate: "Medium — llms.txt gives AI crawlers a curated map of the site's citable content.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
    return { status: "scored", score: 0, evidence, fixes };
  }

  let score = 100;
  const content = site.llmsTxt;
  if (content.trim() === "") {
    evidence.push({ url: llmsTxtUrl, field: "content", message: "llms.txt exists but is empty." });
    score = 10;
  } else {
    if (!H1_LINE.test(content)) {
      score -= 25;
      evidence.push({ url: llmsTxtUrl, field: "title", message: "llms.txt has no H1 title line (\"# Site name\")." });
    }
    if (!MARKDOWN_LINK.test(content)) {
      score -= 25;
      evidence.push({ url: llmsTxtUrl, field: "links", message: "llms.txt contains no markdown links to site content." });
    }
  }

  if (score < 100) {
    fixes.push({
      id: "llms_txt/repair",
      checkId: "llms_txt",
      title: "Repair llms.txt formatting",
      detail: "llms.txt exists but is malformed: " + evidence.map((e) => e.message).join(" "),
      targetUrls: [llmsTxtUrl],
      impact: "low",
      impactEstimate: "Low — a well-formed llms.txt is a cheap, standards-following signal for AI crawlers.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
