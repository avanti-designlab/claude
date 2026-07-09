/**
 * M18 Resource Center — public API (doc 05 Part E; doc 07 §1.9).
 *
 * The Claude-powered, playbook-scoped Q&A assistant. Owned by Integrations (the
 * vendor-deferred Anthropic + web-search seams) + AEO/SEO Logic; gated by
 * Content Quality (this is generated content). It lives in its own home
 * (src/lib/resource-center/**) and imports the playbooks + the deferred-provider
 * pattern READ-ONLY; it stays out of intelligence/**, production/**, social/, pr/.
 *
 * THE FLOW (see ./answer): retrieve sources (WebSearchProvider port, DEFERRED) →
 * answer scoped to the client's loaded playbook (AnswerProvider port = Anthropic,
 * DEFERRED) → grade for honesty (./ground: cite real sources or say "not found",
 * no fabricated authority, unsourced ⇒ low-confidence) → return the graded
 * answer + the two downstream FEED shapes (prompt-volume for M3, content-research
 * for M8, shaped-not-wired) + the honest persistence gap.
 *
 * DEFERRED VENDORS (like M8 + the write-methods live wiring): the real adapters
 * land in ./live-provider at wiring time, behind the ports. Until the
 * ANTHROPIC_API_KEY operator secret is provisioned, answering fails closed with
 * an honest `answer_unavailable`; web search is null (no fabricated sources). No
 * Anthropic/vendor SDK is imported anywhere here — a stray import is a Code
 * Review rejection (doc 04 §7).
 *
 * PERSISTENCE HONESTY (M3/M4/M15 precedent): the frozen F1 schema has no home
 * for a Q&A exchange or research brief, so nothing is persisted — the answer +
 * feeds are returned live and the gap is flagged by
 * {@link RESOURCE_CENTER_PERSISTENCE_GAP}.
 */

// The two vendor-deferred PORTS + their scriptable fakes.
export {
  type AnswerProvider,
  type WebSearchProvider,
  ScriptedAnswerProvider,
  ScriptedWebSearchProvider,
  type AnswerScript,
  type WebSearchScript,
} from "./provider";

// The QA engine (pure; providers injected) + its outcome contract.
export {
  answerQuestion,
  unavailableAnswer,
  MAX_RETRIEVED_SOURCES,
  type AnswerQuestionInput,
  type AnswerQuestionOutcome,
} from "./answer";

// Playbook scoping (the "playbook-scoped" grounding constraints).
export { buildResearchScope } from "./scope";

// The honesty grader + its disclaimers + the source-URL normalizer.
export {
  gradeAnswer,
  normalizeSourceUrl,
  RESOURCE_ANSWER_DISCLAIMER,
  RESOURCE_ANSWER_UNAVAILABLE_DISCLAIMER,
} from "./ground";

// The downstream FEED shapes (shaped-not-wired: M3 prompt-volume, M8 research).
export {
  toPromptVolumeSignal,
  aggregatePromptVolume,
  toContentResearch,
  type PromptVolumeSignal,
  type PromptVolumeEntry,
  type ContentResearchBrief,
} from "./feeds";

// Persistence decision (honest no-op against the frozen schema) + the gap flag.
export {
  persistResourceAnswer,
  RESOURCE_CENTER_PERSISTENCE_GAP,
  type PersistResourceAnswerOutcome,
} from "./persist";

// Shared types.
export type {
  ResearchScope,
  WebSearchResult,
  WebSearchRequest,
  AnswerRequest,
  AnswerProviderResult,
  Confidence,
  AttributedSource,
  GradedAnswer,
  ResourceAnswer,
} from "./types";
