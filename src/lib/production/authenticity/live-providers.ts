import "server-only";

/**
 * Production wiring for M9's two vendor seams — the humanizer + the AI-detection
 * panel (doc 05 Part B; doc 07 §1.5 "pilot 2–3 vendors first; pluggable"). The
 * seam the action tests vi.mock so no test ever touches the network or a vendor
 * SDK (mirrors M8's ./live-provider and the audit ./live-fetch mocking).
 *
 * DEFERRED VENDORS. The real adapters read operator secrets from the vault (doc 04
 * §5) — a Humanizer API key + 2–3 AI-detection API keys. Those are NOT yet
 * provisioned (same class of blocker as M8's ANTHROPIC_API_KEY), so this module
 * ships providers that FAIL CLOSED honestly:
 *  - the humanizer's `humanize()` rejects with a content-free sentinel → the action
 *    maps it to `humanizer_unavailable` (never a 500, never a silent pass);
 *  - the detector panel is EMPTY → the core reports `detectors_unavailable`
 *    (< MIN_DETECTORS available) → `detection_unavailable`.
 * Neither path fabricates a score or marks anything clean.
 *
 * WIRING-TIME GATE (flagged like the write-methods first-live-connect canaries):
 * when the keys are provisioned, the real adapters are implemented HERE, behind the
 * {@link HumanizerProvider} / {@link AIDetectionProvider} ports — the ONLY files
 * that may import a humanizer/detection SDK. Register 2–3 detection adapters into
 * the returned panel array (doc 07). The gate's OUTPUT then flows to the HARD
 * Content Quality + Compliance gates once live.
 */

import type { AIDetectionProvider } from "./detector";
import type { HumanizerProvider, HumanizeResult } from "./humanizer";

/** Content-free sentinels — carry no draft, spec, score, or client data. */
export const HUMANIZER_DEFERRED =
  "Humanization is not available yet: the humanizer adapter is deferred until its operator secret " +
  "is provisioned. No text was humanized.";

export const DETECTION_DEFERRED =
  "AI-detection is not available yet: no detection vendors are provisioned (doc 07 pilots 2–3). " +
  "No detection was performed.";

/**
 * The runtime humanizer. Until an adapter is wired it fails closed; the core catches
 * the throw and returns `humanizer_unavailable`. Deliberately imports no vendor SDK.
 */
export function resolveHumanizerProvider(): HumanizerProvider {
  return {
    vendor: "humanizer-deferred",
    humanize(): Promise<HumanizeResult> {
      return Promise.reject(new Error(HUMANIZER_DEFERRED));
    },
  };
}

/**
 * The runtime detector PANEL. Until adapters are wired it is EMPTY, so the core
 * sees fewer than MIN_DETECTORS available and reports `detectors_unavailable` — an
 * honest "unavailable", never a silent pass. When 2–3 detection vendors are
 * provisioned, register their adapters into this array (the registry IS the list).
 */
export function resolveDetectorPanel(): AIDetectionProvider[] {
  return [];
}
