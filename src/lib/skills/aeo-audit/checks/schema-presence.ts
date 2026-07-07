/**
 * Check 1 — Schema presence + validity (SKILL.md).
 * The playbook's `schema_profile` types present, valid JSON-LD, and matching
 * visible text (FAQPage questions must appear in the page's visible text —
 * schema/text mismatch is a manual-action risk, doc 05 M10).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft, ImpactLevel } from "../types";
import {
  clamp,
  collectJsonLdNodes,
  nodeTypes,
  normalizeWhitespace,
  rootHasContext,
  round1,
  stringProp,
} from "../util";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function missingTypeImpact(priorityIndex: number): ImpactLevel {
  if (priorityIndex <= 1) return "high";
  if (priorityIndex <= 4) return "medium";
  return "low";
}

export function checkSchemaPresence(ctx: CheckContext): CheckOutcome {
  const { site, playbook } = ctx;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];

  let totalBlocks = 0;
  let invalidBlocks = 0;
  const invalidBlockPages = new Set<string>();
  const typePages = new Map<string, string[]>();
  const mismatchPages: string[] = [];
  let mismatchCount = 0;

  for (const page of site.pages) {
    for (const raw of page.jsonLdBlocks) {
      totalBlocks += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        invalidBlocks += 1;
        invalidBlockPages.add(page.url);
        evidence.push({
          url: page.url,
          field: "json-ld",
          message: `Unparseable JSON-LD block: ${error instanceof Error ? error.message : "invalid JSON"}`,
        });
        continue;
      }

      const nodes = collectJsonLdNodes(parsed);
      if (nodes.length === 0) {
        invalidBlocks += 1;
        invalidBlockPages.add(page.url);
        evidence.push({ url: page.url, field: "json-ld", message: "JSON-LD block declares no @type node." });
        continue;
      }
      if (!rootHasContext(parsed)) {
        invalidBlocks += 1;
        invalidBlockPages.add(page.url);
        evidence.push({ url: page.url, field: "@context", message: "JSON-LD block is missing @context." });
      }

      const pageText = normalizeWhitespace(page.visibleText);
      for (const node of nodes) {
        for (const type of nodeTypes(node)) {
          const pages = typePages.get(type) ?? [];
          if (!pages.includes(page.url)) pages.push(page.url);
          typePages.set(type, pages);
        }
        // Visible-text match: FAQPage questions must appear in the page text.
        if (nodeTypes(node).includes("Question")) {
          const question = stringProp(node, "name");
          if (question !== null && !pageText.includes(normalizeWhitespace(question))) {
            mismatchCount += 1;
            if (!mismatchPages.includes(page.url)) mismatchPages.push(page.url);
            evidence.push({
              url: page.url,
              field: "FAQPage question",
              expected: "question text present in visible page text",
              found: question,
              message: `FAQPage question "${question}" does not appear in the visible page text (schema/text mismatch — manual-action risk).`,
            });
          }
        }
      }
    }
  }

  // Presence, weighted by schema_profile priority order (earlier = heavier).
  const profile = playbook.schema_profile;
  const totalPriorityWeight = profile.reduce((sum, _t, i) => sum + (profile.length - i), 0);
  let presentPriorityWeight = 0;
  const missing: { type: string; index: number }[] = [];
  for (const [index, type] of profile.entries()) {
    if (typePages.has(type)) {
      presentPriorityWeight += profile.length - index;
    } else {
      missing.push({ type, index });
      evidence.push({
        field: type,
        expected: `${type} JSON-LD present on at least one page`,
        found: "not found on any crawled page",
        message: `Playbook schema_profile type #${index + 1} (${type}) is missing site-wide.`,
      });
    }
  }

  const presenceScore = totalPriorityWeight === 0 ? 100 : (presentPriorityWeight / totalPriorityWeight) * 100;
  const validityFactor = totalBlocks === 0 ? 1 : (totalBlocks - invalidBlocks) / totalBlocks;
  const mismatchPenalty = Math.min(20, mismatchCount * 5);
  const score = round1(clamp(presenceScore * validityFactor - mismatchPenalty));

  if (totalBlocks === 0) {
    evidence.push({ message: "No JSON-LD structured data found on any crawled page." });
  }

  for (const { type, index } of missing) {
    const impact = missingTypeImpact(index);
    fixes.push({
      id: `schema_presence_validity/add-${slugify(type)}`,
      checkId: "schema_presence_validity",
      title: `Add ${type} JSON-LD (playbook schema_profile #${index + 1})`,
      detail:
        `${type} is priority #${index + 1} in the ${playbook.vertical} playbook's schema_profile but was found on no crawled page. ` +
        `Generate it via the schema-generation skill; schema must match visible page text exactly.`,
      targetUrls: [site.baseUrl],
      impact,
      impactEstimate:
        impact === "high"
          ? "High — a top-priority machine-readable signal for this vertical is absent; AI engines cannot resolve it."
          : "Medium — adds a playbook-required structured-data signal AI engines consume for this vertical.",
      module: "M10",
      automationLevel: "ai_draft_human_approve",
    });
  }

  if (invalidBlocks > 0) {
    fixes.push({
      id: "schema_presence_validity/repair-invalid-json-ld",
      checkId: "schema_presence_validity",
      title: `Repair ${invalidBlocks} invalid JSON-LD block(s)`,
      detail:
        "Blocks failed to parse, declared no @type, or were missing @context. Invalid structured data is ignored by engines and wastes existing markup.",
      targetUrls: [...invalidBlockPages].sort(),
      impact: "high",
      impactEstimate: "High — invalid blocks are silently ignored; repairing them restores signals that already exist.",
      module: "M10",
      automationLevel: "ai_draft_human_approve",
    });
  }

  if (mismatchCount > 0) {
    fixes.push({
      id: "schema_presence_validity/fix-schema-text-mismatch",
      checkId: "schema_presence_validity",
      title: "Align FAQPage schema with visible page text",
      detail:
        `${mismatchCount} FAQPage question(s) in schema do not appear in the visible page text. ` +
        "Schema must match visible text exactly — mismatch is a manual-action risk (doc 05 M10).",
      targetUrls: mismatchPages.sort(),
      impact: "high",
      impactEstimate: "High — schema/text mismatch risks a manual action and undermines FAQ citation eligibility.",
      module: "M10",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
