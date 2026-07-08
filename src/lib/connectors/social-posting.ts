/**
 * SocialPostingProvider — the provider-agnostic social scheduling interface
 * (doc 04 §3 + §7; doc 07 §1.2).
 *
 * LOCKED DECISION (doc 04 §3): rent the posting plumbing (Ayrshare-class).
 * Do NOT build native per-platform integrations — a maintenance sinkhole.
 * M11 (social design + scheduling) calls THIS interface, never a vendor SDK;
 * swapping Ayrshare for another vendor (or a future native layer) changes
 * one adapter, not the module (doc 04 §7: zero module/data-model changes).
 *
 * Real adapters (AyrshareAdapter, ...) land with M11 at 1.7; this module
 * ships the interface plus a journaling in-memory fake so M11 can be built
 * and tested without a vendor account. Vendor keys live in the secrets
 * vault, resolved at call time by the adapter (doc 04 §5).
 */

/**
 * A connected social account. `accountRef` is an opaque provider-side
 * account/profile reference — NEVER a credential (doc 03 §5: raw creds live
 * in the vault only).
 */
export interface SocialAccountRef {
  /** e.g. "instagram", "linkedin", "facebook", "tiktok", "x". Open set. */
  platform: string;
  accountRef: string;
}

/** A produced asset to attach (image/video from the M11 production engine). */
export interface SocialAsset {
  url: string;
  type: "image" | "video";
}

/** One scheduling request (doc 04 §7: `.schedule(account, asset, caption, when)`). */
export interface SocialPostRequest {
  account: SocialAccountRef;
  /** Optional — caption-only posts are legal on some platforms. */
  asset?: SocialAsset;
  caption: string;
  /** ISO-8601 publish time. */
  when: string;
}

/** Normalized vendor response (doc 04 §7: `{ status, post_id }`). */
export interface SocialPostReceipt {
  status: "scheduled" | "posted" | "failed";
  /** Provider-side post id; null when scheduling failed. */
  postId: string | null;
  /** Human-readable provider detail (error message, warnings). */
  detail?: string;
}

/**
 * The provider-agnostic connector interface. Implementations:
 * AyrshareAdapter | <OtherVendor>Adapter | (future) NativeAdapter — plus
 * {@link InMemorySocialPostingProvider} for tests.
 */
export interface SocialPostingProvider {
  /** Stable vendor id for provenance, e.g. "ayrshare", "in-memory". */
  readonly vendor: string;
  schedule(request: SocialPostRequest): Promise<SocialPostReceipt>;
}

/* ------------------------------------------------------------------ */
/* In-memory fake (M11 tests; no vendor account needed)                */
/* ------------------------------------------------------------------ */

export interface ScheduledPost {
  request: SocialPostRequest;
  receipt: SocialPostReceipt;
}

/**
 * Journaling test double: every accepted request is recorded with the
 * receipt it returned. Fault injection via `failNext` (rejects) and
 * `declineNext` (resolves with status 'failed', as vendors commonly do for
 * per-platform policy refusals) exercises both module error paths.
 */
export class InMemorySocialPostingProvider implements SocialPostingProvider {
  readonly vendor = "in-memory";
  readonly posts: ScheduledPost[] = [];
  private nextError: Error | null = null;
  private nextDecline: string | null = null;
  private seq = 0;

  /** The next schedule() call rejects with `error` (transport failure). */
  failNext(error: Error = new Error("social provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  /** The next schedule() call resolves with status 'failed' (vendor refusal). */
  declineNext(detail = "platform rejected the post"): this {
    this.nextDecline = detail;
    return this;
  }

  async schedule(request: SocialPostRequest): Promise<SocialPostReceipt> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    if (request.caption.trim() === "" && !request.asset) {
      return { status: "failed", postId: null, detail: "empty post: no caption and no asset" };
    }
    if (Number.isNaN(Date.parse(request.when))) {
      return { status: "failed", postId: null, detail: `invalid schedule time '${request.when}'` };
    }
    if (this.nextDecline) {
      const detail = this.nextDecline;
      this.nextDecline = null;
      const receipt: SocialPostReceipt = { status: "failed", postId: null, detail };
      this.posts.push({ request, receipt });
      return receipt;
    }
    this.seq += 1;
    const receipt: SocialPostReceipt = {
      status: "scheduled",
      postId: `in-memory-post-${this.seq}`,
    };
    this.posts.push({ request, receipt });
    return receipt;
  }
}
