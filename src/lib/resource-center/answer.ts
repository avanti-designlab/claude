/**
 * M18 Resource Center — the QA engine (doc 05 Part E). Orchestrates ONE ask:
 * retrieve sources (web-search port) → answer scoped to the playbook (answer
 * port) → grade for honesty (./ground). Pure w.r.t. the platform: both providers
 * are INJECTED, no DB, no auth, no logging (task constraint: port + injected
 * client only, no Anthropic SDK in tested paths). The action (./actions) wires
 * the real providers, the loaded playbook, and the redacted telemetry around it.
 *
 * HONESTY CONTRACT (the engine's whole point):
 *  - The web-search port unavailable → retrieval empty by force, the answer is
 *    graded ungrounded/low-confidence and `webSearchAvailable: false`. Never a
 *    fabricated source.
 *  - The answer port unavailable/throwing → `answer_unavailable`, an honest
 *    empty low-confidence answer. Never a confident hallucination, never a 500.
 *  - A retrieval failure is NOT fatal: the assistant can still answer from the
 *    playbook alone (ungrounded, honestly demoted) — the playbook is the scope,
 *    the web is corroboration.
 */

import type { Playbook } from "@/lib/types/playbook";
import { gradeAnswer, unavailableAnswer } from "./ground";
import type { AnswerProvider, WebSearchProvider } from "./provider";
import { buildResearchScope } from "./scope";
import type { ResearchScope, ResourceAnswer, WebSearchResult } from "./types";

/** ⚑ Cost + honesty guard: how many sources one ask will retrieve/consider. */
export const MAX_RETRIEVED_SOURCES = 8;

export interface AnswerQuestionInput {
  question: string;
  /** The loaded, ACTIVE vertical playbook (the action enforces activeness). */
  playbook: Playbook;
}

export type AnswerQuestionOutcome =
  | { ok: true; result: ResourceAnswer }
  | { ok: false; reason: "answer_unavailable"; scope: ResearchScope; webSearchAvailable: boolean; cause?: unknown };

/**
 * Retrieve sources, tolerating an unavailable/throwing web-search port. Returns
 * the sources (possibly empty) plus whether search was actually available — the
 * grader needs that distinction (forced-empty vs genuinely-found-nothing).
 */
async function retrieveSources(
  webSearch: WebSearchProvider | null,
  scope: ResearchScope,
  question: string,
): Promise<{ sources: WebSearchResult[]; available: boolean; vendor: string | null }> {
  if (!webSearch) return { sources: [], available: false, vendor: null };
  try {
    const sources = await webSearch.search({
      query: question,
      vertical: scope.vertical,
      preferredSources: scope.citationSources,
      maxResults: MAX_RETRIEVED_SOURCES,
    });
    const clean = Array.isArray(sources)
      ? sources.filter((s) => typeof s?.url === "string" && s.url.trim() !== "").slice(0, MAX_RETRIEVED_SOURCES)
      : [];
    return { sources: clean, available: true, vendor: webSearch.vendor };
  } catch {
    // A retrieval error is a soft failure: fall back to playbook-only answering,
    // graded ungrounded. The raw cause never surfaces (it can carry the query).
    return { sources: [], available: false, vendor: null };
  }
}

/**
 * Answer one playbook-scoped question. The question is assumed clamped by the
 * caller; the engine never trusts the providers' self-reported confidence or
 * citations (the grader re-derives both).
 */
export async function answerQuestion(
  answerProvider: AnswerProvider,
  webSearch: WebSearchProvider | null,
  input: AnswerQuestionInput,
): Promise<AnswerQuestionOutcome> {
  const scope = buildResearchScope(input.playbook);
  const { sources, available, vendor: webVendor } = await retrieveSources(
    webSearch,
    scope,
    input.question,
  );

  let raw;
  try {
    raw = await answerProvider.answer({ question: input.question, scope, sources });
  } catch (cause) {
    // The deferred adapter, a timeout, or a vendor error → honest unavailable.
    return { ok: false, reason: "answer_unavailable", scope, webSearchAvailable: available, cause };
  }

  const graded = gradeAnswer(raw, sources, available);
  return {
    ok: true,
    result: {
      answer: graded,
      scope,
      vendor: { answer: answerProvider.vendor, webSearch: webVendor },
    },
  };
}

export { unavailableAnswer };
