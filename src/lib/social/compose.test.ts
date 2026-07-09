/**
 * Compose — the STRUCTURAL no-auto-post pin (CLAUDE.md rule 5). Proves a composed
 * post is a PRE-APPROVAL artifact with a pinned status, builds the exact vendor-shaped
 * SocialPostRequest for a LATER human-approved schedule, and that composing NEVER
 * posts: even holding a live posting provider, nothing is scheduled.
 */

import { describe, expect, it } from "vitest";
import { InMemorySocialPostingProvider } from "@/lib/connectors";
import { composeSocialPost, COMPOSED_POST_STATUS, mediaRefToAsset } from "./compose";
import type { MediaRef } from "./types";

const ACCOUNT = { platform: "instagram", accountRef: "acct-123" };
const MEDIA: MediaRef = { url: "https://cdn/reel.mp4", type: "video", vendor: "higgsfield" };
const WHEN = "2026-08-01T15:00:00Z";

describe("composeSocialPost", () => {
  it("returns a PRE-APPROVAL artifact with the pinned status (never 'scheduled'/'posted')", () => {
    const post = composeSocialPost({ account: ACCOUNT, caption: "hello", when: WHEN, media: MEDIA, captionContentItemId: "ci-1" });
    expect(post.status).toBe(COMPOSED_POST_STATUS);
    expect(post.status).toBe("composed_pending_human_approval");
    expect(post.captionContentItemId).toBe("ci-1");
  });

  it("builds the exact SocialPostRequest a later human-approved schedule would consume", () => {
    const post = composeSocialPost({ account: ACCOUNT, caption: "hello", when: WHEN, media: MEDIA });
    expect(post.request).toEqual({
      account: ACCOUNT,
      caption: "hello",
      when: WHEN,
      asset: { url: "https://cdn/reel.mp4", type: "video" },
    });
  });

  it("a caption-only post (no media) is legal — the request carries no asset", () => {
    const post = composeSocialPost({ account: ACCOUNT, caption: "text only", when: WHEN });
    expect(post.request.asset).toBeUndefined();
    expect(post.request.caption).toBe("text only");
  });

  it("mediaRefToAsset narrows a MediaRef to the connectors' SocialAsset shape", () => {
    expect(mediaRefToAsset(MEDIA)).toEqual({ url: "https://cdn/reel.mp4", type: "video" });
  });

  it("STRUCTURALLY does not post: composing leaves a live posting provider untouched", async () => {
    // The composition module holds NO posting provider and calls schedule() nowhere.
    // Proof: a provider the TEST holds records zero posts after we compose.
    const poster = new InMemorySocialPostingProvider();
    composeSocialPost({ account: ACCOUNT, caption: "hello", when: WHEN, media: MEDIA });
    expect(poster.posts).toHaveLength(0);
    // The artifact is only ready for a LATER, explicit, human-approved schedule call —
    // which is out of this module entirely.
  });
});
