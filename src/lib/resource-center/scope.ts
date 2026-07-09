/**
 * M18 Resource Center — playbook scoping (doc 05 Part E: "retrieval scoped to
 * the client's vertical"). PURE: no DB, no network, no LLM, no logging.
 *
 * Turns the client's loaded {@link Playbook} into a {@link ResearchScope} — the
 * grounding constraints handed to BOTH ports. Scoping is what makes the answer
 * vertical-aware instead of generic: the niche's authoritative
 * `citation_sources` bias retrieval, the `prompt_library` topics anchor the
 * assistant to what the niche actually asks AI, and the `compliance_ruleset_ref`
 * rides along so the provider avoids non-compliant claims (Compliance is still
 * the hard gate downstream).
 *
 * HONESTY: scope carries ONLY what the playbook actually holds. A thin playbook
 * yields a thin scope — never padded with invented sources or topics.
 */

import type { Playbook } from "@/lib/types/playbook";
import type { ResearchScope } from "./types";

/** Bound the anchor set so a pathological playbook can't blow up a request. */
const MAX_TOPIC_ANCHORS = 40;
const PLACEHOLDER = /\[[^\]]*\]/g;

/**
 * Reduce a `prompt_library` template to a human topic anchor: drop the bracket
 * tokens ("best [city] agent for [buyer type]" → "best agent for") and collapse
 * whitespace. Returns "" for a template that is nothing but tokens.
 */
function toTopicAnchor(template: string): string {
  return template.replace(PLACEHOLDER, " ").replace(/\s+/g, " ").trim();
}

/** Distinct, non-empty, trimmed strings in first-seen order (case-insensitive dedup). */
function distinct(values: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Build the retrieval + answering scope from the loaded playbook. Deterministic:
 * same playbook → identical scope, in stable playbook order.
 */
export function buildResearchScope(playbook: Playbook): ResearchScope {
  const topicAnchors = distinct(
    playbook.prompt_library.map((entry) => toTopicAnchor(entry.prompt)),
    MAX_TOPIC_ANCHORS,
  );
  return {
    vertical: playbook.vertical,
    playbookVersion: playbook.version,
    citationSources: distinct(playbook.citation_sources ?? [], MAX_TOPIC_ANCHORS),
    topicAnchors,
    entitySignals: distinct(playbook.entity_signals ?? [], MAX_TOPIC_ANCHORS),
    complianceRef: playbook.compliance_ruleset_ref,
  };
}
