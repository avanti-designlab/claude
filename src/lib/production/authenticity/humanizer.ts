/**
 * HumanizerProvider — the FIRST of M9's two vendor-deferred seams (doc 05 Part B;
 * doc 00 §3 "Humanization: Humanizer API + AI-detection API"; doc 07 §1.5 "pilot
 * 2–3 vendors first; pluggable"). Modelled on M8's ContentGenerationProvider PORT
 * and the CitationDataProvider pattern: the pipeline calls THIS interface, never a
 * vendor SDK, so the humanizer is swappable behind one adapter.
 *
 * A humanizer REWRITES an AI draft toward human-natural phrasing while PRESERVING
 * MEANING and brand voice. It does not judge; it rewrites. M9 checks its output
 * (meaning/voice-drift recheck + the detector panel) — a humanizer that silently
 * alters facts is caught downstream, never trusted blind.
 *
 * DEFERRED VENDOR (like M8's Anthropic adapter + the write-methods live wiring):
 * the real adapter reads an operator secret from the vault (doc 04 §5) and is NOT
 * yet provisioned. It lands in ./live-providers at wiring time, behind this port.
 * This module ships ONLY the interface + a scriptable in-memory fake so the whole
 * authenticity pipeline builds + tests with ZERO network and NO vendor SDK (task
 * constraint: no SDK in tested paths — port + injected client only). A humanizer
 * SDK import outside its adapter is a Code Review rejection (mirrors doc 04 §7).
 */

import type { Json } from "@/lib/types/db";
import type { VoiceProfile } from "@/lib/types/brand";

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

/** What the humanizer is asked to rewrite. The ORIGINAL body is the meaning ground-truth. */
export interface HumanizeRequest {
  /** The M8 draft body to humanize. */
  body: string;
  /** The locked brand voice — the rewrite must stay inside it (drift-checked after). */
  voice: VoiceProfile;
}

/** What a humanizer adapter returns for one rewrite. */
export interface HumanizeResult {
  /** The humanized text — M9 owns the checks around it; the vendor owns the prose. */
  text: string;
  /**
   * Verbatim vendor payload — retained for audit/debugging ONLY. Never
   * interpreted by M9, never persisted, never logged (it can carry the draft).
   */
  raw?: Json;
}

/**
 * The provider-agnostic humanizer connector. Implementations: the deferred vendor
 * adapter(s) + {@link ScriptedHumanizerProvider} for tests. Vendor keys live in
 * the secrets vault, resolved at call time by the adapter — NEVER
 * constructor-visible state on this interface.
 */
export interface HumanizerProvider {
  /** Stable vendor id for provenance, e.g. "humanizer-x", "scripted-fake". */
  readonly vendor: string;
  /** Rewrite one draft toward human-natural phrasing, preserving meaning + voice. */
  humanize(request: HumanizeRequest): Promise<HumanizeResult>;
}

/* ------------------------------------------------------------------ */
/* Scriptable fake (M9 tests; no vendor account, no SDK, no network)   */
/* ------------------------------------------------------------------ */

/**
 * Scriptable, journaling test double. Behaves like a humanizer adapter with no
 * network/SDK. By default it is the IDENTITY rewrite (returns the body verbatim —
 * a humanizer that changed nothing), so tests opt into a transform explicitly.
 * `rewrite()` can inject a meaning/voice DRIFT (e.g. add a fabricated statistic or
 * a banned phrase) to prove the drift recheck catches it; `failNext()` exercises
 * the unavailable/thrown path.
 */
export class ScriptedHumanizerProvider implements HumanizerProvider {
  readonly vendor: string;
  readonly calls: HumanizeRequest[] = [];
  private rewriter: (request: HumanizeRequest) => HumanizeResult;
  private nextError: Error | null = null;

  constructor(vendor = "scripted-fake") {
    this.vendor = vendor;
    this.rewriter = (request) => ({ text: request.body, raw: { source: vendor, transformed: false } });
  }

  /** Set the rewrite function (receives the full request; returns the humanized result or bare text). */
  rewrite(fn: (request: HumanizeRequest) => HumanizeResult | string): this {
    this.rewriter = (request) => {
      const out = fn(request);
      return typeof out === "string" ? { text: out, raw: { source: this.vendor, transformed: true } } : out;
    };
    return this;
  }

  /** The next humanize() call rejects (deferred/unavailable/thrown path). */
  failNext(error: Error = new Error("humanizer unavailable")): this {
    this.nextError = error;
    return this;
  }

  async humanize(request: HumanizeRequest): Promise<HumanizeResult> {
    this.calls.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    return this.rewriter(request);
  }
}
