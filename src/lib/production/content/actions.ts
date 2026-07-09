"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
// M7's read API is a server action, imported DIRECTLY (the brand-kit index
// deliberately does not re-export actions — same convention M7 documents).
import { readLockedBrandKit } from "@/lib/production/brand-kit/actions";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { generateContentDraft, type GenerationReport } from "./generate";
import { resolveContentProvider } from "./live-provider";
import {
  logContentFailure,
  persistContentDraft,
  readContentDraftById,
  readContentDraftsForClient,
} from "./persist";
import type { ContentDraftDetail, ContentDraftSummary } from "./rows";
import { isGeneratableContentType, type GeneratableContentType } from "./types";

/**
 * M8 Content Production — server actions (doc 05 Part B, doc 07 §1.5). Security
 * posture mirrors the M2 audit + M7 brand-kit actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a clientId + generation inputs; the tenant comes from the caller's
 *    VERIFIED JWT claim, and RLS (`content_items_*`, migration 0005) re-pins
 *    every row below us regardless. The persisted client_id comes from an
 *    RLS-scoped `clients` read; the brand_kit_id comes from M7's RLS-scoped
 *    locked-kit read — never from the caller. The composite FKs make a
 *    cross-tenant OR cross-client reference structurally impossible.
 *  - WRITE RIGHTS MIRROR RLS HONESTLY. `content_items_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the guard is
 *    `requireOperator()` — content production is module work the operator team
 *    runs (doc 03 §2 role matrix), like running an audit or ingesting a brand.
 *  - THE DRAFT IS BUILT + GROUNDED SERVER-SIDE. Nothing generative round-trips
 *    through the browser: a caller cannot inject a pre-built body, forge a
 *    brand_kit_id, or bypass the grounding / compliance guardrails.
 *
 * NO SELF-APPROVAL (CLAUDE.md rule 5, operator resolution 2026-07-07). M8 owns
 * only GENERATE. Every draft persists at the pinned pre-approval state (status
 * 'draft', automation_level 'ai_draft_human_approve' — see rows.ts) and can
 * NEVER reach approved/published from here: M8 writes no review verdict, and the
 * DB CHECK requires BOTH before approval. The generation report travels back to
 * the caller (and the downstream review gates) carrying the grounding + compliance
 * flags — M8 flags, the HARD gates decide.
 *
 * REFUSAL WITHOUT A LOCKED KIT. A client with no locked brand kit is REFUSED
 * (`no_brand_kit`) — the brand voice cannot be enforced, and falling back to a
 * generic voice silently is exactly what the pipeline exists to prevent (doc 05).
 *
 * GATE 1a. Only ACTIVE verticals (real-estate first) are served — same gate as
 * the audit action; a dormant/unknown vertical gets `no_playbook`.
 */

/* ------------------------------------------------------------------ */
/* Input clamps                                                        */
/* ------------------------------------------------------------------ */

const TOPIC_MAX = 500;
const GROUNDING_FACTS_MAX = 100;
const GROUNDING_FACT_MAX = 2000;

/* ------------------------------------------------------------------ */
/* Result contracts (FROZEN once consumed by the frontend — post-handoff
   changes require Orchestrator + Code Review sign-off, CLAUDE.md rule 1) */
/* ------------------------------------------------------------------ */

export type CreateContentDraftResult =
  | { ok: true; contentItemId: string; title: string; report: GenerationReport }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "unsupported_type"
        | "invalid_input"
        | "no_playbook"
        | "no_brand_kit"
        | "generation_unavailable"
        | "generation_failed"
        | "write_failed";
      error: string;
    };

export type ListContentDraftsResult =
  | { ok: true; entries: ContentDraftSummary[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

export type ReadContentDraftResult =
  | { ok: true; draft: ContentDraftDetail | null }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor/skill string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to produce content — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const UNSUPPORTED_TYPE_ERROR =
  "This content type isn’t produced here. Content Production makes blog, FAQ, and pillar drafts (captions and schema are other modules).";
const INVALID_INPUT_ERROR =
  "We couldn’t start generation from these details. Add a topic and try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no content plan to map to. Content Production activates once this vertical’s playbook ships.";
const NO_BRAND_KIT_ERROR =
  "This client has no locked brand kit yet, so we can’t generate in their brand voice. Create the brand kit first — we never fall back to a generic voice.";
const GENERATION_UNAVAILABLE_ERROR =
  "Content generation isn’t connected yet. It activates once the AI writing provider is set up for your workspace.";
const GENERATION_FAILED_ERROR =
  "We couldn’t produce a draft this time. Try again, or adjust the topic and grounding details.";
const WRITE_FAILED_ERROR =
  "We couldn’t save this draft. Check your connection and try again.";
const DRAFT_NOT_FOUND_ERROR =
  "We couldn’t find that draft. It may have been removed — refresh and try again.";
const READ_FAILED_ERROR =
  "We couldn’t load content drafts. Check your connection and try again.";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Gate 1a mirror (same as the audit action): only ACTIVE verticals are served. */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/** Clamp the free-text generation inputs before anything downstream sees them. */
function clampGroundingFacts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const facts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    facts.push(trimmed.slice(0, GROUNDING_FACT_MAX));
    if (facts.length >= GROUNDING_FACTS_MAX) break;
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* createContentDraft — GENERATE one pre-approval draft                */
/* ------------------------------------------------------------------ */

export interface CreateContentDraftInput {
  clientId: string;
  contentType: GeneratableContentType;
  topic: string;
  /** The facts the content may assert as fact (anti-fabrication grounding set). */
  groundingFacts?: string[];
}

export async function createContentDraft(
  input: CreateContentDraftInput,
): Promise<CreateContentDraftResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role case
  // is trapped; everything else, including NEXT_REDIRECT, rethrows).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  // Runtime backstops on the caller-supplied fields.
  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  if (!isGeneratableContentType(input?.contentType)) {
    return { ok: false, reason: "unsupported_type", error: UNSUPPORTED_TYPE_ERROR };
  }
  const contentType = input.contentType;

  const topic = typeof input?.topic === "string" ? input.topic.trim().slice(0, TOPIC_MAX) : "";
  if (topic === "") return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };
  const groundingFacts = clampGroundingFacts(input?.groundingFacts);

  const supabase = await createClient();
  try {
    // RLS-scoped client read: existence + the vertical (the playbook selector).
    // A cross-tenant or nonexistent id is the SAME empty observation (doc 03 §4).
    const clientRes = await supabase
      .from("clients")
      .select("id, vertical")
      .eq("id", clientId)
      .maybeSingle();
    if (clientRes.error) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (!clientRes.data) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
    const client = clientRes.data as { id: string; vertical: string };

    const playbook = activePlaybook(client.vertical);
    if (!playbook) return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };

    // The locked brand kit is MANDATORY (voice can't be enforced without it).
    // M7's read API is RLS-scoped; a null kit is a hard refusal, never a
    // generic-voice fallback.
    const kitRes = await readLockedBrandKit({ clientId: client.id });
    if (!kitRes.ok) {
      return kitRes.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (kitRes.kit === null) return { ok: false, reason: "no_brand_kit", error: NO_BRAND_KIT_ERROR };
    const kit = kitRes.kit;

    // GENERATE via the injected provider (deferred adapter → generation_unavailable).
    const outcome = await generateContentDraft(resolveContentProvider(), {
      request: { contentType, topic, groundingFacts },
      playbook,
      voice: kit.voiceProfile,
    });
    if (!outcome.ok) {
      if (outcome.reason === "generation_unavailable") {
        logContentFailure("generate", outcome.cause);
        return { ok: false, reason: "generation_unavailable", error: GENERATION_UNAVAILABLE_ERROR };
      }
      return { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
    }

    // PERSIST the pre-approval draft. tenant is claim-sourced; client_id +
    // brand_kit_id are RLS-sourced above; the composite FKs re-pin scope.
    const persisted = await persistContentDraft(supabase, claims.tenantId, {
      clientId: client.id,
      brandKitId: kit.id,
      type: contentType,
      body: outcome.body,
    });
    if (!persisted.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };

    return { ok: true, contentItemId: persisted.contentItemId, title: outcome.title, report: outcome.report };
  } catch (err) {
    // Anything unexpected: one redacted telemetry line, honest retryable failure — never a 500.
    logContentFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* Reads — the review queue + the single-draft reviewer read           */
/* ------------------------------------------------------------------ */

/**
 * Newest-first content drafts for a client — the review queue (Content Quality /
 * Compliance / M9) and the dashboard work-log. Guarded by `requireAuth` ONLY,
 * mirroring `content_items_select` (migration 0005) honestly: reads are open to
 * any tenant member, and `app.client_scope` already narrows a client_viewer to
 * its own client's items. RLS is the enforcement boundary.
 */
export async function listContentDrafts(input: { clientId: string }): Promise<ListContentDraftsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readContentDraftsForClient(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, entries: res.entries };
}

/**
 * The full draft for ONE item — what a reviewer or M9 reads (body + prior
 * verdicts + pipeline state). Same `requireAuth`/RLS posture; a nonexistent OR
 * another-tenant id both come back as `draft: null` (doc 03 §4 parity).
 */
export async function readContentDraft(input: { contentItemId: string }): Promise<ReadContentDraftResult> {
  await requireAuth();

  const contentItemId = typeof input?.contentItemId === "string" ? input.contentItemId.trim() : "";
  if (!isUuidV4(contentItemId)) return { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readContentDraftById(supabase, contentItemId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, draft: res.detail };
}
