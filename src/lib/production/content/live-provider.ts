import "server-only";

/**
 * Production wiring for the M8 content-generation provider — the seam the action
 * tests vi.mock so no test ever touches the network or the Anthropic SDK
 * (mirrors src/lib/intelligence/audit/live-fetch.ts, which the audit action
 * tests mock the same way).
 *
 * DEFERRED VENDOR. The real adapter is the Anthropic API
 * (`AnthropicContentProvider`), reading the `ANTHROPIC_API_KEY` operator secret
 * from the vault (doc 04 §5). That secret is NOT yet provisioned (BUILD-STATE:
 * "Anthropic API key not yet provisioned" — same blocker that deferred M1b), so
 * this module ships a provider whose `generate()` FAILS CLOSED with a clear,
 * content-free sentinel. The action maps it to an honest
 * `generation_unavailable` result — never a 500, never a silent generic-voice
 * fallback.
 *
 * WIRING-TIME GATE (flagged like the write-methods first-live-connect canaries):
 * when the key is provisioned, the Anthropic adapter is implemented HERE, behind
 * the {@link ContentGenerationProvider} port — the ONLY file that may import the
 * Anthropic SDK. The generated OUTPUT then goes through the HARD Content Quality
 * + Compliance Review gates (they review the guardrails/pipeline now; they
 * review real generated prose once this adapter is live).
 */

import type { ContentGenerationProvider } from "./provider";
import type { ContentGenerationResult } from "./types";

/** Content-free sentinel — carries no prompt, spec, or client data. */
export const CONTENT_GENERATION_DEFERRED =
  "Content generation is not available yet: the Anthropic content adapter is deferred until the " +
  "ANTHROPIC_API_KEY operator secret is provisioned. No content was generated.";

/**
 * The runtime provider. Until the Anthropic adapter is wired it fails closed;
 * the action catches the throw and returns `generation_unavailable`. Deliberately
 * NOT importing the Anthropic SDK keeps every tested code path SDK-free.
 */
export function resolveContentProvider(): ContentGenerationProvider {
  return {
    vendor: "anthropic-deferred",
    generate(): Promise<ContentGenerationResult> {
      return Promise.reject(new Error(CONTENT_GENERATION_DEFERRED));
    },
  };
}
