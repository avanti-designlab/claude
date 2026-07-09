/**
 * M11 COMPOSE — assemble a scheduled social post (caption + media ref + schedule)
 * as a PRE-APPROVAL artifact (doc 05 Part B: "scheduling via the SocialPostingProvider
 * interface only"). Pure — no DB, no auth, no network, no provider call.
 *
 * WHY IT STRUCTURALLY CANNOT AUTO-POST (the governance spine, CLAUDE.md rule 5,
 * doc 00 §2 — the mirror of M15's read-only/pinned-status discipline):
 *  - The output is a {@link ComposedSocialPost} whose `status` is HARD-PINNED to
 *    {@link COMPOSED_POST_STATUS} ('composed_pending_human_approval') — not a
 *    parameter; no caller can raise it to a "scheduled"/"posted" state through here.
 *  - `SocialPostingProvider.schedule()` — the ONE method that actually posts — is
 *    NEVER called anywhere in `src/lib/social/`. This module only BUILDS the exact
 *    {@link SocialPostRequest} a human-approved wired path would later hand to
 *    `schedule()`; the composition module has no reference to a posting provider and
 *    no auto-fire path. Publishing is a separate, human-approved connector write
 *    (integrations, 1.7), never fired from a composed post.
 *  - content-quality + compliance-review remain the hard gates on the caption; this
 *    composes, it never clears or transmits itself.
 */

import type { SocialAccountRef, SocialAsset, SocialPostRequest } from "@/lib/connectors";
import type { MediaRef } from "./types";

/** The ONLY status a composed post ever carries — pinned pre-approval, never "scheduled"/"posted". */
export const COMPOSED_POST_STATUS = "composed_pending_human_approval" as const;

/**
 * A composed, un-posted social post — the pre-approval artifact. It carries the
 * exact vendor-shaped {@link SocialPostRequest} for a LATER human-approved schedule
 * write, plus provenance back to the pipeline-produced caption. There is NO exported
 * transition to a posted state and no `schedule()` call in this module.
 */
export interface ComposedSocialPost {
  status: typeof COMPOSED_POST_STATUS;
  /** The request a human-approved path would hand to SocialPostingProvider.schedule(). */
  request: SocialPostRequest;
  /** The caption content_item this post publishes (audit/provenance for the gates). null if not tracked. */
  captionContentItemId: string | null;
}

/** A produced media ref → the connectors' `SocialAsset` shape ({url, type}). */
export function mediaRefToAsset(media: MediaRef): SocialAsset {
  return { url: media.url, type: media.type };
}

/**
 * Compose a scheduled post from a pipeline-produced caption + (optional) brand-forced
 * media + a target account + schedule time. PURE and post-free: it returns the
 * pre-approval artifact and calls nothing. A caption-only post (no media) is legal on
 * some platforms, so `media` is optional — the produced request carries no asset then.
 */
export function composeSocialPost(args: {
  account: SocialAccountRef;
  caption: string;
  when: string;
  media?: MediaRef;
  captionContentItemId?: string | null;
}): ComposedSocialPost {
  const request: SocialPostRequest = {
    account: args.account,
    caption: args.caption,
    when: args.when,
    ...(args.media ? { asset: mediaRefToAsset(args.media) } : {}),
  };
  return {
    status: COMPOSED_POST_STATUS,
    request,
    captionContentItemId: args.captionContentItemId ?? null,
  };
}
