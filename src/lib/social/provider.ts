/**
 * MediaGenerationProvider — the vendor-deferred brand-creative seam for M11 (doc
 * 05 Part B "Social design — media via Higgsfield/Motion"; doc 04 §7). Modelled on
 * the M8 `ContentGenerationProvider` + connectors `CitationDataProvider` PORT
 * pattern: the modules call THIS interface, never a vendor SDK / MCP client, so
 * the creative vendor (Higgsfield, Motion) is swappable behind one adapter.
 *
 * DEFERRED VENDOR (like the M8 Anthropic seam + the M15 review-monitor seam). The
 * real adapter is Higgsfield/Motion, reached through the integrations engineer's
 * media connection (a vendor/MCP port), reading a vault secret per doc 04 §5 —
 * NOT yet provisioned. It lands in ./live-provider at wiring time, behind this
 * port. This module ships ONLY the interface + a scriptable in-memory fake so the
 * social pipeline can be built and tested with ZERO network and NO vendor SDK/MCP
 * import (task constraint: port + injected client only).
 *
 * HOME NOTE (same as M15's ReviewPlatformProvider): the sibling vendor ports
 * (CitationDataProvider, SocialPostingProvider) live in `src/lib/connectors/`
 * (integrations territory). This one is colocated in `src/lib/social/` to respect
 * the M11 module boundary and the "stay out of connectors" task constraint; its
 * long-term home is `connectors/` alongside the others, migrated when the real
 * Higgsfield/Motion adapter (the integrations half of M11) lands.
 *
 * Code Review rule (mirrors M8): a Higgsfield/Motion SDK or MCP import outside its
 * adapter is a rejection.
 */

import type { MediaGenerationRequest, MediaRef } from "./types";

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

/**
 * The provider-agnostic brand-creative connector. Implementations:
 * `HiggsfieldAdapter` / `MotionAdapter` (deferred) plus {@link ScriptedMediaGenerationProvider}
 * for tests. Vendor keys live in the secrets vault (doc 04 §5), resolved at call
 * time by the adapter — NEVER constructor-visible state on this interface.
 */
export interface MediaGenerationProvider {
  /** Stable vendor id for provenance, e.g. "higgsfield", "motion", "scripted-fake". */
  readonly vendor: string;
  /** Generate one brand-forced creative from a fully-constrained request. Unavailable ⇒ throw (never invents an asset). */
  generate(request: MediaGenerationRequest): Promise<MediaRef>;
}

/* ------------------------------------------------------------------ */
/* Scriptable fake (M11 tests; no vendor account, no SDK/MCP, no network) */
/* ------------------------------------------------------------------ */

/**
 * A scripted response rule: first matching rule wins. `result` may be a function
 * of the request, so a test can PROVE the brand constraints actually reached the
 * provider (e.g. echo the forced palette / logo / likeness into the produced ref,
 * then assert on it) — the same journaling discipline as M8's ScriptedContentProvider.
 */
export interface MediaScript {
  /** Match this media type (omit to match any). */
  mediaType?: MediaGenerationRequest["brief"]["mediaType"];
  result: MediaRef | ((request: MediaGenerationRequest) => MediaRef);
}

/** Default output for an unscripted request — a minimal on-type stub carrying the vendor id. */
function defaultResult(request: MediaGenerationRequest): MediaRef {
  return { url: "scripted://media/stub", type: request.brief.mediaType, vendor: "scripted-fake" };
}

/**
 * Scriptable, journaling test double. Behaves like a vendor adapter without any
 * network or SDK/MCP: script responses, then assert on `calls` (the exact
 * brand-forced requests the pipeline built — palette/logo/likeness all visible).
 * Fault injection via `failNext` exercises the media_unavailable / thrown paths.
 */
export class ScriptedMediaGenerationProvider implements MediaGenerationProvider {
  readonly vendor = "scripted-fake";
  readonly calls: MediaGenerationRequest[] = [];
  private scripts: MediaScript[] = [];
  private nextError: Error | null = null;

  script(rule: MediaScript): this {
    this.scripts.push(rule);
    return this;
  }

  /** The next generate() call rejects with `error` (deferred/unavailable/thrown path). */
  failNext(error: Error = new Error("media provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  async generate(request: MediaGenerationRequest): Promise<MediaRef> {
    this.calls.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const rule = this.scripts.find(
      (s) => s.mediaType === undefined || s.mediaType === request.brief.mediaType,
    );
    if (!rule) return defaultResult(request);
    return typeof rule.result === "function" ? rule.result(request) : rule.result;
  }
}
