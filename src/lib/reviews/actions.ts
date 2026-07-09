"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
// M7's read API is a server action, imported DIRECTLY (same convention M8 uses —
// the brand-kit index deliberately does not re-export actions).
import { readLockedBrandKit } from "@/lib/production/brand-kit/actions";
// The DEFERRED Anthropic content provider — REUSED from M8 (the same LLM seam,
// not a second port). Server-only; the action tests vi.mock it.
import { resolveContentProvider } from "@/lib/production/content/live-provider";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { resolveReviewPlatformProvider } from "./live-provider";
import { ingestReviews, type MonitorRequest } from "./monitor";
import { logReviewFailure, persistReviewSignal, readReviewSignalsForClient } from "./persist";
import { draftReviewResponse as draftReviewResponseCore, type ReviewResponseDraft } from "./respond";
import type { ReviewSignalEntry } from "./rows";
import { buildReviewSignal } from "./signal";
import type { IngestedReview, ReviewSignal } from "./types";

/**
 * M15 Review management — server actions (doc 05 M15, doc 07 §1.6). M15 owns
 * MONITOR + sentiment/velocity SIGNAL + DRAFT responses; it generates + measures,
 * it never approves and never auto-sends. Security posture mirrors the M8 content
 * + M2 audit actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a clientId + monitoring/response inputs; the tenant comes from the
 *    caller's VERIFIED JWT claim, and RLS (`metrics_*`, migration 0006) re-pins
 *    every row below us regardless. The persisted client_id comes from an
 *    RLS-scoped `clients` read; the brand voice comes from M7's RLS-scoped locked
 *    kit — never from the caller. The composite FK makes a cross-tenant reference
 *    structurally impossible.
 *  - WRITE RIGHTS MIRROR RLS HONESTLY. `metrics_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the write actions are
 *    `requireOperator()` — review monitoring/drafting is module work the operator
 *    team runs (doc 03 §2), like running an audit or generating content.
 *  - THE SIGNAL + DRAFT ARE BUILT SERVER-SIDE. Nothing generative round-trips
 *    through the browser: a caller cannot inject a signal, a pre-built reply, or
 *    forge a vendor result — the deferred providers fail closed.
 *
 * NO AUTO-SEND (CLAUDE.md rule 5). A drafted response is a PRE-APPROVAL artifact
 * (status pinned, no send path exists — see respond.ts / the read-only monitor
 * port). It is returned to the caller for the content-quality + compliance-review
 * gates; M15 writes NO reply anywhere.
 *
 * GATE 1a. Only ACTIVE verticals (real-estate first) are served — a
 * dormant/unknown vertical gets `no_playbook` (we do not monitor reviews or draft
 * replies for a vertical not yet in live use).
 */

/* ------------------------------------------------------------------ */
/* Input clamps                                                        */
/* ------------------------------------------------------------------ */

const PLATFORMS_MAX = 25;
const PLATFORM_MAX = 100;
const ACCOUNT_REF_MAX = 400;
const REVIEW_TEXT_MAX = 10_000;
const AUTHOR_MAX = 200;
const CONTEXT_FACTS_MAX = 50;
const CONTEXT_FACT_MAX = 2_000;
const WINDOW_DAYS_MAX = 3_650;

/* ------------------------------------------------------------------ */
/* Result contracts (FROZEN once consumed by the frontend — post-handoff
   changes require Orchestrator + Code Review sign-off, CLAUDE.md rule 1) */
/* ------------------------------------------------------------------ */

export type CaptureReviewSignalResult =
  | {
      ok: true;
      metricId: string;
      signal: ReviewSignal;
    }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_input"
        | "no_playbook"
        | "monitor_unavailable"
        | "write_failed";
      error: string;
      /** On monitor_unavailable: which requested platforms were excluded (honest, not zero). */
      excludedPlatforms?: string[];
    };

export type DraftReviewResponseResult =
  | { ok: true; draft: ReviewResponseDraft }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_input"
        | "no_playbook"
        | "no_brand_kit"
        | "generation_unavailable"
        | "generation_failed";
      error: string;
    };

export type ListReviewSignalsResult =
  | { ok: true; entries: ReviewSignalEntry[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do. */
const FORBIDDEN_ERROR =
  "You don’t have permission to manage reviews — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_INPUT_ERROR =
  "We couldn’t start from these details. Add at least one platform to monitor and try again.";
const INVALID_REVIEW_ERROR =
  "We couldn’t draft a response from these review details. Add the review text and platform, then try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so review management isn’t enabled. It activates once this vertical’s playbook ships.";
const NO_BRAND_KIT_ERROR =
  "This client has no locked brand kit yet, so we can’t draft in their brand voice. Create the brand kit first — we never fall back to a generic voice.";
const MONITOR_UNAVAILABLE_ERROR =
  "Review monitoring isn’t connected yet. It activates once a review-source provider is set up for these platforms.";
const GENERATION_UNAVAILABLE_ERROR =
  "Response drafting isn’t connected yet. It activates once the AI writing provider is set up for your workspace.";
const GENERATION_FAILED_ERROR =
  "We couldn’t draft a response this time. Try again, or add more context about the review.";
const WRITE_FAILED_ERROR = "We couldn’t save the review signal. Check your connection and try again.";
const READ_FAILED_ERROR = "We couldn’t load review signals. Check your connection and try again.";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Gate 1a mirror (same as M8): only ACTIVE verticals are served. */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/** Clamp the caller-supplied monitor targets into safe pull requests. */
function clampPulls(raw: unknown): MonitorRequest["pulls"] {
  if (!Array.isArray(raw)) return [];
  const pulls: MonitorRequest["pulls"] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const platform = typeof rec.platform === "string" ? rec.platform.trim().slice(0, PLATFORM_MAX) : "";
    if (platform === "") continue;
    const accountRef =
      typeof rec.accountRef === "string" ? rec.accountRef.trim().slice(0, ACCOUNT_REF_MAX) : "";
    pulls.push({ platform, accountRef });
    if (pulls.length >= PLATFORMS_MAX) break;
  }
  return pulls;
}

/** Clamp a caller-supplied review into a safe IngestedReview, or null when unusable. */
function clampReview(raw: unknown): IngestedReview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const platform = typeof rec.platform === "string" ? rec.platform.trim().slice(0, PLATFORM_MAX) : "";
  const text = typeof rec.text === "string" ? rec.text.slice(0, REVIEW_TEXT_MAX) : "";
  // A reply needs SOMETHING to respond to: a platform + either text or a rating.
  const rating = typeof rec.rating === "number" && Number.isFinite(rec.rating) ? rec.rating : null;
  if (platform === "" || (text.trim() === "" && rating === null)) return null;
  const ratingScale =
    typeof rec.ratingScale === "number" && Number.isFinite(rec.ratingScale) && rec.ratingScale > 0
      ? rec.ratingScale
      : 5;
  return {
    platform,
    author: typeof rec.author === "string" ? rec.author.trim().slice(0, AUTHOR_MAX) : null,
    rating,
    ratingScale,
    text,
    postedAt: typeof rec.postedAt === "string" ? rec.postedAt : null,
    externalId: typeof rec.externalId === "string" ? rec.externalId.slice(0, PLATFORM_MAX) : null,
  };
}

/** Clamp the caller-supplied grounding context facts. */
function clampContextFacts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const facts: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    facts.push(trimmed.slice(0, CONTEXT_FACT_MAX));
    if (facts.length >= CONTEXT_FACTS_MAX) break;
  }
  return facts;
}

/** RLS-scoped client read: existence + the vertical (the playbook selector). */
async function scopedClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clientId: string,
): Promise<
  | { ok: true; client: { id: string; vertical: string } }
  | { ok: false; reason: "not_found" | "read_failed" }
> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, vertical")
    .eq("id", clientId)
    .maybeSingle();
  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, client: data as { id: string; vertical: string } };
}

/* ------------------------------------------------------------------ */
/* captureReviewSignal — MONITOR → sentiment+velocity → persist        */
/* ------------------------------------------------------------------ */

export interface CaptureReviewSignalInput {
  clientId: string;
  /** The platforms + account refs to monitor (never credentials). */
  platforms: Array<{ platform: string; accountRef: string }>;
  /** Velocity window in days (stated in the signal); defaults to 30. */
  windowDays?: number;
}

export async function captureReviewSignal(
  input: CaptureReviewSignalInput,
): Promise<CaptureReviewSignalResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const pulls = clampPulls(input?.platforms);
  if (pulls.length === 0) return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };

  const windowDays =
    typeof input?.windowDays === "number" && Number.isFinite(input.windowDays) && input.windowDays >= 1
      ? Math.min(Math.floor(input.windowDays), WINDOW_DAYS_MAX)
      : undefined;

  const supabase = await createClient();
  try {
    const scoped = await scopedClient(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (!activePlaybook(scoped.client.vertical)) {
      return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
    }

    // MONITOR via the deferred provider (every platform fails closed → excluded).
    const monitor = await ingestReviews(resolveReviewPlatformProvider(), { pulls });
    if (monitor.coveredPlatforms.length === 0) {
      // Nothing connected: an HONEST unavailable, not a misleading all-zero signal
      // (an all-excluded capture must never read as "no negative reviews").
      return {
        ok: false,
        reason: "monitor_unavailable",
        error: MONITOR_UNAVAILABLE_ERROR,
        excludedPlatforms: monitor.excludedPlatforms.map((e) => e.platform),
      };
    }

    // The action owns the clock; the pure signal builder is clock-free.
    const signal = buildReviewSignal({ monitor, now: new Date().toISOString(), windowDays });

    const persisted = await persistReviewSignal(supabase, claims.tenantId, {
      clientId: scoped.client.id,
      signal,
    });
    if (!persisted.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };

    return { ok: true, metricId: persisted.metricId, signal };
  } catch (err) {
    logReviewFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* draftReviewResponse — DRAFT one on-brand reply (pre-approval)       */
/* ------------------------------------------------------------------ */

export interface DraftReviewResponseActionInput {
  clientId: string;
  /** The review to respond to (from a prior monitor pull; not persisted). */
  review: IngestedReview;
  /** Client-supplied facts the reply may assert (grounding). */
  contextFacts?: string[];
}

export async function draftReviewResponse(
  input: DraftReviewResponseActionInput,
): Promise<DraftReviewResponseResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }
  // claims authenticates the caller; the draft is not persisted, so tenantId is
  // used only to scope the reads below (RLS is the boundary regardless).
  void claims;

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const review = clampReview(input?.review);
  if (review === null) return { ok: false, reason: "invalid_input", error: INVALID_REVIEW_ERROR };
  const contextFacts = clampContextFacts(input?.contextFacts);

  const supabase = await createClient();
  try {
    const scoped = await scopedClient(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
    }
    const playbook = activePlaybook(scoped.client.vertical);
    if (!playbook) return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };

    // The locked brand kit is MANDATORY — voice can't be enforced without it, and
    // a silent generic-voice fallback is exactly what the pipeline prevents (M8 parity).
    const kitRes = await readLockedBrandKit({ clientId: scoped.client.id });
    if (!kitRes.ok) {
      return kitRes.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
    }
    if (kitRes.kit === null) return { ok: false, reason: "no_brand_kit", error: NO_BRAND_KIT_ERROR };

    // DRAFT via the injected (deferred) content provider → generation_unavailable.
    const outcome = await draftReviewResponseCore(resolveContentProvider(), {
      request: { review, contextFacts },
      voice: kitRes.kit.voiceProfile,
      vertical: playbook.vertical,
    });
    if (!outcome.ok) {
      if (outcome.reason === "generation_unavailable") {
        logReviewFailure("generate", outcome.cause);
        return { ok: false, reason: "generation_unavailable", error: GENERATION_UNAVAILABLE_ERROR };
      }
      return { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
    }

    // NOT PERSISTED (no review_response content type — REVIEW_RESPONSE_CONTENT_TYPE_GAP).
    // The pre-approval draft + report ride back for the Quality/Compliance gates.
    return { ok: true, draft: outcome.draft };
  } catch (err) {
    logReviewFailure("thrown", err);
    return { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* listReviewSignals — the review-signal queue (dashboard + gates + M17) */
/* ------------------------------------------------------------------ */

/**
 * Newest-first review signals for a client. Guarded by `requireAuth` ONLY,
 * mirroring `metrics_select` (migration 0006) honestly: reads are open to any
 * tenant member, and `app.client_scope` already narrows a client_viewer to its own
 * client's signals. RLS is the enforcement boundary.
 */
export async function listReviewSignals(input: { clientId: string }): Promise<ListReviewSignalsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readReviewSignalsForClient(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, entries: res.entries };
}
