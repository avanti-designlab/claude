/**
 * M8 core generator — the GENERATE step of the pipeline (doc 05 Part B). Runs
 * the injected {@link ContentGenerationProvider} against the constrained spec,
 * then the two guardrail passes (anti-fabrication grounding + compliance
 * pre-screen), and returns the draft + a GENERATION REPORT for the downstream
 * review-gate consumers (Content Quality / Compliance / M9).
 *
 * Pure w.r.t. the platform: no DB, no auth, no logging — the provider is
 * INJECTED (task constraint: port + injected client only, no Anthropic SDK in
 * tested paths). The action (./actions) wires the real provider, the locked
 * kit, the playbook, and persistence around this.
 *
 * M8 GENERATES AND FLAGS; IT NEVER GATES. A compliance-pre-screen block or an
 * ungrounded-claim flag does NOT stop the draft — those are surfaced in the
 * report for the HARD gates + human to decide (doc 05: compliance-review is the
 * hard gate; a producing agent never approves OR rejects its own output on
 * quality grounds). The one thing generation refuses is producing NOTHING
 * (empty body) or running with no provider (deferred) — honest failures, not
 * verdicts.
 */

import type { ComplianceResult } from "@/lib/skills/compliance";
import type { Playbook, Vertical } from "@/lib/types/playbook";
import type { VoiceProfile } from "@/lib/types/brand";
import { buildGenerationSpec, type DraftRequest } from "./constrain";
import { findUngroundedClaims, screenCompliance, type UngroundedClaim } from "./ground";
import type { ContentGenerationProvider } from "./provider";
import type { GeneratableContentType } from "./types";

/* ------------------------------------------------------------------ */
/* Report + outcome contracts                                          */
/* ------------------------------------------------------------------ */

/** Compact, serializable compliance pre-screen summary (the full verdict is the gate's job). */
export interface CompliancePrescreen {
  /** No known-bad pattern detected. NOT a certification — see the skill disclaimer. */
  pass: boolean;
  blockCount: number;
  warnCount: number;
  /** Distinct block-violation rule ids (e.g. "cannabis.health-claims"). */
  blockedRuleIds: string[];
  /** The compliance skill's honest-scope disclaimer, carried through. */
  disclaimer: string;
}

/**
 * What the draft carries into the pipeline — the evidence the review gates,
 * M9, and the future dashboard work-log read. Every field is JSON-serializable
 * (returned from a server action). No prompt, no vendor payload, no PII.
 */
export interface GenerationReport {
  vendor: string;
  contentType: GeneratableContentType;
  /** Brand voice descriptors ENFORCED at generation (from the locked kit). */
  voiceEnforced: string[];
  /** How the draft was mapped to the playbook (AEO/plan mapping). */
  playbookMapping: {
    vertical: Vertical;
    templates: string[];
    targetPrompt: string | null;
  };
  /** Candidate ungrounded factual assertions — flagged, never emitted as verified fact. */
  ungroundedClaims: UngroundedClaim[];
  /** Deterministic compliance guardrail result (NOT the compliance-review verdict). */
  compliancePrescreen: CompliancePrescreen;
}

export type GenerateContentOutcome =
  | { ok: true; title: string; body: string; report: GenerationReport }
  | { ok: false; reason: "generation_unavailable" | "empty_generation"; cause?: unknown };

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface GenerateContentInput {
  request: DraftRequest;
  /** The loaded, ACTIVE vertical playbook (the action enforces activeness). */
  playbook: Playbook;
  /** The LOCKED brand kit's voice profile (the action refuses to reach here without one). */
  voice: VoiceProfile;
}

/* ------------------------------------------------------------------ */
/* generateContentDraft                                                */
/* ------------------------------------------------------------------ */

function summarizePrescreen(result: ComplianceResult): CompliancePrescreen {
  return {
    pass: result.pass,
    blockCount: result.violations.length,
    warnCount: result.warnings.length,
    blockedRuleIds: [...new Set(result.violations.map((v) => v.ruleId))].sort(),
    disclaimer: result.disclaimer,
  };
}

/**
 * Generate one draft. The provider is injected; a thrown/rejected provider (the
 * deferred adapter, a timeout, a vendor error) maps to `generation_unavailable`
 * WITHOUT surfacing the raw cause as content — the action logs a redacted line.
 * An empty body is `empty_generation` (there is nothing to persist as a draft).
 */
export async function generateContentDraft(
  provider: ContentGenerationProvider,
  input: GenerateContentInput,
): Promise<GenerateContentOutcome> {
  const spec = buildGenerationSpec({
    request: input.request,
    playbook: input.playbook,
    voice: input.voice,
  });

  let result;
  try {
    result = await provider.generate(spec);
  } catch (cause) {
    return { ok: false, reason: "generation_unavailable", cause };
  }

  const title = typeof result?.title === "string" ? result.title.trim() : "";
  const body = typeof result?.body === "string" ? result.body.trim() : "";
  if (body === "") return { ok: false, reason: "empty_generation" };

  const ungroundedClaims = findUngroundedClaims(body, spec.groundingFacts);
  const prescreen = screenCompliance(spec.playbook.vertical, spec.contentType, body);

  return {
    ok: true,
    title: title === "" ? spec.topic : title,
    body,
    report: {
      vendor: provider.vendor,
      contentType: spec.contentType,
      voiceEnforced: spec.voice.descriptors,
      playbookMapping: {
        vertical: spec.playbook.vertical,
        templates: spec.playbook.templates,
        targetPrompt: spec.playbook.targetPrompt,
      },
      ungroundedClaims,
      compliancePrescreen: summarizePrescreen(prescreen),
    },
  };
}
