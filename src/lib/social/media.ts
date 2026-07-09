/**
 * M11 media — the BRAND-FORCING seam (doc 05 Part B: creative is brand-forced
 * through the client's locked brand kit). Pure w.r.t. the platform: the media
 * vendor is the injected {@link MediaGenerationProvider} port, no DB, no auth, no
 * logging.
 *
 * BRAND-FORCED FROM THE START (the visual analog of M8's voice enforcement).
 * `buildMediaGenerationRequest` derives the HARD brand constraints server-side
 * from M7's LOCKED kit — the brand-driven palette (accent trio), the logo, and the
 * Higgsfield/Motion likeness reference ids — and stamps them onto the request. The
 * caller supplies only creative DIRECTION (a brief); it can never request unbranded
 * creative, and off-brand output is prevented at generation, not corrected after.
 */

import type { LockedBrandKit } from "@/lib/production/brand-kit";
import type { MediaGenerationProvider } from "./provider";
import type { BrandVisualConstraints, MediaBrief, MediaGenerationRequest, MediaRef } from "./types";

/**
 * Extract the brand-driven palette from the locked kit's color tokens: the accent
 * trio (accent = "the color that does the talking", accentSecondary = energy,
 * accentWarm = warm pops — doc 06 §2 / types/brand.ts). The neutral chrome
 * (surface/ink/muted) is deliberately NOT forced — it is dashboard chrome, not the
 * client's brand palette. Deduped, order-stable (accent first).
 */
export function brandPalette(kit: LockedBrandKit): string[] {
  const colors = kit.tokens?.colors;
  const candidates = [colors?.accent, colors?.accentSecondary, colors?.accentWarm];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const hex = c.trim();
    if (hex === "" || seen.has(hex.toLowerCase())) continue;
    seen.add(hex.toLowerCase());
    out.push(hex);
  }
  return out;
}

/** Derive the HARD brand constraints from the locked kit (palette + logo + likeness). */
export function brandVisualConstraints(kit: LockedBrandKit): BrandVisualConstraints {
  return {
    palette: brandPalette(kit),
    logoUrl: typeof kit.logoUrl === "string" ? kit.logoUrl : null,
    likenessRefs: {
      higgsfieldElementIds: [...(kit.likenessRefs?.higgsfieldElementIds ?? [])],
      motionElementIds: [...(kit.likenessRefs?.motionElementIds ?? [])],
    },
  };
}

/**
 * Assemble the fully brand-forced media request. The `brand` block is derived from
 * the locked kit ONLY — never from the caller — so every generation is brand-forced.
 */
export function buildMediaGenerationRequest(args: {
  kit: LockedBrandKit;
  brief: MediaBrief;
}): MediaGenerationRequest {
  return {
    brief: {
      mediaType: args.brief.mediaType,
      prompt: args.brief.prompt,
      ...(args.brief.aspectRatio !== undefined ? { aspectRatio: args.brief.aspectRatio } : {}),
    },
    brand: brandVisualConstraints(args.kit),
  };
}

export type RequestMediaOutcome =
  | { ok: true; media: MediaRef }
  | { ok: false; reason: "media_unavailable"; cause?: unknown };

/**
 * Generate one brand-forced creative. The provider is injected; a thrown/rejected
 * provider (the deferred Higgsfield/Motion adapter, a timeout, a vendor error) maps
 * to `media_unavailable` WITHOUT surfacing the raw cause as content — the action
 * logs a redacted line. On success the produced {@link MediaRef} rides back to the
 * caller (the frozen schema has no home for it — see SOCIAL_MEDIA_REF_SCHEMA_GAP).
 */
export async function requestMedia(
  provider: MediaGenerationProvider,
  request: MediaGenerationRequest,
): Promise<RequestMediaOutcome> {
  try {
    const media = await provider.generate(request);
    return { ok: true, media };
  } catch (cause) {
    return { ok: false, reason: "media_unavailable", cause };
  }
}
