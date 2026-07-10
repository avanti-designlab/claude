import { isUuidV4 } from "@/lib/clients/validate";

/**
 * The queue's filter state as URL parts — a PURE helper (importable from any
 * page in the studio) so an operator's filters survive the round-trip into a
 * detail view and back (Design Review m5, 2026-07-10). Row links append the
 * current filter query; the detail pages' "Back to the queue" links carry it
 * home. Values are WHITELISTED (uuid / closed enums) on every parse — nothing
 * hand-typed into a URL is ever reflected into a link beyond these exact keys.
 */

export interface ReviewFilterParts {
  client?: string;
  kind?: "content" | "change";
  status?: "in_review" | "needs_revision" | "previewed";
}

/** Whitelist raw searchParams down to the queue's valid filter parts. */
export function parseReviewFilterParts(
  raw: Record<string, string | string[] | undefined>
): ReviewFilterParts {
  const parts: ReviewFilterParts = {};
  if (typeof raw.client === "string" && isUuidV4(raw.client)) {
    parts.client = raw.client;
  }
  if (raw.kind === "content" || raw.kind === "change") {
    parts.kind = raw.kind;
  }
  if (
    raw.status === "in_review" ||
    raw.status === "needs_revision" ||
    raw.status === "previewed"
  ) {
    parts.status = raw.status;
  }
  return parts;
}

/** Serialize filter parts to "?..." (or "" when no filter is active). */
export function reviewFilterQuery(parts: ReviewFilterParts): string {
  const qs = new URLSearchParams();
  if (parts.client) qs.set("client", parts.client);
  if (parts.kind) qs.set("kind", parts.kind);
  if (parts.status) qs.set("status", parts.status);
  const s = qs.toString();
  return s === "" ? "" : `?${s}`;
}
