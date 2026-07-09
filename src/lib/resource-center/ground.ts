/**
 * M18 Resource Center — the honesty / grounding grader (doc 05 M18: results are
 * research aids, "cite sources or say not found"). PURE — no network, no DB, no
 * LLM, no logging (a question/answer must never ride into a log line; the action
 * owns the ONE redacted telemetry line).
 *
 * The grader is the module's spine. The answer provider is untrusted: it can
 * claim any confidence and cite any URL. `gradeAnswer` re-derives the truth
 * deterministically:
 *
 *  1. NO FABRICATED SOURCES. Every URL the provider cited is checked against the
 *     URLs the web search actually RETURNED (normalized match). A citation with
 *     no retrieved match is UNATTRIBUTED — stripped from the answer's sources and
 *     surfaced in `unattributedCitations` so a reviewer sees the invented
 *     authority. The mirror of M8's grounding pass: M8 flags prose whose claims
 *     the INPUT doesn't support; M18 flags citations retrieval didn't return.
 *  2. GROUNDED ⇔ answered AND ≥1 attributed source AND nothing unattributed.
 *  3. CONFIDENCE IS ONLY EVER LOWERED from the provider's self-report:
 *     unanswered → low; unsourced → capped at low; any unattributed citation →
 *     capped at medium (fabrication risk present). An honest "not found" is a
 *     first-class, low-confidence answer — never dressed up.
 *
 * It does NOT judge semantic truth (that is a human + the Content Quality gate);
 * it enforces that the answer stands only on sources that actually exist.
 */

import type {
  AnswerProviderResult,
  AttributedSource,
  Confidence,
  GradedAnswer,
  WebSearchResult,
} from "./types";

/** Honest-scope note carried to the UI + the gate on every answer. */
export const RESOURCE_ANSWER_DISCLAIMER =
  "This is an AI research aid scoped to your industry playbook — verify against the cited sources " +
  "before you act on it. It is not legal, financial, or compliance advice, and it is never " +
  "auto-published.";

export const RESOURCE_ANSWER_UNAVAILABLE_DISCLAIMER =
  "The research assistant isn’t connected yet, so no answer was produced — nothing was inferred or " +
  "guessed.";

/** Confidence ordering so a cap is a deterministic `min`. */
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function atMost(value: Confidence, ceiling: Confidence): Confidence {
  return RANK[value] <= RANK[ceiling] ? value : ceiling;
}

const MAX_CITATIONS_SCANNED = 200;

/**
 * Normalize a URL for attribution matching: lowercase host + path, drop the
 * scheme, a trailing slash, a leading "www.", and any query/fragment. Two
 * spellings of the same page attribute to the same source; a bare non-URL
 * string canonicalizes to its trimmed lowercase self (so it can still match a
 * retrieved source stored the same way, but never accidentally matches a real
 * URL). Returns "" for empty input.
 */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") return "";
  const noScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const noQuery = noScheme.split(/[?#]/, 1)[0];
  const noWww = noQuery.replace(/^www\./i, "");
  const noTrailingSlash = noWww.replace(/\/+$/, "");
  return noTrailingSlash.toLowerCase();
}

/**
 * Grade one raw provider answer against the sources retrieval actually returned.
 * `webSearchAvailable` is false when the web-search port was unavailable — the
 * retrieval set is then empty BY FORCE (not "found nothing"), and the answer is
 * graded accordingly (unsourced → low confidence, ungrounded).
 */
export function gradeAnswer(
  result: AnswerProviderResult,
  retrieved: WebSearchResult[],
  webSearchAvailable: boolean,
): GradedAnswer {
  const answerText = typeof result?.answer === "string" ? result.answer.trim() : "";
  const answered = result?.answered === true && answerText !== "";

  // Index the retrieved sources by normalized URL — the attribution ground truth.
  const retrievedByUrl = new Map<string, WebSearchResult>();
  for (const src of retrieved) {
    const key = normalizeSourceUrl(src?.url ?? "");
    if (key !== "" && !retrievedByUrl.has(key)) retrievedByUrl.set(key, src);
  }

  // Partition the provider's citations into attributed vs fabricated.
  const attributed: AttributedSource[] = [];
  const attributedKeys = new Set<string>();
  const unattributed: string[] = [];
  const seenUnattributed = new Set<string>();
  const cited = Array.isArray(result?.citedSourceUrls) ? result.citedSourceUrls : [];
  for (const rawUrl of cited.slice(0, MAX_CITATIONS_SCANNED)) {
    if (typeof rawUrl !== "string") continue;
    const key = normalizeSourceUrl(rawUrl);
    if (key === "") continue;
    const match = retrievedByUrl.get(key);
    if (match) {
      if (!attributedKeys.has(key)) {
        attributedKeys.add(key);
        attributed.push({ title: match.title, url: match.url, snippet: match.snippet });
      }
    } else if (!seenUnattributed.has(key)) {
      seenUnattributed.add(key);
      unattributed.push(rawUrl.trim());
    }
  }

  const grounded = answered && attributed.length > 0 && unattributed.length === 0;

  // Confidence: start from the provider's hint (default medium), then only lower.
  let confidence: Confidence = result?.selfConfidence ?? "medium";
  if (!answered) confidence = "low";
  else {
    if (attributed.length === 0) confidence = atMost(confidence, "low");
    if (unattributed.length > 0) confidence = atMost(confidence, "medium");
  }

  return {
    answer: answered ? answerText : "",
    answered,
    grounded,
    confidence,
    sources: attributed,
    unattributedCitations: unattributed,
    webSearchAvailable,
    disclaimer: RESOURCE_ANSWER_DISCLAIMER,
  };
}

/**
 * The honest "provider unavailable" answer — no prose, no sources, low
 * confidence, its own disclaimer. Used when the answer port is deferred/throws
 * so the engine never emits a confident-sounding hallucination.
 */
export function unavailableAnswer(webSearchAvailable: boolean): GradedAnswer {
  return {
    answer: "",
    answered: false,
    grounded: false,
    confidence: "low",
    sources: [],
    unattributedCitations: [],
    webSearchAvailable,
    disclaimer: RESOURCE_ANSWER_UNAVAILABLE_DISCLAIMER,
  };
}
