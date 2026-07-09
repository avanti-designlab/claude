/**
 * M5 — the AI-crawler enumeration (doc 05 M5; doc 07 §1.4).
 *
 * The doc-05 module spec names four crawlers explicitly (GPTBot, ClaudeBot,
 * PerplexityBot, Google-Extended); the task enumeration widens that to the
 * real-world set of AI user-agents an operator wants a per-crawler
 * allow/block verdict for. This list is M5's OWN concern and is deliberately
 * BROADER than the aeo-audit skill's `AI_CRAWLER_BOTS` (which is the four the
 * rubric SCORES). We reuse the skill's frozen robots parser (`isBotAllowed`)
 * to decide access for EACH crawler here — we do not re-implement precedence.
 *
 * `id` is the exact robots.txt user-agent token the crawler answers to; that
 * is what `isBotAllowed` matches (it lowercases both sides and prefix-matches
 * the crawler name against the group token, per Google's spec). Tokens are the
 * operators' published ones.
 *
 * `citationRelevant` marks crawlers whose block is the acute "why am I not
 * cited in AI ANSWERS" cause (search + live user-fetch bots, plus the four the
 * doc names): blocking them removes you from the answer surface directly.
 * Training-only third-party crawlers (Common Crawl, Bytespider, …) affect
 * training-corpus inclusion rather than immediate answer citation, so they are
 * `false` — reported, but a lower-severity finding.
 */

export type CrawlerRole =
  /** Crawls to build a training corpus (GPTBot, ClaudeBot, CCBot…). */
  | "ai_training"
  /** Indexes pages for an AI answer/search product (PerplexityBot, OAI-SearchBot). */
  | "ai_search"
  /** Fetches a page live when a user asks (RAG-at-answer-time; ChatGPT-User). */
  | "user_fetch"
  /**
   * A robots.txt-only CONTROL token, not a standalone crawler (Google-Extended,
   * Applebot-Extended): the operator's normal crawler already has the page; this
   * token governs whether the AI product may USE it. Blocking it is still a real
   * access verdict — it opts you out of that product's grounding/training.
   */
  | "training_control";

export interface AiCrawler {
  /** Exact robots.txt user-agent token (what `isBotAllowed` matches). */
  id: string;
  operator: string;
  role: CrawlerRole;
  /**
   * True when a block removes the property from an AI ANSWER surface (the
   * acute "not cited" cause). Drives alert severity (see rows.ts).
   */
  citationRelevant: boolean;
}

/**
 * The monitored AI crawlers. Order is stable (verdicts are emitted in this
 * order — determinism is a tested property). The four doc-05 crawlers lead
 * their operator groups. Extend by APPENDING (order stability) with a real,
 * published user-agent token.
 */
export const AI_CRAWLERS: readonly AiCrawler[] = [
  // OpenAI
  { id: "GPTBot", operator: "OpenAI", role: "ai_training", citationRelevant: true },
  { id: "OAI-SearchBot", operator: "OpenAI", role: "ai_search", citationRelevant: true },
  { id: "ChatGPT-User", operator: "OpenAI", role: "user_fetch", citationRelevant: true },
  // Anthropic
  { id: "ClaudeBot", operator: "Anthropic", role: "ai_training", citationRelevant: true },
  { id: "Claude-Web", operator: "Anthropic", role: "user_fetch", citationRelevant: true },
  { id: "anthropic-ai", operator: "Anthropic", role: "ai_training", citationRelevant: true },
  // Perplexity
  { id: "PerplexityBot", operator: "Perplexity", role: "ai_search", citationRelevant: true },
  { id: "Perplexity-User", operator: "Perplexity", role: "user_fetch", citationRelevant: true },
  // Google (Gemini / AI Overviews grounding + training control token)
  { id: "Google-Extended", operator: "Google", role: "training_control", citationRelevant: true },
  // Third-party / training-corpus crawlers (corpus inclusion, not answer citation)
  { id: "CCBot", operator: "Common Crawl", role: "ai_training", citationRelevant: false },
  { id: "Bytespider", operator: "ByteDance", role: "ai_training", citationRelevant: false },
  { id: "Amazonbot", operator: "Amazon", role: "ai_training", citationRelevant: false },
  { id: "Applebot-Extended", operator: "Apple", role: "training_control", citationRelevant: false },
  { id: "Meta-ExternalAgent", operator: "Meta", role: "ai_training", citationRelevant: false },
  { id: "cohere-ai", operator: "Cohere", role: "ai_training", citationRelevant: false },
] as const;
