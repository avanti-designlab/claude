/**
 * M12 NEW-PR OUTREACH — a human-assisted DRAFTING tool, never a sender
 * (doc 05 M12: "New-PR outreach stays human-assisted … a drafting tool, not
 * auto-fired"; CLAUDE.md rule 5; doc 00 §2). Mirrors M15's review-response draft
 * exactly. Pure w.r.t. the platform: the LLM is the injected
 * {@link ContentGenerationProvider} port (REUSED from M8 — the SAME deferred
 * Anthropic seam, no second LLM port), no DB, no auth, no logging, no network.
 *
 * WHY IT CANNOT AUTO-SEND (the governance spine):
 *  - The output is an {@link OutreachDraft} whose `status` is HARD-PINNED to
 *    {@link OUTREACH_DRAFT_STATUS} ('draft_pending_human_approval') — not a
 *    parameter; no caller can raise it to a "sent" state through here.
 *  - There is NO send/email/submit/post path in `src/lib/pr/` at all. Publishing
 *    an outreach message is a human action outside the platform (or, later, a
 *    human-approved connector wired by integrations) — NEVER fired from a draft.
 *    Automated cold outreach reads as spam and damages authority, the opposite of
 *    the goal (doc 05 M12).
 *  - content-quality + compliance-review remain the hard gates (doc 07 §1.7): an
 *    outreach pitch is GENERATED CONTENT, so this flags and returns for the gates;
 *    it never clears itself.
 *
 * GROUNDING (no fabricated credentials/press — task point 4): a pitch may assert
 * NO fact not in its grounding facts (the client's genuine, ideally on-page-
 * corroborated, achievements/expertise + caller context). It reuses M8's
 * `findUngroundedClaims` READ-ONLY — any statistic/superlative the pitch
 * introduces beyond the grounding is flagged for the gates. `outreachGroundingFacts`
 * seeds grounding from a report's CORROBORATED press only (never uncorroborated).
 *
 * COMPLIANCE PRE-SCREEN (generation-time guardrail): the drafted pitch is screened
 * with the compliance skill under its nearest analog content type ('blog' — an
 * outreach pitch is external persuasive prose; there is no dedicated 'pr_outreach'
 * type, see {@link OUTREACH_GENERATION_TYPE_GAP}). The pre-screen is NOT the
 * verdict; compliance-review is.
 */

import { checkCompliance } from "@/lib/skills/compliance";
import {
  deriveComplianceGuardrails,
  findBannedVoicePhrases,
  findUngroundedClaims,
  summarizeCompliancePrescreen,
  type BannedVoicePhrase,
  type CompliancePrescreen,
  type ContentGenerationProvider,
  type ContentGenerationSpec,
  type GeneratableContentType,
  type UngroundedClaim,
} from "@/lib/production/content";
import type { VoiceProfile } from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";
import type { EntityAuthorityReport } from "./types";

/* ------------------------------------------------------------------ */
/* Pinned pre-approval status + the generation-taxonomy nearest analog */
/* ------------------------------------------------------------------ */

/** The ONLY status a drafted pitch ever carries — pinned pre-approval, never "sent". */
export const OUTREACH_DRAFT_STATUS = "draft_pending_human_approval" as const;

/**
 * An outreach pitch has no dedicated content type in M8's GENERATION taxonomy
 * (`GeneratableContentType` = blog|faq|pillar). An external, persuasive pitch is
 * closest to `blog`; the AUTHORITATIVE nature of the request rides in the spec
 * `topic` directive + the {@link OutreachReport} `outreachType`, and the
 * compliance pre-screen uses `'blog'` too. The honest long-term fix (a real
 * `pr_outreach` generation + compliance type) is flagged below.
 */
export const OUTREACH_GENERATION_CONTENT_TYPE = "blog" as const satisfies GeneratableContentType;

/** Stable schema-/taxonomy-gap flag (greppable — M8/M15 precedent). */
export const OUTREACH_GENERATION_TYPE_GAP =
  "No 'pr_outreach' type exists in the generation taxonomy or the compliance ContentType; the outreach " +
  "pitch is drafted as the nearest analog ('blog') with its authoritative nature carried in the spec topic + " +
  "OutreachReport.outreachType. A dedicated type is the proposed follow-up.";

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export interface OutreachDraftRequest {
  /** The target publication / journalist being pitched (context, not a secret). */
  targetPublication: string;
  /** The story angle the operator wants pitched (a directive, not an asserted fact). */
  angle: string;
  /**
   * The ONLY facts the pitch may assert — the client's genuine achievements /
   * expertise / corroborated press + any caller context. A pitch asserting
   * anything beyond these is flagged ungrounded (never emitted as fact).
   */
  groundingFacts: string[];
}

/** Evidence the drafted pitch carries into the gates (JSON-serializable). */
export interface OutreachReport {
  outreachType: "pr_outreach_pitch";
  targetPublication: string;
  /** Brand voice descriptors enforced at generation. */
  voiceEnforced: string[];
  /** Facts the pitch asserts that the grounding did not support — flagged, never emitted as fact. */
  ungroundedClaims: UngroundedClaim[];
  /** Banned voice.dont phrases present in the drafted pitch — flagged, never gated. */
  voiceViolations: BannedVoicePhrase[];
  /** Compliance guardrail result under `'blog'` (NOT the compliance-review verdict). */
  compliancePrescreen: CompliancePrescreen;
}

/** The pre-approval artifact — structurally un-sendable (see the module header). */
export interface OutreachDraft {
  /** Pinned pre-approval; there is no exported transition to a "sent" state. */
  status: typeof OUTREACH_DRAFT_STATUS;
  body: string;
  report: OutreachReport;
}

export type DraftOutreachOutcome =
  | { ok: true; draft: OutreachDraft }
  | { ok: false; reason: "generation_unavailable" | "empty_generation" | "no_grounding"; cause?: unknown };

export interface DraftOutreachInput {
  request: OutreachDraftRequest;
  /** The LOCKED brand voice (a caller refuses to reach here without a kit). */
  voice: VoiceProfile;
  /** The client's vertical — drives the compliance pre-screen + generation guardrails. */
  vertical: Vertical;
}

/* ------------------------------------------------------------------ */
/* Grounding + spec construction                                       */
/* ------------------------------------------------------------------ */

/** The locked voice → a spec-shaped constraint (defensive copies). */
function toVoiceConstraint(voice: VoiceProfile): ContentGenerationSpec["voice"] {
  return {
    descriptors: [...(voice.descriptors ?? [])],
    samples: [...(voice.samples ?? [])],
    do: [...(voice.do ?? [])],
    dont: [...(voice.dont ?? [])],
  };
}

/**
 * Seed grounding facts from an entity-authority report's CORROBORATED press only
 * (never the uncorroborated claims — those are exactly what M12 refuses to
 * assert), plus any caller-supplied extra facts. Deduped, order-stable.
 */
export function outreachGroundingFacts(report: EntityAuthorityReport, extraFacts: string[] = []): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    const t = f.trim();
    if (t === "" || seen.has(t)) return;
    seen.add(t);
    facts.push(t);
  };
  if (report.person.namePresentOnPage && report.person.keyPersonName !== null) {
    push(`${report.person.keyPersonName} is an on-page, named entity for this client.`);
  }
  for (const item of report.press.claimedPress) {
    if (item.mentionedOnPage) push(`Featured in ${item.publication} (corroborated on the client's own site).`);
  }
  for (const f of extraFacts) if (typeof f === "string") push(f);
  return facts;
}

/**
 * Build the generation spec for an outreach pitch. Voice + compliance guardrails
 * + grounding are constraints AT GENERATION (off-brand/non-compliant/fabricated
 * pitches steered away up front). The `playbook` mapping is minimal + honest — a
 * cold pitch is NOT AEO-mapped content (no target prompt, no templates/schema).
 */
export function buildOutreachSpec(input: DraftOutreachInput): ContentGenerationSpec {
  const { request, voice, vertical } = input;
  return {
    contentType: OUTREACH_GENERATION_CONTENT_TYPE,
    topic:
      `Draft a concise, personalized PR outreach pitch to ${request.targetPublication}. ` +
      `Angle: ${request.angle}. Assert no fact not present in the provided grounding facts; ` +
      "this is a DRAFT for a human to review, edit, and send — never sent automatically.",
    groundingFacts: [...request.groundingFacts],
    voice: toVoiceConstraint(voice),
    playbook: {
      vertical,
      templates: [],
      schemaProfile: [],
      entitySignals: [],
      targetPrompt: null,
    },
    complianceGuardrails: deriveComplianceGuardrails(vertical),
  };
}

/* ------------------------------------------------------------------ */
/* draftOutreachPitch                                                  */
/* ------------------------------------------------------------------ */

/**
 * Draft one PR outreach pitch. The provider is injected; a thrown/rejected
 * provider (the deferred adapter, a timeout, a vendor error) maps to
 * `generation_unavailable` WITHOUT surfacing the raw cause as content. An empty
 * body is `empty_generation`. With no grounding facts we refuse up front
 * (`no_grounding`) — a pitch with nothing genuine to assert is exactly the
 * fabricated-authority risk M12 exists to avoid. On success the pitch passes the
 * grounding + voice + compliance-pre-screen guardrails and returns a PRE-APPROVAL
 * draft — flagged, never cleared, never sent.
 */
export async function draftOutreachPitch(
  provider: ContentGenerationProvider,
  input: DraftOutreachInput,
): Promise<DraftOutreachOutcome> {
  const spec = buildOutreachSpec(input);
  if (spec.groundingFacts.length === 0) return { ok: false, reason: "no_grounding" };

  let result;
  try {
    result = await provider.generate(spec);
  } catch (cause) {
    return { ok: false, reason: "generation_unavailable", cause };
  }

  const body = typeof result?.body === "string" ? result.body.trim() : "";
  if (body === "") return { ok: false, reason: "empty_generation" };

  const ungroundedClaims = findUngroundedClaims(body, spec.groundingFacts);
  const voiceViolations = findBannedVoicePhrases(body, spec.voice.dont);
  const compliancePrescreen = summarizeCompliancePrescreen(
    checkCompliance({
      vertical: input.vertical,
      contentType: "blog",
      content: { text: body },
    }),
  );

  return {
    ok: true,
    draft: {
      status: OUTREACH_DRAFT_STATUS,
      body,
      report: {
        outreachType: "pr_outreach_pitch",
        targetPublication: input.request.targetPublication,
        voiceEnforced: spec.voice.descriptors,
        ungroundedClaims,
        voiceViolations,
        compliancePrescreen,
      },
    },
  };
}
