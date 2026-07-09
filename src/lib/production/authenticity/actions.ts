"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { readLockedBrandKit } from "@/lib/production/brand-kit/actions";
import { createClient } from "@/lib/supabase/server";
import { authenticate } from "./authenticate";
import { resolveDetectorPanel, resolveHumanizerProvider } from "./live-providers";
import {
  logAuthenticityFailure,
  persistHumanization,
  readDraftForAuthenticity,
  readHumanizationVerdict,
} from "./persist";
import { authenticityVerdictView } from "./rows";
import type { AuthenticityVerdictView } from "./types";
import type { ComplianceContentType } from "@/lib/skills/compliance";
import type { ContentItemStatus, ContentItemType } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";

/**
 * M9 Humanization + AI-detection authenticity gate — server actions (doc 05 Part
 * B, doc 07 §1.5). M9 is a pipeline STAGE, not an approver. Security posture
 * mirrors the M8 content + M7 brand-kit actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends only
 *    a contentItemId; the tenant comes from the caller's VERIFIED JWT claim, and
 *    RLS (`content_items_*`, migration 0005) re-pins every row below us. The
 *    client_id + voice come from RLS-scoped reads (the draft row + M7's locked
 *    kit), never from the caller.
 *  - WRITE RIGHTS MIRROR RLS HONESTLY. `content_items_update` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the run guard is
 *    `requireOperator()`; the verdict READ is `requireAuth()` (open to any tenant
 *    member; RLS + client_scope narrow it), so a gate reviewer or the client
 *    dashboard can read it.
 *
 * M9 NEVER SELF-APPROVES AND CANNOT PUBLISH (CLAUDE.md rule 5, operator resolution
 * 2026-07-07). It records the humanize→detect result into `content_items.humanization`
 * and ADVANCES the pipeline to the next stage (status → 'in_review', the review
 * queue), leaving the review columns for the independent Content Quality +
 * Compliance gates. Approved/published is structurally unreachable from here
 * (rows.ts pins status; the DB CHECK requires both verdicts).
 *
 * HONESTY. Detection scores are recorded verbatim. If humanization cannot bring the
 * panel below threshold — or drifts from the source meaning/voice — the item is
 * FLAGGED for human review (verdict 'flagged_for_human'), never force-passed or
 * silently marked clean. Unavailable vendors → an honest unavailable result with
 * NOTHING persisted (never a silent pass).
 */

/* ------------------------------------------------------------------ */
/* Result contracts                                                    */
/* ------------------------------------------------------------------ */

export type RunAuthenticityGateResult =
  | { ok: true; contentItemId: string; verdict: AuthenticityVerdictView }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_input"
        | "already_reviewed"
        | "no_brand_kit"
        | "humanizer_unavailable"
        | "detection_unavailable"
        | "humanization_failed"
        | "write_failed";
      error: string;
    };

export type ReadAuthenticityVerdictResult =
  | { ok: true; status: ContentItemStatus | null; verdict: AuthenticityVerdictView | null }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to run the authenticity check — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const DRAFT_NOT_FOUND_ERROR =
  "We couldn’t find that draft. It may have been removed — refresh and try again.";
const INVALID_INPUT_ERROR =
  "We couldn’t start the authenticity check from these details. Refresh and try again.";
const ALREADY_REVIEWED_ERROR =
  "This draft is already past the review stage, so we won’t re-run the authenticity check on it.";
const NO_BRAND_KIT_ERROR =
  "This client has no locked brand kit, so we can’t check the rewrite against their brand voice. Create the brand kit first.";
const HUMANIZER_UNAVAILABLE_ERROR =
  "Humanization isn’t connected yet. It activates once the humanizer provider is set up for your workspace.";
const DETECTION_UNAVAILABLE_ERROR =
  "AI-detection isn’t connected yet. It activates once the detection providers are set up for your workspace.";
const HUMANIZATION_FAILED_ERROR =
  "We couldn’t complete the authenticity check this time. Try again.";
const WRITE_FAILED_ERROR =
  "We couldn’t save the authenticity result. Check your connection and try again.";
const READ_FAILED_ERROR =
  "We couldn’t load the authenticity result. Check your connection and try again.";

/** Statuses M9 may run on — a fresh draft or one already in the review queue (re-humanize). */
const RUNNABLE_STATUSES: readonly ContentItemStatus[] = ["draft", "in_review"];

/**
 * Map a `content_items.type` to the compliance skill's content-type taxonomy for
 * the post-humanization re-screen (mirrors M8's constrain.toComplianceContentType,
 * extended to the full column: caption → social_caption; schema_copy → page).
 */
function toComplianceContentType(type: ContentItemType): ComplianceContentType {
  switch (type) {
    case "blog":
      return "blog";
    case "faq":
      return "faq";
    case "pillar":
      return "page";
    case "caption":
      return "social_caption";
    case "schema_copy":
      return "page";
  }
}

/* ------------------------------------------------------------------ */
/* runAuthenticityGate — humanize → detect → record → advance          */
/* ------------------------------------------------------------------ */

export async function runAuthenticityGate(input: {
  contentItemId: string;
}): Promise<RunAuthenticityGateResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role case is
  // trapped; everything else, including NEXT_REDIRECT, rethrows).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  const contentItemId = typeof input?.contentItemId === "string" ? input.contentItemId.trim() : "";
  if (!isUuidV4(contentItemId)) return { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  try {
    // RLS-scoped draft read: body + client_id + status. Cross-tenant == nonexistent.
    const draftRes = await readDraftForAuthenticity(supabase, contentItemId);
    if (!draftRes.ok) {
      logAuthenticityFailure("draft_read", null);
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (!draftRes.row) return { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR };
    const draft = draftRes.row;

    // Run-eligibility: never touch an item already past the review stage (approved/
    // published). M9 advances INTO review; it does not reach back over the gates.
    if (!RUNNABLE_STATUSES.includes(draft.status)) {
      return { ok: false, reason: "already_reviewed", error: ALREADY_REVIEWED_ERROR };
    }
    const body = typeof draft.body === "string" ? draft.body.trim() : "";
    if (body === "") return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };

    // The locked voice is MANDATORY (the voice-drift recheck needs it; M8 refused to
    // generate without a kit, so a live draft should have one). A null kit is a hard
    // refusal, never a check-without-voice.
    const kitRes = await readLockedBrandKit({ clientId: draft.client_id });
    if (!kitRes.ok) {
      return kitRes.reason === "not_found"
        ? { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (kitRes.kit === null) return { ok: false, reason: "no_brand_kit", error: NO_BRAND_KIT_ERROR };

    // The client's VERTICAL drives the MANDATORY post-humanization compliance
    // re-screen (a humanizer can reword out a required disclaimer or into a vertical
    // violation that drift can't see). RLS-scoped read; a cross-tenant/nonexistent
    // id is the SAME empty observation (doc 03 §4). An unknown vertical fails closed
    // inside the compliance skill — never a silent pass.
    const clientRes = await supabase
      .from("clients")
      .select("id, vertical")
      .eq("id", draft.client_id)
      .maybeSingle();
    if (clientRes.error) {
      logAuthenticityFailure("draft_read", null);
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (!clientRes.data) return { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR };
    const vertical = (clientRes.data as { vertical: string }).vertical as Vertical;

    // HUMANIZE → DETECT via the injected (deferred) providers. Unavailable → honest
    // unavailable, NOTHING persisted.
    const outcome = await authenticate({
      body,
      voice: kitRes.kit.voiceProfile,
      humanizer: resolveHumanizerProvider(),
      detectors: resolveDetectorPanel(),
      vertical,
      contentType: toComplianceContentType(draft.type),
    });
    if (!outcome.ok) {
      if (outcome.reason === "humanizer_unavailable") {
        // The humanizer's thrown error may carry the draft — log the redacted
        // marker+stage+code only (its message never appears).
        logAuthenticityFailure("humanize", outcome.cause);
        return { ok: false, reason: "humanizer_unavailable", error: HUMANIZER_UNAVAILABLE_ERROR };
      }
      if (outcome.reason === "detectors_unavailable") {
        return { ok: false, reason: "detection_unavailable", error: DETECTION_UNAVAILABLE_ERROR };
      }
      return { ok: false, reason: "humanization_failed", error: HUMANIZATION_FAILED_ERROR };
    }

    // PERSIST the verdict + advance the pipeline. tenant is claim-sourced; RLS +
    // the pinned payload re-pin scope + forbid any approve/publish write.
    const persisted = await persistHumanization(supabase, claims.tenantId, {
      contentItemId,
      record: outcome.record,
      bodyToPersist: outcome.bodyToPersist,
    });
    if (!persisted.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };

    // The record IS the stored humanization shape → view it directly (no re-read).
    const verdict = authenticityVerdictView(outcome.record);
    if (!verdict) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    return { ok: true, contentItemId, verdict };
  } catch (err) {
    logAuthenticityFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* readAuthenticityVerdict — the gates' + dashboard's read             */
/* ------------------------------------------------------------------ */

/**
 * The authenticity verdict for ONE draft — what the Content Quality / Compliance
 * gates + the dashboard work-log read. Guarded by `requireAuth` ONLY, mirroring
 * `content_items_select` honestly: reads are open to any tenant member, and
 * `app.client_scope` narrows a client_viewer to its own client's items. A
 * nonexistent OR another-tenant id both come back as `verdict: null` (doc 03 §4).
 */
export async function readAuthenticityVerdict(input: {
  contentItemId: string;
}): Promise<ReadAuthenticityVerdictResult> {
  await requireAuth();

  const contentItemId = typeof input?.contentItemId === "string" ? input.contentItemId.trim() : "";
  if (!isUuidV4(contentItemId)) return { ok: false, reason: "not_found", error: DRAFT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readHumanizationVerdict(supabase, contentItemId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, status: res.status, verdict: res.verdict };
}
