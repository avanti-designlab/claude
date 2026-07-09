/**
 * Build the constrained {@link ContentGenerationSpec} from the three authorities
 * that shape M8 output (doc 05 Part B, doc 07 §1.5): the LOCKED brand voice, the
 * loaded vertical PLAYBOOK, and the vertical COMPLIANCE ruleset. Pure — no
 * network, no DB, no LLM; unit-tested in the default run.
 *
 * This is the seam that makes generic-AI output structurally hard AT GENERATION
 * (not patched after):
 *   - VOICE   — descriptors/samples/do/dont from the locked kit, verbatim.
 *   - PLAYBOOK — content_templates + schema_profile + entity_signals + a target
 *     prompt from the library, so the draft is mapped to the plan and AEO-shaped.
 *   - COMPLIANCE — block-severity rules from the vertical's compliance-ruleset,
 *     rendered into "avoid this" guidance so prohibited claims are steered away
 *     from at generation (compliance-review is still the HARD gate).
 */

import { getRuleset } from "@/lib/skills/compliance";
import type { ComplianceContentType } from "@/lib/skills/compliance";
import type { Playbook, PromptLibraryEntry, Vertical } from "@/lib/types/playbook";
import type { VoiceProfile } from "@/lib/types/brand";
import type {
  ContentGenerationSpec,
  GeneratableContentType,
  VoiceConstraint,
} from "./types";

/** The operator's request for one draft (the caller-supplied part of the spec). */
export interface DraftRequest {
  contentType: GeneratableContentType;
  topic: string;
  /** The facts the content may assert as fact (anti-fabrication grounding set). */
  groundingFacts: string[];
}

/**
 * Map a generatable content type to the compliance skill's content-type taxonomy
 * (a `pillar` is a long-form page; blog/faq map straight across). Kept here so
 * the ground pass and any future guardrail read one mapping.
 */
export function toComplianceContentType(type: GeneratableContentType): ComplianceContentType {
  switch (type) {
    case "blog":
      return "blog";
    case "faq":
      return "faq";
    case "pillar":
      return "page";
  }
}

/** The locked voice → a spec-shaped voice constraint (defensive copies; empty is honest "no voice sample"). */
function toVoiceConstraint(voice: VoiceProfile): VoiceConstraint {
  return {
    descriptors: [...voice.descriptors],
    samples: [...voice.samples],
    do: [...voice.do],
    dont: [...voice.dont],
  };
}

/**
 * Pick the target prompt this content aims to get cited for: the first
 * high-priority library entry, else the first entry, else null. Deterministic
 * (library order is authored order) so the spec is stable for a given playbook.
 */
export function pickTargetPrompt(library: PromptLibraryEntry[]): string | null {
  const high = library.find((e) => e.priority === "high");
  return (high ?? library[0])?.prompt ?? null;
}

/**
 * Render the vertical's BLOCK-severity compliance rules into human "avoid this"
 * guidance for the generation spec. Uses ONLY the skill's public `getRuleset`
 * surface (never re-implements a rule). An unknown vertical yields `[]` here —
 * generation is not blocked by an empty guardrail list, but the post-generation
 * compliance pre-screen (which FAILS CLOSED on an unknown vertical) and the hard
 * compliance-review gate still apply.
 */
export function deriveComplianceGuardrails(vertical: Vertical): string[] {
  const ruleset = getRuleset(vertical);
  if (!ruleset) return [];
  const guardrails: string[] = [];
  for (const rule of ruleset.rules) {
    if (rule.severity !== "block") continue;
    // description = what the rule enforces; requiredFix = how to satisfy it.
    guardrails.push(`${rule.description} — ${rule.requiredFix}`);
  }
  return guardrails;
}

/**
 * Assemble the full generation spec. `voice` is the locked kit's profile (the
 * action refuses to reach here without a locked kit — voice can't be enforced
 * otherwise). `playbook` is the loaded (active) vertical playbook.
 */
export function buildGenerationSpec(args: {
  request: DraftRequest;
  playbook: Playbook;
  voice: VoiceProfile;
}): ContentGenerationSpec {
  const { request, playbook, voice } = args;
  return {
    contentType: request.contentType,
    topic: request.topic,
    groundingFacts: [...request.groundingFacts],
    voice: toVoiceConstraint(voice),
    playbook: {
      vertical: playbook.vertical,
      templates: [...playbook.content_templates],
      schemaProfile: [...playbook.schema_profile],
      entitySignals: [...playbook.entity_signals],
      targetPrompt: pickTargetPrompt(playbook.prompt_library),
    },
    complianceGuardrails: deriveComplianceGuardrails(playbook.vertical),
  };
}
