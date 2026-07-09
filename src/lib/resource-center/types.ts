/**
 * M18 Resource Center — shared types (doc 05 Part E; doc 07 §1.9).
 *
 * The playbook-scoped Q&A assistant: operators or clients ask AEO/industry
 * questions and get an answer GROUNDED in the client's loaded playbook + the
 * sources a web search retrieved. Two vendor-deferred seams sit behind ports
 * (mirroring the M8 `ContentGenerationProvider` discipline, doc 04 §7):
 *   - {@link AnswerProvider}    — the Claude/Anthropic answering LLM (DEFERRED).
 *   - {@link WebSearchProvider} — the web-search retrieval source (DEFERRED).
 * Modules call the PORTS, never a vendor SDK; a vendor SDK import outside its
 * adapter is a Code Review rejection.
 *
 * HONESTY IS THE PRODUCT (doc 05 M18: "research aids for humans, not
 * auto-published content"). The engine never fabricates an answer OR a source:
 * a cited source must trace to something the search actually returned, an
 * unsourced answer is graded low-confidence, and a provider that is unavailable
 * is reported honestly — never a confident-sounding hallucination.
 */

import type { Json } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";

/* ------------------------------------------------------------------ */
/* Scope — what "playbook-scoped" means, concretely                    */
/* ------------------------------------------------------------------ */

/**
 * The retrieval + answering scope derived from the client's loaded playbook
 * (see ./scope). Every field is a GROUNDING constraint handed to both ports so
 * the answer is vertical-aware, prefers the niche's authoritative sources, and
 * stays inside the compliance ruleset — scoped at ask time, not patched after.
 */
export interface ResearchScope {
  vertical: Vertical;
  playbookVersion: string;
  /**
   * `citation_sources` — the third-party sources AI engines pull from in this
   * niche. Used to bias web-search retrieval and to recognise authoritative
   * results; NOT an allow-list that fabricates authority for a random result.
   */
  citationSources: string[];
  /**
   * Topic anchors mined from the playbook `prompt_library` (bracket tokens
   * stripped) — what the niche actually asks AI about. Seeds content-research
   * angles and keeps the assistant on-vertical.
   */
  topicAnchors: string[];
  /** `entity_signals` — what makes the client resolvable to AI engines. */
  entitySignals: string[];
  /** `skill://compliance-ruleset/<vertical>` — carried for the provider + the gate. */
  complianceRef: string;
}

/* ------------------------------------------------------------------ */
/* Web-search port I/O (retrieval — DEFERRED vendor)                   */
/* ------------------------------------------------------------------ */

/** One retrieved source — the ONLY thing an answer may attribute a claim to. */
export interface WebSearchResult {
  title: string;
  /** Canonical result URL — the attribution key (normalized before matching). */
  url: string;
  /** A short extract; the only source text that may become a grounding fact. */
  snippet: string;
}

/** What the search port is asked to retrieve for one question. */
export interface WebSearchRequest {
  query: string;
  vertical: Vertical;
  /** The niche's authoritative sources (scope.citationSources) to bias retrieval. */
  preferredSources: string[];
  /** Hard cap on results the engine will consider (cost + honesty guard). */
  maxResults: number;
}

/* ------------------------------------------------------------------ */
/* Answer port I/O (the LLM — DEFERRED vendor)                         */
/* ------------------------------------------------------------------ */

/** The fully-scoped request handed to the {@link AnswerProvider}. */
export interface AnswerRequest {
  /** The user's question (clamped upstream). */
  question: string;
  /** The playbook scope the answer must stay inside. */
  scope: ResearchScope;
  /** The sources retrieved for this question — the answer's grounding set. */
  sources: WebSearchResult[];
}

/**
 * The provider's raw answer. Advisory only — the engine RE-GRADES it (see
 * ./ground) and never trusts these fields as final: `citedSourceUrls` are
 * verified against the retrieved set, and `selfConfidence` is a hint the grader
 * may only lower.
 */
export interface AnswerProviderResult {
  /** The answer prose. Empty ⇒ nothing to say (treated as "not found"). */
  answer: string;
  /** URLs the provider claims it used — each is verified against the retrieved sources. */
  citedSourceUrls: string[];
  /**
   * The provider's honest "I could find no grounded answer" signal. When false,
   * the engine reports "not found" rather than emitting ungrounded prose.
   */
  answered: boolean;
  /** The provider's self-reported confidence — advisory; the grader may only lower it. */
  selfConfidence?: Confidence;
  /**
   * Verbatim vendor payload — audit/debug ONLY, never interpreted, never
   * persisted or logged (it can carry the prompt/PII).
   */
  raw: Json;
}

/* ------------------------------------------------------------------ */
/* The graded, honest answer the engine returns                        */
/* ------------------------------------------------------------------ */

export type Confidence = "high" | "medium" | "low";

/** A source the answer is actually allowed to stand on (present in retrieval). */
export interface AttributedSource {
  title: string;
  url: string;
  snippet: string;
}

/**
 * The engine's honest verdict on one answer (see ./ground for the rules). This
 * is what {@link ResourceAnswer} carries to the UI and the Content Quality gate.
 */
export interface GradedAnswer {
  /** The answer prose (empty when not answered). */
  answer: string;
  /** True only when the provider answered AND produced non-empty prose. */
  answered: boolean;
  /**
   * True only when the answer is answered, stands on ≥1 attributed source, and
   * cited NOTHING that retrieval didn't return. An ungrounded answer is not a
   * lie — it is honestly marked so and demoted.
   */
  grounded: boolean;
  confidence: Confidence;
  /** Retrieved sources the answer actually attributes a claim to. */
  sources: AttributedSource[];
  /**
   * URLs the provider cited that were NOT in the retrieved set — the
   * fabricated-source flag. STRIPPED from `sources` and surfaced here so a
   * reviewer sees exactly what the provider tried to invent authority from.
   */
  unattributedCitations: string[];
  /** False when the web-search port was unavailable (retrieval empty by force). */
  webSearchAvailable: boolean;
  /** The honest-scope note carried through to the UI. */
  disclaimer: string;
}

/**
 * The full result of one ask — the graded answer plus the two downstream FEED
 * shapes (prompt-volume for M3, content-research for M8). The feeds are SHAPED
 * for their consumers here and returned; wiring them into M3/M8 is a later
 * integration (see ./feeds).
 */
export interface ResourceAnswer {
  answer: GradedAnswer;
  scope: ResearchScope;
  vendor: {
    /** The answering LLM vendor id (e.g. "anthropic", "scripted-fake"). */
    answer: string;
    /** The web-search vendor id, or null when retrieval was unavailable. */
    webSearch: string | null;
  };
}
