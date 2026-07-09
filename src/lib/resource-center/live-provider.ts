import "server-only";

/**
 * M18 Resource Center — production wiring for the two DEFERRED vendor seams (the
 * answering LLM + web search). This is the ONLY place M18 learns which vendor
 * exists; the engine keeps importing the ports (./provider). Mirrors
 * src/lib/production/content/live-provider.ts and
 * src/lib/intelligence/visibility/provider.ts.
 *
 * DEFERRED VENDORS. The real adapters are:
 *   - `AnthropicAnswerProvider`  — Anthropic API (web-search tool), reading the
 *     `ANTHROPIC_API_KEY` operator secret from the vault (doc 04 §5). NOT yet
 *     provisioned (BUILD-STATE — same blocker that deferred M1b + M8).
 *   - a web-search vendor adapter behind {@link WebSearchProvider}.
 * Both fail closed until wired: `resolveAnswerProvider` returns a provider whose
 * `answer()` REJECTS with a content-free sentinel (the engine maps it to an
 * honest `answer_unavailable`); `resolveWebSearchProvider` returns null (the
 * engine reports `webSearchAvailable: false` — no invented sources). Deliberately
 * importing NO SDK keeps every tested code path SDK-free (Code Review rule: an
 * Anthropic SDK import outside its adapter is a rejection).
 *
 * ⚑ WIRING-TIME GATE (flagged like the write-methods first-live-connect canaries):
 * when the key is provisioned, the Anthropic adapter is implemented HERE, behind
 * the port. The generated OUTPUT is a research aid for humans (doc 05 M18) and,
 * where user-facing, goes through the HARD Content Quality gate.
 */

import type { AnswerProvider, WebSearchProvider } from "./provider";
import type { AnswerProviderResult } from "./types";

/** Content-free sentinel — carries no question, scope, or client data. */
export const RESOURCE_ANSWER_DEFERRED =
  "Resource-center answering is not available yet: the Anthropic answer adapter is deferred until " +
  "the ANTHROPIC_API_KEY operator secret is provisioned. No answer was produced.";

/**
 * The runtime answer provider. Until the Anthropic adapter is wired it fails
 * closed; the engine catches the rejection and returns `answer_unavailable`.
 * Not importing the SDK keeps every tested path SDK-free.
 */
export function resolveAnswerProvider(): AnswerProvider {
  return {
    vendor: "anthropic-deferred",
    answer(): Promise<AnswerProviderResult> {
      return Promise.reject(new Error(RESOURCE_ANSWER_DEFERRED));
    },
  };
}

/**
 * The runtime web-search provider. No vendor adapter exists yet → honest null;
 * the engine runs with an empty retrieval set and reports
 * `webSearchAvailable: false`, never a fabricated source.
 */
export function resolveWebSearchProvider(): WebSearchProvider | null {
  return null;
}
