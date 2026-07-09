"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
// M7's read API is a server action, imported DIRECTLY (same convention M8/M15 use —
// the brand-kit index deliberately does not re-export actions).
import { readLockedBrandKit } from "@/lib/production/brand-kit/actions";
// The DEFERRED Anthropic content provider — REUSED from M8 (the same LLM seam, not a
// second port). Server-only; the action tests vi.mock it.
import { resolveContentProvider } from "@/lib/production/content/live-provider";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SocialAccountRef } from "@/lib/connectors";
import type { SeedVertical } from "@/lib/types/playbook";
import { generateCaption } from "./caption";
import { composeSocialPost as composeSocialPostCore, type ComposedSocialPost } from "./compose";
import { resolveMediaGenerationProvider } from "./live-provider";
import { buildMediaGenerationRequest, requestMedia } from "./media";
import {
  logSocialFailure,
  persistCaption,
  readCaptionById,
  readCaptionsForClient,
} from "./persist";
import { SOCIAL_MEDIA_REF_SCHEMA_GAP, SOCIAL_SCHEDULE_SCHEMA_GAP } from "./rows";
import type { CaptionReport } from "./types";
import { isSocialMediaType, type MediaRef, type SocialMediaType } from "./types";
import type { ContentDraftDetail, ContentDraftSummary } from "@/lib/production/content";

/**
 * M11 Social — server actions (doc 05 Part B "Social design"; doc 07 §1.7). M11 owns
 * the social arm of the production engine: brand-voice CAPTIONS (governed like M8),
 * brand-forced MEDIA (deferred Higgsfield/Motion), and COMPOSED posts (scheduling via
 * the SocialPostingProvider interface only). It generates + composes; it NEVER
 * approves and NEVER posts. Security posture mirrors the M8 content + M15 review actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends only a
 *    clientId + generation/compose inputs; the tenant comes from the caller's VERIFIED
 *    JWT claim, and RLS (`content_items_*`, migration 0005) re-pins every row below us.
 *    The persisted client_id comes from an RLS-scoped `clients` read; the brand voice
 *    AND brand visual tokens come from M7's RLS-scoped locked kit — never the caller.
 *    The composite FKs make a cross-tenant OR cross-client reference impossible.
 *  - WRITE RIGHTS MIRROR RLS HONESTLY. `content_items_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the write actions are
 *    `requireOperator()` — social production is module work the operator team runs.
 *  - THE CAPTION + MEDIA REQUEST ARE BUILT SERVER-SIDE. Nothing generative round-trips
 *    through the browser: a caller cannot inject a pre-built caption, forge a
 *    brand_kit_id, request UNBRANDED media, or bypass the grounding / compliance
 *    guardrails; the deferred providers fail closed.
 *
 * NO AUTONOMOUS PUBLISHING (CLAUDE.md rule 5). A caption persists at the pinned
 * pre-approval state (status 'draft', automation_level 'ai_draft_human_approve' — see
 * rows.ts) and can NEVER reach approved/published from here (M11 writes no verdict; the
 * DB CHECK requires both). A composed post carries a pinned pre-approval status and is
 * NOT posted — `SocialPostingProvider.schedule()` is never called in this module.
 *
 * REFUSAL WITHOUT A LOCKED KIT. A client with no locked brand kit is REFUSED — the brand
 * voice AND the brand visual constraints cannot be enforced, and a silent generic
 * fallback is exactly what the pipeline prevents (doc 05).
 *
 * GATE 1a. Only ACTIVE verticals (real-estate first) are served; a dormant/unknown
 * vertical gets `no_playbook`.
 */

/* ------------------------------------------------------------------ */
/* Input clamps                                                        */
/* ------------------------------------------------------------------ */

const TOPIC_MAX = 500;
const GROUNDING_FACTS_MAX = 100;
const GROUNDING_FACT_MAX = 2000;
const PLATFORM_MAX = 100;
const ACCOUNT_REF_MAX = 400;
const PROMPT_MAX = 2000;
const ASPECT_RATIO_MAX = 20;

/* ------------------------------------------------------------------ */
/* Result contracts (FROZEN once consumed by the frontend — post-handoff
   changes require Orchestrator + Code Review sign-off, CLAUDE.md rule 1) */
/* ------------------------------------------------------------------ */

export type CreateSocialCaptionResult =
  | { ok: true; contentItemId: string; report: CaptionReport }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_input"
        | "no_playbook"
        | "no_brand_kit"
        | "generation_unavailable"
        | "generation_failed"
        | "write_failed";
      error: string;
    };

export type GenerateSocialMediaResult =
  | { ok: true; media: MediaRef; persistenceNote: string }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "invalid_input" | "no_playbook" | "no_brand_kit" | "media_unavailable";
      error: string;
    };

export type ComposeSocialPostResult =
  | { ok: true; post: ComposedSocialPost; persistenceNote: string }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "invalid_input" | "read_failed";
      error: string;
    };

export type ListSocialCaptionsResult =
  | { ok: true; entries: ContentDraftSummary[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

export type ReadSocialCaptionResult =
  | { ok: true; caption: ContentDraftDetail | null }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor/skill string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to produce social content — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_INPUT_ERROR =
  "We couldn’t start from these details. Add a topic and try again.";
const INVALID_MEDIA_ERROR =
  "We couldn’t start the creative from these details. Add a prompt and pick image or video, then try again.";
const INVALID_COMPOSE_ERROR =
  "We couldn’t compose this post. Add the caption, the target account, and a schedule time, then try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no content plan to map to. Social production activates once this vertical’s playbook ships.";
const NO_BRAND_KIT_ERROR =
  "This client has no locked brand kit yet, so we can’t produce in their brand voice or brand look. Create the brand kit first — we never fall back to a generic brand.";
const GENERATION_UNAVAILABLE_ERROR =
  "Caption generation isn’t connected yet. It activates once the AI writing provider is set up for your workspace.";
const GENERATION_FAILED_ERROR =
  "We couldn’t produce a caption this time. Try again, or adjust the topic and grounding details.";
const MEDIA_UNAVAILABLE_ERROR =
  "Brand creative generation isn’t connected yet. It activates once the Higgsfield/Motion media connection is set up for your workspace.";
const WRITE_FAILED_ERROR = "We couldn’t save this caption. Check your connection and try again.";
const CAPTION_NOT_FOUND_ERROR =
  "We couldn’t find that caption. It may have been removed — refresh and try again.";
const READ_FAILED_ERROR = "We couldn’t load social content. Check your connection and try again.";

/** The honest persistence notes surfaced with the un-persisted artifacts (schema gaps). */
const MEDIA_PERSISTENCE_NOTE =
  "This media reference is not stored — there is no media-asset column in the current schema. Attach it to a post to use it.";
const SCHEDULE_PERSISTENCE_NOTE =
  "This composed post is not stored and not scheduled — it’s a preview for review and human approval. Publishing is a separate approved step.";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Gate 1a mirror (same as M8/M15): only ACTIVE verticals are served. */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/** Clamp the free-text grounding inputs before anything downstream sees them. */
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
/* createSocialCaption — GENERATE + persist one pre-approval caption    */
/* ------------------------------------------------------------------ */

export interface CreateSocialCaptionInput {
  clientId: string;
  topic: string;
  /** Optional target platform (e.g. "instagram") — drives the compliance platform signal. */
  platform?: string;
  /** The facts the caption may assert (anti-fabrication grounding set). */
  groundingFacts?: string[];
}

export async function createSocialCaption(
  input: CreateSocialCaptionInput,
): Promise<CreateSocialCaptionResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const topic = typeof input?.topic === "string" ? input.topic.trim().slice(0, TOPIC_MAX) : "";
  if (topic === "") return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };
  const groundingFacts = clampGroundingFacts(input?.groundingFacts);
  const platform =
    typeof input?.platform === "string" && input.platform.trim() !== ""
      ? input.platform.trim().slice(0, PLATFORM_MAX)
      : undefined;

  const supabase = await createClient();
  try {
    const scoped = await scopedClient(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }

    const playbook = activePlaybook(scoped.client.vertical);
    if (!playbook) return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };

    // The locked brand kit is MANDATORY (voice can't be enforced without it).
    const kitRes = await readLockedBrandKit({ clientId: scoped.client.id });
    if (!kitRes.ok) {
      return kitRes.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (kitRes.kit === null) return { ok: false, reason: "no_brand_kit", error: NO_BRAND_KIT_ERROR };
    const kit = kitRes.kit;

    // GENERATE via the injected (deferred) content provider → generation_unavailable.
    const outcome = await generateCaption(resolveContentProvider(), {
      request: { topic, groundingFacts, ...(platform ? { platform } : {}) },
      voice: kit.voiceProfile,
      vertical: playbook.vertical,
    });
    if (!outcome.ok) {
      if (outcome.reason === "generation_unavailable") {
        logSocialFailure("generate", outcome.cause);
        return { ok: false, reason: "generation_unavailable", error: GENERATION_UNAVAILABLE_ERROR };
      }
      return { ok: false, reason: "generation_failed", error: GENERATION_FAILED_ERROR };
    }

    // PERSIST the pre-approval caption. tenant is claim-sourced; client_id +
    // brand_kit_id are RLS-sourced above; the composite FKs re-pin scope.
    const persisted = await persistCaption(supabase, claims.tenantId, {
      clientId: scoped.client.id,
      brandKitId: kit.id,
      body: outcome.body,
    });
    if (!persisted.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };

    return { ok: true, contentItemId: persisted.contentItemId, report: outcome.report };
  } catch (err) {
    logSocialFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* generateSocialMedia — BRAND-FORCED creative (deferred, un-persisted) */
/* ------------------------------------------------------------------ */

export interface GenerateSocialMediaInput {
  clientId: string;
  mediaType: SocialMediaType;
  prompt: string;
  aspectRatio?: string;
}

export async function generateSocialMedia(
  input: GenerateSocialMediaInput,
): Promise<GenerateSocialMediaResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }
  // claims authenticates the caller; the media ref is not persisted (schema gap), so
  // tenantId only scopes the reads below (RLS is the boundary regardless).
  void claims;

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  if (!isSocialMediaType(input?.mediaType)) {
    return { ok: false, reason: "invalid_input", error: INVALID_MEDIA_ERROR };
  }
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim().slice(0, PROMPT_MAX) : "";
  if (prompt === "") return { ok: false, reason: "invalid_input", error: INVALID_MEDIA_ERROR };
  const aspectRatio =
    typeof input?.aspectRatio === "string" && input.aspectRatio.trim() !== ""
      ? input.aspectRatio.trim().slice(0, ASPECT_RATIO_MAX)
      : undefined;

  const supabase = await createClient();
  try {
    const scoped = await scopedClient(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "media_unavailable", error: MEDIA_UNAVAILABLE_ERROR };
    }
    if (!activePlaybook(scoped.client.vertical)) {
      return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
    }

    // The locked brand kit is MANDATORY — the brand VISUAL tokens can't be forced
    // without it, and unbranded creative is exactly what the pipeline prevents.
    const kitRes = await readLockedBrandKit({ clientId: scoped.client.id });
    if (!kitRes.ok) {
      return kitRes.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "media_unavailable", error: MEDIA_UNAVAILABLE_ERROR };
    }
    if (kitRes.kit === null) return { ok: false, reason: "no_brand_kit", error: NO_BRAND_KIT_ERROR };

    // BRAND-FORCE the request server-side from the locked kit, then generate via the
    // injected (deferred) media provider → media_unavailable.
    const request = buildMediaGenerationRequest({
      kit: kitRes.kit,
      brief: { mediaType: input.mediaType, prompt, ...(aspectRatio ? { aspectRatio } : {}) },
    });
    const outcome = await requestMedia(resolveMediaGenerationProvider(), request);
    if (!outcome.ok) {
      logSocialFailure("media", outcome.cause);
      return { ok: false, reason: "media_unavailable", error: MEDIA_UNAVAILABLE_ERROR };
    }

    // NOT PERSISTED — no media-asset column (SOCIAL_MEDIA_REF_SCHEMA_GAP). The ref
    // rides back for the gates + a later compose step.
    void SOCIAL_MEDIA_REF_SCHEMA_GAP;
    return { ok: true, media: outcome.media, persistenceNote: MEDIA_PERSISTENCE_NOTE };
  } catch (err) {
    logSocialFailure("thrown", err);
    return { ok: false, reason: "media_unavailable", error: MEDIA_UNAVAILABLE_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* composeSocialPost — assemble a PRE-APPROVAL post (never posts)       */
/* ------------------------------------------------------------------ */

export interface ComposeSocialPostInput {
  clientId: string;
  /** The pipeline-produced caption to publish (only a persisted caption can be composed). */
  captionContentItemId: string;
  /** The target account (platform + opaque account ref — never a credential). */
  account: { platform: string; accountRef: string };
  /** ISO-8601 publish time (stored on the pre-approval artifact; nothing is scheduled). */
  when: string;
  /** Optional brand-forced media to attach (from generateSocialMedia). */
  media?: MediaRef;
}

export async function composeSocialPost(
  input: ComposeSocialPostInput,
): Promise<ComposeSocialPostResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }
  void claims;

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const captionId = typeof input?.captionContentItemId === "string" ? input.captionContentItemId.trim() : "";
  if (!isUuidV4(captionId)) return { ok: false, reason: "not_found", error: CAPTION_NOT_FOUND_ERROR };

  const platform =
    typeof input?.account?.platform === "string" ? input.account.platform.trim().slice(0, PLATFORM_MAX) : "";
  const accountRef =
    typeof input?.account?.accountRef === "string" ? input.account.accountRef.trim().slice(0, ACCOUNT_REF_MAX) : "";
  const when = typeof input?.when === "string" ? input.when.trim() : "";
  if (platform === "" || accountRef === "" || when === "" || Number.isNaN(Date.parse(when))) {
    return { ok: false, reason: "invalid_input", error: INVALID_COMPOSE_ERROR };
  }

  const supabase = await createClient();
  try {
    // Read the caption from content_items (RLS-scoped, type='caption'): only a
    // pipeline-produced caption can be composed — the caller cannot inject raw text.
    const captionRes = await readCaptionById(supabase, captionId);
    if (!captionRes.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
    if (captionRes.detail === null) return { ok: false, reason: "not_found", error: CAPTION_NOT_FOUND_ERROR };

    const account: SocialAccountRef = { platform, accountRef };
    const post = composeSocialPostCore({
      account,
      caption: captionRes.detail.body,
      when,
      ...(input.media ? { media: input.media } : {}),
      captionContentItemId: captionRes.detail.id,
    });

    // NOT PERSISTED and NOT POSTED — no social_posts table (SOCIAL_SCHEDULE_SCHEMA_GAP);
    // schedule() is never called here. The artifact rides back for review + a later
    // human-approved schedule write.
    void SOCIAL_SCHEDULE_SCHEMA_GAP;
    return { ok: true, post, persistenceNote: SCHEDULE_PERSISTENCE_NOTE };
  } catch (err) {
    logSocialFailure("thrown", err);
    return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* Reads — the social caption queue + the single-caption reviewer read  */
/* ------------------------------------------------------------------ */

/**
 * Newest-first captions for a client — the social queue (Content Quality /
 * Compliance / M9 / dashboard). Guarded by `requireAuth` ONLY, mirroring
 * `content_items_select` (migration 0005) honestly: reads are open to any tenant
 * member, and `app.client_scope` already narrows a client_viewer. RLS is the boundary.
 */
export async function listSocialCaptions(input: { clientId: string }): Promise<ListSocialCaptionsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readCaptionsForClient(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, entries: res.entries };
}

/**
 * The full caption for ONE item — what a reviewer or M9 reads (body + prior verdicts
 * + pipeline state). Same `requireAuth`/RLS posture; a nonexistent OR another-tenant
 * OR non-caption id all come back as `caption: null` (doc 03 §4 parity).
 */
export async function readSocialCaption(input: { contentItemId: string }): Promise<ReadSocialCaptionResult> {
  await requireAuth();

  const contentItemId = typeof input?.contentItemId === "string" ? input.contentItemId.trim() : "";
  if (!isUuidV4(contentItemId)) return { ok: false, reason: "not_found", error: CAPTION_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readCaptionById(supabase, contentItemId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, caption: res.detail };
}
