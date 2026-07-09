"use server";

import { requireAuth } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { answerQuestion } from "./answer";
import {
  toContentResearch,
  toPromptVolumeSignal,
  type ContentResearchBrief,
  type PromptVolumeSignal,
} from "./feeds";
import { resolveAnswerProvider, resolveWebSearchProvider } from "./live-provider";
import { persistResourceAnswer, RESOURCE_CENTER_PERSISTENCE_GAP } from "./persist";
import { logResourceFailure } from "./telemetry";
import type { GradedAnswer, ResearchScope } from "./types";

/**
 * M18 Resource Center — the ask server action (doc 05 Part E; doc 07 §1.9). The
 * playbook-scoped Q&A assistant: retrieve sources → answer scoped to the
 * client's loaded playbook → grade for honesty → return the graded answer plus
 * the M3/M8 feed shapes. Gate: Content Quality (this is generated content).
 *
 * SECURITY POSTURE (mirrors the M2 audit + M3 tracker actions):
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a clientId + a question. The vertical (the playbook selector) comes
 *    from an RLS-scoped `clients` read; a cross-tenant or nonexistent clientId is
 *    the SAME empty observation → `not_found` (doc 03 §4). Nothing generative
 *    round-trips through the browser — a caller cannot inject a playbook, a
 *    source, or a pre-built answer.
 *  - READ-LIKE AUTHZ (`requireAuth`). Doc 05 M18 is explicit that "operators OR
 *    clients query" the assistant, and nothing is persisted and no client site
 *    is written — so any authenticated tenant member may ask, and RLS
 *    (`app.client_scope`) narrows a client_viewer to its own client's vertical.
 *    This is NOT a privileged write path.
 *    ⚑ OPERATOR RATIFICATION (doc-silent, flagged): the answer LLM + web search
 *    are RENTED (cost per ask). A per-tenant/per-role rate limit belongs at
 *    wiring time — chosen here as: gate at wiring, not silently operator-only
 *    (which would contradict the spec). Deferred adapter ⇒ no live cost yet.
 *
 * HONESTY (the module's spine): the answer is graded — sources are verified
 * against retrieval (no fabricated authority), an unsourced/ungrounded answer is
 * marked low-confidence, and a deferred/unavailable provider returns an honest
 * `answer_unavailable`, never a confident hallucination and never a 500. The
 * exchange is NOT persisted (no frozen-schema home — flagged, see ./persist).
 */

/* ------------------------------------------------------------------ */
/* Input clamp                                                         */
/* ------------------------------------------------------------------ */

const QUESTION_MAX = 1000;

/* ------------------------------------------------------------------ */
/* Result contract (FROZEN once consumed by the frontend — post-handoff
   changes require Orchestrator + Code Review sign-off, CLAUDE.md rule 1) */
/* ------------------------------------------------------------------ */

export interface ResourceAnswerPayload {
  answer: GradedAnswer;
  scope: ResearchScope;
  vendor: { answer: string; webSearch: string | null };
  /** This is generated content — routes to the Content Quality gate where user-facing. */
  reviewGate: "content-quality";
  /** Downstream FEED shapes (shaped-not-wired: consumers pull; see ./feeds). */
  feeds: {
    /** M3 prompt-volume candidate for this ask (null for an empty question). */
    promptVolume: PromptVolumeSignal | null;
    /** M8 content-research brief derived from the graded answer. */
    contentResearch: ContentResearchBrief;
  };
  /** The exchange is not persisted — the frozen-schema gap, surfaced honestly. */
  persistence: { persisted: false; flag: string };
}

export type AskResourceQuestionResult =
  | { ok: true; payload: ResourceAnswerPayload; warning?: string }
  | {
      ok: false;
      reason: "not_found" | "invalid_input" | "no_playbook" | "lookup_failed" | "answer_unavailable";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor string. */
const NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_INPUT_ERROR =
  "Add a question to ask the industry assistant, then try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no scope for the assistant. It activates once this vertical’s playbook ships.";
const LOOKUP_FAILED_ERROR =
  "We couldn’t load that client. Check your connection and try again — nothing was asked.";
const ANSWER_UNAVAILABLE_ERROR =
  "The research assistant isn’t connected yet. It activates once the AI provider is set up for your workspace.";

/* ------------------------------------------------------------------ */
/* Gate 1a mirror: dormant verticals have no scope, exactly like they   */
/* plan nothing.                                                       */
/* ------------------------------------------------------------------ */

function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/* ------------------------------------------------------------------ */
/* askResourceQuestion                                                 */
/* ------------------------------------------------------------------ */

export interface AskResourceQuestionInput {
  clientId: string;
  question: string;
}

export async function askResourceQuestion(
  input: AskResourceQuestionInput,
): Promise<AskResourceQuestionResult> {
  // AUTHN. requireAuth redirects to /login without a verified claim (that
  // redirect throws and must propagate). Any authenticated tenant member may
  // ask (doc 05 M18 — clients query the assistant too); RLS scopes the read.
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };

  const question = typeof input?.question === "string" ? input.question.trim().slice(0, QUESTION_MAX) : "";
  if (question === "") return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };

  const supabase = await createClient();
  try {
    // RLS-scoped client read: existence + the vertical (the playbook selector).
    // Cross-tenant and nonexistent are the SAME empty observation (doc 03 §4).
    const clientRes = await supabase
      .from("clients")
      .select("id, vertical")
      .eq("id", clientId)
      .maybeSingle();
    if (clientRes.error) {
      logResourceFailure("lookup", clientRes.error);
      return { ok: false, reason: "lookup_failed", error: LOOKUP_FAILED_ERROR };
    }
    if (!clientRes.data) return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
    const client = clientRes.data as { id: string; vertical: string };

    const playbook = activePlaybook(client.vertical);
    if (!playbook) return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };

    // ANSWER via the injected, deferred providers. A deferred/throwing answer
    // provider → answer_unavailable (honest, never a hallucination).
    const outcome = await answerQuestion(resolveAnswerProvider(), resolveWebSearchProvider(), {
      question,
      playbook,
    });
    if (!outcome.ok) {
      logResourceFailure("answer", outcome.cause);
      return { ok: false, reason: "answer_unavailable", error: ANSWER_UNAVAILABLE_ERROR };
    }

    const { answer, scope, vendor } = outcome.result;

    // PERSIST — honestly a no-op against the frozen schema (no table). Nothing
    // is written; the flag is surfaced (M4 precedent).
    const persistence = persistResourceAnswer();

    const payload: ResourceAnswerPayload = {
      answer,
      scope,
      vendor,
      reviewGate: "content-quality",
      feeds: {
        promptVolume: toPromptVolumeSignal(question, scope),
        contentResearch: toContentResearch(question, answer, scope),
      },
      persistence: { persisted: false, flag: persistence.flag },
    };

    // Honesty warning when the answer isn't grounded — surfaced in interface
    // voice, structural truth in answer.grounded/confidence.
    if (!answer.answered) {
      return {
        ok: true,
        payload,
        warning:
          "The assistant found no grounded answer for this question in your industry sources. Try rephrasing, or treat this as an open research question.",
      };
    }
    if (!answer.grounded) {
      return {
        ok: true,
        payload,
        warning: answer.webSearchAvailable
          ? "This answer isn’t backed by retrieved sources — treat it as low-confidence and verify before acting."
          : "Web search isn’t connected, so this answer isn’t source-backed — treat it as low-confidence and verify before acting.",
      };
    }
    return { ok: true, payload };
  } catch (err) {
    // Anything unexpected: one redacted telemetry line, honest failure — never a 500.
    logResourceFailure("thrown", err);
    return { ok: false, reason: "lookup_failed", error: LOOKUP_FAILED_ERROR };
  }
}

export { RESOURCE_CENTER_PERSISTENCE_GAP };
