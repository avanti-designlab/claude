import "server-only";

/**
 * Production wiring for the M11 brand-creative provider — the seam the action
 * tests vi.mock so no test ever touches the network or a vendor SDK/MCP (mirrors
 * src/lib/production/content/live-provider.ts and src/lib/reviews/live-provider.ts).
 *
 * DEFERRED VENDOR. The real adapter (Higgsfield / Motion, reached through the
 * integrations engineer's media connection and reading a vault secret per doc 04
 * §5) is NOT yet provisioned, so this module ships a provider whose `generate()`
 * FAILS CLOSED with a content-free sentinel. The action maps it to an honest
 * `media_unavailable` result — never a 500, never a silent unbranded fallback.
 *
 * WIRING-TIME GATE (like the write-methods first-live-connect canaries + the M8
 * content deferral): when the media connection is provisioned, the Higgsfield/
 * Motion adapter is implemented HERE, behind the {@link MediaGenerationProvider}
 * port — the ONLY file that may import a media-vendor SDK/MCP. Deliberately NOT
 * importing any vendor client keeps every tested code path SDK-free.
 */

import type { MediaGenerationProvider } from "./provider";
import type { MediaRef } from "./types";

/** Content-free sentinel — carries no brief, brand, secret, or client data. */
export const MEDIA_GENERATION_DEFERRED =
  "Brand creative generation is not available yet: the Higgsfield/Motion media adapter is deferred " +
  "until its vendor connection is provisioned. No media was generated.";

/**
 * The runtime provider. Until a media adapter is wired it fails closed; the action
 * catches the throw and returns `media_unavailable`.
 */
export function resolveMediaGenerationProvider(): MediaGenerationProvider {
  return {
    vendor: "media-generation-deferred",
    generate(): Promise<MediaRef> {
      return Promise.reject(new Error(MEDIA_GENERATION_DEFERRED));
    },
  };
}
