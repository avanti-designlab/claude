/**
 * M11 Social — public API (doc 05 Part B "Social design"; doc 07 §1.7).
 *
 * The SOCIAL arm of the brand-consistent production engine. Three brand-forced
 * outputs, each enforced against M7's LOCKED kit from the START:
 *   - CAPTION  — on-brand copy through the SAME pipeline as M8 (brand voice +
 *     grounding + 'social_caption' compliance pre-screen), persisted as
 *     content_items.type='caption' at the pinned pre-approval state.
 *   - MEDIA    — brand-forced creative via the deferred Higgsfield/Motion port
 *     (the request carries the kit's palette/logo/likeness as HARD constraints).
 *   - COMPOSE  — caption + media ref + schedule assembled into a PRE-APPROVAL post
 *     (scheduling via the SocialPostingProvider interface only).
 * It generates + composes; it NEVER approves and NEVER posts. Joins `src/lib/social/`,
 * importing M7's locked-kit read, M8's grounding/voice/compliance passes + generation
 * port, the connectors' SocialPostingProvider TYPES, and the compliance skill
 * READ-ONLY — it modifies none of them.
 *
 * THE PIPELINE (doc 05: captions run "through the full pipeline incl. humanization +
 * compliance"):
 *   Generate (M11, brand voice + grounding + compliance pre-screen) → Humanize (M9) →
 *   Detect (M9) → content-quality → compliance-review → Schema (M10, where relevant) →
 *   human approve → (a separate, human-approved schedule write). A producing agent
 *   never approves — or posts — its own output (CLAUDE.md rule 5).
 *
 * WHY IT CANNOT AUTO-POST (structural, not merely policy):
 *  - The caption persists at a PINNED pre-approval state (status 'draft',
 *    automation_level 'ai_draft_human_approve'); the DB CHECK makes approved/published
 *    unreachable without BOTH gate verdicts (which M11 never writes).
 *  - A composed post carries a PINNED pre-approval status ({@link COMPOSED_POST_STATUS})
 *    and `SocialPostingProvider.schedule()` is NEVER called anywhere in this module —
 *    there is no auto-fire path. Publishing is a separate human-approved connector
 *    write (integrations, 1.7), never fired from here.
 *
 * PERSISTENCE HONESTY (against the FROZEN 0005/0006 schema — three greppable gaps):
 *  - CAPTION_GENERATION_TYPE_GAP — M8's generation taxonomy has no 'caption'; the
 *    generation spec uses 'faq' as the nearest analog (the authoritative type is
 *    carried alongside + persistence uses content_items.type='caption').
 *  - SOCIAL_MEDIA_REF_SCHEMA_GAP — no media-asset column, so a generated MediaRef is
 *    NOT persisted (returned in the action result for the gates + compose).
 *  - SOCIAL_SCHEDULE_SCHEMA_GAP — no `social_posts` table, so a composed post is NOT
 *    persisted (returned as a pre-approval artifact; a later human-approved write posts).
 */

/** Shared social types + media-type guard. */
export {
  SOCIAL_MEDIA_TYPES,
  isSocialMediaType,
  type SocialMediaType,
  type BrandVisualConstraints,
  type MediaBrief,
  type MediaGenerationRequest,
  type MediaRef,
  type CaptionReport,
} from "./types";

/** The MEDIA port (deferred Higgsfield/Motion) + its scriptable fake. */
export {
  type MediaGenerationProvider,
  type MediaScript,
  ScriptedMediaGenerationProvider,
} from "./provider";

/** Brand-forcing seam (palette/logo/likeness → hard constraints) + the media request flow. */
export {
  brandPalette,
  brandVisualConstraints,
  buildMediaGenerationRequest,
  requestMedia,
  type RequestMediaOutcome,
} from "./media";

/** Caption generation (pure; content-generation port injected) + the generation-type analog. */
export {
  generateCaption,
  buildCaptionSpec,
  CAPTION_GENERATION_CONTENT_TYPE,
  type CaptionRequest,
  type GenerateCaptionInput,
  type GenerateCaptionOutcome,
} from "./caption";

/** Compose (pure; the structural no-auto-post pin) + the pinned pre-approval status. */
export {
  composeSocialPost as composeSocialPostCore,
  mediaRefToAsset,
  COMPOSED_POST_STATUS,
  type ComposedSocialPost,
} from "./compose";

/** Row mapping (the pinned pre-approval caption insert) + the three greppable schema-gap flags. */
export {
  captionInsertRow,
  CAPTION_CONTENT_TYPE,
  CAPTION_INITIAL_STATUS,
  CAPTION_AUTOMATION_LEVEL,
  CAPTION_GENERATION_TYPE_GAP,
  SOCIAL_MEDIA_REF_SCHEMA_GAP,
  SOCIAL_SCHEDULE_SCHEMA_GAP,
} from "./rows";

/** Server actions — generate a caption, generate brand-forced media, compose a post, read the queue. */
export {
  createSocialCaption,
  generateSocialMedia,
  composeSocialPost,
  listSocialCaptions,
  readSocialCaption,
  type CreateSocialCaptionInput,
  type CreateSocialCaptionResult,
  type GenerateSocialMediaInput,
  type GenerateSocialMediaResult,
  type ComposeSocialPostInput,
  type ComposeSocialPostResult,
  type ListSocialCaptionsResult,
  type ReadSocialCaptionResult,
} from "./actions";
