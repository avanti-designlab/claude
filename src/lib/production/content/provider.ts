/**
 * ContentGenerationProvider — the vendor-deferred LLM seam for M8 (doc 05 Part B;
 * doc 00 §3 "In-product AI: Anthropic API"). Modelled on the `CitationDataProvider`
 * PORT pattern (src/lib/connectors/citation-data.ts): the modules call THIS
 * interface, never a vendor SDK, so the LLM is swappable behind one adapter.
 *
 * DEFERRED VENDOR (like the CitationDataProvider real adapters and the
 * write-methods live wiring): the real adapter is the Anthropic API
 * (`AnthropicContentProvider`, reading the `ANTHROPIC_API_KEY` operator secret —
 * DEFERRED, not yet provisioned; see BUILD-STATE M1b note). It lands in
 * ./live-provider at wiring time, behind this port. This module ships ONLY the
 * interface + a scriptable in-memory fake so the generation pipeline can be
 * built and tested with ZERO network and NO Anthropic SDK import (task
 * constraint: no SDK in tested code paths — port + injected client only).
 *
 * Code Review rule (mirrors doc 04 §7 for citation data): an Anthropic SDK
 * import outside its adapter is a rejection.
 */

import type {
  ContentGenerationResult,
  ContentGenerationSpec,
  GeneratableContentType,
} from "./types";

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

/**
 * The provider-agnostic content-generation connector. Implementations:
 * `AnthropicContentProvider` (deferred) | (future) other LLM adapters | plus
 * {@link ScriptedContentProvider} for tests. Vendor keys live in the secrets
 * vault (doc 04 §5), resolved at call time by the adapter — NEVER
 * constructor-visible state on this interface.
 */
export interface ContentGenerationProvider {
  /** Stable vendor id for provenance, e.g. "anthropic", "scripted-fake". */
  readonly vendor: string;
  /** Generate one draft from a fully-constrained spec. */
  generate(request: ContentGenerationSpec): Promise<ContentGenerationResult>;
}

/* ------------------------------------------------------------------ */
/* Scriptable fake (M8 tests; no vendor account, no SDK, no network)   */
/* ------------------------------------------------------------------ */

/**
 * A scripted response rule: first matching rule wins. `result` may be a function
 * of the spec, so a test can PROVE the constraints actually reached the provider
 * (e.g. echo a voice descriptor / grounding fact / compliance guardrail into the
 * body, then assert on it).
 */
export interface ContentScript {
  contentType?: GeneratableContentType;
  /** Substring or regex matched against the spec's topic. */
  topicMatch?: string | RegExp;
  result: ContentGenerationResult | ((spec: ContentGenerationSpec) => ContentGenerationResult);
}

/** Default output for an unscripted spec — a minimal on-topic stub. */
function defaultResult(spec: ContentGenerationSpec): ContentGenerationResult {
  return {
    title: spec.topic,
    body: `Direct answer about ${spec.topic}.`,
    raw: { source: "scripted-fake", scripted: false },
  };
}

/**
 * Scriptable, journaling test double. Behaves like a vendor adapter without any
 * network or SDK: script responses, then assert on `calls` (the exact specs the
 * pipeline built — voice/playbook/compliance/grounding all visible). Fault
 * injection via `failNext` exercises the generation_unavailable / thrown paths.
 */
export class ScriptedContentProvider implements ContentGenerationProvider {
  readonly vendor = "scripted-fake";
  readonly calls: ContentGenerationSpec[] = [];
  private scripts: ContentScript[] = [];
  private nextError: Error | null = null;

  script(rule: ContentScript): this {
    this.scripts.push(rule);
    return this;
  }

  /** The next generate() call rejects with `error` (deferred/unavailable/thrown path). */
  failNext(error: Error = new Error("content provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  async generate(spec: ContentGenerationSpec): Promise<ContentGenerationResult> {
    this.calls.push(spec);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const rule = this.scripts.find(
      (s) =>
        (s.contentType === undefined || s.contentType === spec.contentType) &&
        (s.topicMatch === undefined ||
          (typeof s.topicMatch === "string"
            ? spec.topic.includes(s.topicMatch)
            : s.topicMatch.test(spec.topic))),
    );
    if (!rule) return defaultResult(spec);
    return typeof rule.result === "function" ? rule.result(spec) : rule.result;
  }
}
