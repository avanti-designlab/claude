/**
 * M8 Content Production — shared types (doc 05 Part B, doc 07 §1.5).
 *
 * The brand-consistent production engine's GENERATE step. M8 owns exactly one
 * pipeline stage (doc 05 Part B): produce a draft in the client's LOCKED brand
 * voice, mapped to the loaded playbook, constrained by the vertical's compliance
 * ruleset. Everything after — Humanize (M9) → Detect (M9) → Content Quality →
 * Compliance → Schema (M10) → Publish (1.2/1.3) — belongs to other owners. M8
 * NEVER approves its own output (CLAUDE.md rule 5, operator resolution
 * 2026-07-07): a produced draft lands at a PRE-APPROVAL status and cannot reach
 * approved/published without the two independent review verdicts the DB CHECK
 * (`content_items_reviewed_before_approval`, migration 0005) requires.
 */

import type { Json } from "@/lib/types/db";
import type { SchemaTypeName, Vertical } from "@/lib/types/playbook";

/* ------------------------------------------------------------------ */
/* What M8 generates                                                   */
/* ------------------------------------------------------------------ */

/**
 * The content types M8 GENERATES — a deliberate SUBSET of `content_items.type`
 * (blog | faq | caption | pillar | schema_copy, migration 0005):
 *   - `blog`   — blog posts / articles ("article" is a blog on this table).
 *   - `faq`    — FAQ rewrites into direct-answer format (indexable text pages).
 *   - `pillar` — long-form pillar / evergreen resources.
 * EXCLUDED on purpose: `caption` is M11's (social), `schema_copy` is
 * M10-adjacent (assembled JSON-LD, not humanized brand-voiced prose). Mapping a
 * draft to the wrong type would be a dishonest persist — the action refuses any
 * type outside this set.
 */
export const GENERATABLE_CONTENT_TYPES = ["blog", "faq", "pillar"] as const;
export type GeneratableContentType = (typeof GENERATABLE_CONTENT_TYPES)[number];

export function isGeneratableContentType(value: unknown): value is GeneratableContentType {
  return typeof value === "string" && (GENERATABLE_CONTENT_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Input clamps (server-authoritative, applied in ./actions)           */
/* ------------------------------------------------------------------ */

// Exported pure — importable both sides like GENERATABLE_CONTENT_TYPES — so a
// UI mirrors the REAL limits instead of hardcoding copies that drift.

/** Max chars of `topic` the create action keeps (excess truncated server-side). */
export const TOPIC_MAX = 500;
/** Max grounding facts kept per draft (excess entries dropped server-side). */
export const GROUNDING_FACTS_MAX = 100;
/** Max chars kept per grounding fact (excess truncated server-side). */
export const GROUNDING_FACT_MAX = 2000;

/* ------------------------------------------------------------------ */
/* The generation spec (what the provider consumes)                    */
/* ------------------------------------------------------------------ */

/** The locked brand voice, enforced from the START (doc 05 — not patched after). */
export interface VoiceConstraint {
  descriptors: string[];
  samples: string[];
  do: string[];
  dont: string[];
}

/** Playbook-derived structural + AEO mapping the content is generated against. */
export interface PlaybookContentMapping {
  vertical: Vertical;
  /** `content_templates` — the structural pattern to follow (pillar/FAQ/press). */
  templates: string[];
  /** `schema_profile` — the schema types this content must be markup-ready for (feeds M10). */
  schemaProfile: SchemaTypeName[];
  /** `entity_signals` — what makes the client resolvable to AI engines (author box, sameAs). */
  entitySignals: string[];
  /** A high-priority prompt from the library this content aims to get cited for; null if none. */
  targetPrompt: string | null;
}

/**
 * The fully-constrained request handed to the {@link ContentGenerationProvider}.
 * Every field is a GENERATION-TIME constraint — voice, playbook mapping, the
 * grounding fact set, and the compliance guardrails are all in the spec so
 * generic-AI / off-brand / non-compliant / fabricated output is prevented at
 * generation, not patched after (doc 05).
 */
export interface ContentGenerationSpec {
  contentType: GeneratableContentType;
  /** The topic / angle the draft must cover. */
  topic: string;
  /**
   * The ONLY facts the content may assert as fact (anti-fabrication grounding
   * set). The provider is instructed to state nothing factual outside this set;
   * the post-generation grounding pass flags leakage (see ./ground).
   */
  groundingFacts: string[];
  voice: VoiceConstraint;
  playbook: PlaybookContentMapping;
  /**
   * Human-readable "avoid this" guidance derived from the vertical's
   * compliance ruleset (block-severity rules). Constrains generation up front;
   * `compliance-review` remains the hard gate.
   */
  complianceGuardrails: string[];
}

/* ------------------------------------------------------------------ */
/* The provider's output                                               */
/* ------------------------------------------------------------------ */

/** What the LLM adapter returns for one generation. */
export interface ContentGenerationResult {
  /** A working title / headline for the draft. */
  title: string;
  /**
   * The AEO-formatted body — direct-answer opening, correct structure, internal
   * linking cues. The adapter (the LLM) owns the prose; M8 owns the constraints
   * and the guardrail passes around it.
   */
  body: string;
  /**
   * Verbatim vendor payload — retained for audit/debugging ONLY, never
   * interpreted by M8 and never persisted or logged (it can carry the prompt).
   */
  raw: Json;
}
