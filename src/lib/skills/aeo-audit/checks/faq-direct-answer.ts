/**
 * Check 2 — Direct-answer FAQ formatting (SKILL.md).
 * FAQ answers must OPEN with the answer (correct AEO structure): a concise,
 * declarative first sentence — no preamble, no hedging, no answering a
 * question with a question.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FaqItem, FixDraft } from "../types";
import { collectJsonLdNodes, firstSentence, nodeTypes, round1, stringProp, wordCount } from "../util";

const MAX_DIRECT_ANSWER_WORDS = 50;

const PREAMBLE_PATTERNS: RegExp[] = [
  /^(that|it)('s| is| really)? ?depends/i,
  /^(great|good|excellent|interesting) question/i,
  /^well[,\s]/i,
  /^there (are|is) (a lot|lots|many|several|a number|so many)/i,
  /^in this (article|post|guide|section)/i,
  /^before (we|answering|diving|getting)/i,
  /^as (mentioned|discussed|noted|we know)/i,
  /^when it comes to/i,
  /^let('s| us) (start|begin|dive|explore|take a look)/i,
  /^first('| of all)?,? (let|it|you|we)/i,
  /^many people (ask|wonder)/i,
];

export interface FaqVerdict {
  direct: boolean;
  reason?: string;
  opening: string;
}

/**
 * Standalone heuristic — also used by content-quality for AEO-formatting
 * review of generated FAQ content.
 */
export function evaluateFaqAnswer(answer: string): FaqVerdict {
  const trimmed = answer.trim();
  if (trimmed === "") {
    return { direct: false, reason: "Answer is empty.", opening: "" };
  }
  const opening = firstSentence(trimmed);
  if (opening.endsWith("?")) {
    return { direct: false, reason: "Answer opens with a question instead of an answer.", opening };
  }
  const preamble = PREAMBLE_PATTERNS.find((re) => re.test(opening));
  if (preamble) {
    return { direct: false, reason: "Answer opens with preamble/hedging instead of the answer.", opening };
  }
  if (wordCount(opening) > MAX_DIRECT_ANSWER_WORDS) {
    return {
      direct: false,
      reason: `Opening sentence is ${wordCount(opening)} words (max ${MAX_DIRECT_ANSWER_WORDS} for a direct answer).`,
      opening,
    };
  }
  return { direct: true, opening };
}

/** FAQ items for a page: crawler-extracted pairs, else FAQPage JSON-LD. */
export function faqItemsForPage(page: {
  faqItems?: FaqItem[];
  jsonLdBlocks: string[];
}): FaqItem[] {
  if (page.faqItems !== undefined) return page.faqItems;
  const items: FaqItem[] = [];
  for (const raw of page.jsonLdBlocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const node of collectJsonLdNodes(parsed)) {
      if (!nodeTypes(node).includes("Question")) continue;
      const question = stringProp(node, "name");
      const accepted = node["acceptedAnswer"];
      let answer: string | null = null;
      if (typeof accepted === "object" && accepted !== null && !Array.isArray(accepted)) {
        answer = stringProp(accepted as Record<string, unknown>, "text");
      }
      if (question !== null && answer !== null) items.push({ question, answer });
    }
  }
  return items;
}

export function checkFaqDirectAnswer(ctx: CheckContext): CheckOutcome {
  const { site } = ctx;
  const evidence: EvidenceItem[] = [];
  const failingPages: string[] = [];
  let total = 0;
  let passing = 0;

  for (const page of site.pages) {
    for (const item of faqItemsForPage(page)) {
      total += 1;
      const verdict = evaluateFaqAnswer(item.answer);
      if (verdict.direct) {
        passing += 1;
      } else {
        if (!failingPages.includes(page.url)) failingPages.push(page.url);
        evidence.push({
          url: page.url,
          field: item.question,
          found: verdict.opening,
          message: verdict.reason ?? "Answer does not open with a direct answer.",
        });
      }
    }
  }

  if (total === 0) {
    return {
      status: "skipped",
      skipReason: "not_applicable",
      score: null,
      evidence: [{ message: "No FAQ content detected on any crawled page (no faqItems and no FAQPage JSON-LD)." }],
      fixes: [],
    };
  }

  const score = round1((passing / total) * 100);
  const fixes: FixDraft[] = [];
  if (passing < total) {
    fixes.push({
      id: "faq_direct_answer/rewrite-openings",
      checkId: "faq_direct_answer",
      title: `Rewrite ${total - passing} FAQ answer(s) to open with the answer`,
      detail:
        "Answers must lead with a concise declarative answer (direct-answer AEO format), then elaborate. " +
        "Rewrites go through the full content pipeline (humanize → detection → quality → compliance).",
      targetUrls: failingPages.sort(),
      impact: "high",
      impactEstimate:
        "High — direct-answer formatting is the core AEO citation format; engines lift openings verbatim.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
