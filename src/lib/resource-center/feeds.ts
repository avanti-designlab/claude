/**
 * M18 Resource Center — the downstream FEED shapes (doc 05 M18: "doubles as
 * infrastructure — feeds prompt-volume intelligence for M3 + content research
 * for M8"). PURE. No DB, no network, no logging.
 *
 * SHAPE, DON'T WIRE (task constraint; the M4 `competitorGapPlanInput` +
 * `plan-input` precedent): this module SHAPES the Q&A activity into the exact
 * read-shapes M3 and M8 consume, and returns them. Actually wiring these into
 * M3's tracked-query derivation or M8's content pipeline is a LATER integration
 * owned there — M18 stays inside resource-center/**, produces the shapes, and
 * flags them. Consumers pull; M18 never pushes into a sibling module.
 *
 *   (a) PROMPT-VOLUME → M3. The questions people actually ask are the real
 *       demand signal for which prompts to track (M3 derives its query set from
 *       the playbook `prompt_library` — these are living-list candidates with
 *       observed volume, doc 02 "living lists").
 *   (b) CONTENT-RESEARCH → M8. Topics/angles + GROUNDED facts + source URLs, in
 *       the shape M8's generation spec consumes (topic + groundingFacts). Facts
 *       come ONLY from attributed sources — never from ungrounded answer prose
 *       or fabricated citations (M18 will not hand M8 something to assert that
 *       it cannot itself ground).
 */

import type { Vertical } from "@/lib/types/playbook";
import type { GradedAnswer, ResearchScope } from "./types";

/* ------------------------------------------------------------------ */
/* (a) Prompt-volume signal → M3                                       */
/* ------------------------------------------------------------------ */

/** One asked question as an M3 tracked-query candidate. */
export interface PromptVolumeSignal {
  vertical: Vertical;
  /** The question as asked (trimmed) — the human-readable candidate prompt. */
  prompt: string;
  /** Case/whitespace-normalized key — the dedup + volume-count identity. */
  key: string;
  /** Where the demand signal came from (provenance for M3). */
  source: "resource_center";
}

/** Normalize a question to its volume-count identity: lowercase, collapse ws. */
function volumeKey(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Shape one asked question into an M3 prompt-volume signal. Empty/whitespace
 * questions yield null (nothing honest to feed).
 */
export function toPromptVolumeSignal(
  question: string,
  scope: ResearchScope,
): PromptVolumeSignal | null {
  const prompt = typeof question === "string" ? question.trim().replace(/\s+/g, " ") : "";
  if (prompt === "") return null;
  return { vertical: scope.vertical, prompt, key: volumeKey(prompt), source: "resource_center" };
}

/** One aggregated demand row — a candidate prompt with its observed volume. */
export interface PromptVolumeEntry {
  vertical: Vertical;
  prompt: string;
  /** How many asks mapped to this normalized prompt (the volume). */
  count: number;
}

/**
 * Aggregate a batch of signals into distinct candidate prompts with observed
 * volume, highest-volume first (ties broken by prompt for determinism). This is
 * the read-shape M3's derivation consumes to prioritise which prompts to track;
 * M3 pulls it, M18 does not push. Keyed by (vertical, normalized prompt) so two
 * verticals never collide.
 */
export function aggregatePromptVolume(signals: PromptVolumeSignal[]): PromptVolumeEntry[] {
  const byKey = new Map<string, PromptVolumeEntry>();
  for (const sig of signals) {
    const id = JSON.stringify([sig.vertical, sig.key]);
    const existing = byKey.get(id);
    if (existing) existing.count += 1;
    else byKey.set(id, { vertical: sig.vertical, prompt: sig.prompt, count: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.prompt.localeCompare(b.prompt),
  );
}

/* ------------------------------------------------------------------ */
/* (b) Content-research brief → M8                                     */
/* ------------------------------------------------------------------ */

/**
 * The research output M8 consumes — topic + angles + GROUNDED facts + sources,
 * in the shape M8's generation spec reads (`topic` + `groundingFacts`). An
 * ungrounded answer yields an empty `groundingFacts` (M8 must never assert a
 * fact this module could not ground), so a thin/ungrounded ask produces a thin
 * brief — honest, never padded.
 */
export interface ContentResearchBrief {
  vertical: Vertical;
  /** The question, as the research topic. */
  topic: string;
  /** Niche angles from the playbook (research directions), NOT invented. */
  angles: string[];
  /** Facts from ATTRIBUTED sources only — the anti-fabrication grounding set for M8. */
  groundingFacts: string[];
  /** The attributed source URLs backing those facts. */
  sourceUrls: string[];
  /** Mirrors the answer: false ⇒ groundingFacts is empty by construction. */
  grounded: boolean;
}

const MAX_ANGLES = 12;

/**
 * Shape one graded answer into an M8 content-research brief. Grounding facts are
 * drawn ONLY from the answer's attributed sources — never from the (possibly
 * ungrounded) answer prose and never from unattributed citations.
 */
export function toContentResearch(
  question: string,
  answer: GradedAnswer,
  scope: ResearchScope,
): ContentResearchBrief {
  const topic = typeof question === "string" ? question.trim().replace(/\s+/g, " ") : "";
  const groundingFacts = answer.grounded
    ? answer.sources.map((s) => s.snippet.trim()).filter((s) => s !== "")
    : [];
  const sourceUrls = answer.grounded ? answer.sources.map((s) => s.url) : [];
  return {
    vertical: scope.vertical,
    topic,
    angles: scope.topicAnchors.slice(0, MAX_ANGLES),
    groundingFacts,
    sourceUrls,
    grounded: answer.grounded,
  };
}
