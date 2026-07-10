import "server-only";

/**
 * RLS-scoped reads for the Image & Media Studio. Like the other operator surfaces
 * (the Content Studio's studio-reads, the review queue), these pass the
 * claim-scoped server client so every row is pinned to `tenant_id =
 * app.tenant_id()` (and client-scope for a viewer) in the database — app code
 * writes no tenant filter; RLS is the boundary. Env-unset (tryCreateClient → null)
 * fails to a FailedState, never a 500.
 *
 * THE CAPTION QUEUE. This mirrors M11's landed `listSocialCaptions` query
 * (src/lib/social/persist.ts: `content_items` WHERE client_id = ? AND type =
 * 'caption', newest-first) — the SAME table + filter, read through the house
 * env-less-safe `tryCreateClient` path the Content Studio + review queue use, so
 * it degrades cleanly during a static build instead of tripping a "use server"
 * auth guard mid-render. It reads content_items DIRECTLY (the established
 * frontend pattern for this table); it does NOT extend the M11 engine or invent
 * an endpoint. RLS scopes every row.
 */

import { tryCreateClient } from "../../../_components/reads";
import type { ContentItemStatus } from "@/lib/types/db";

/** Chars of a caption surfaced in the queue list (scan, not the whole body). */
export const CAPTION_PREVIEW_CHARS = 220;

/** Rows shown in the queue; the exact HEAD count backs an honest truncation note. */
export const CAPTION_QUEUE_LIMIT = 30;

export interface CaptionQueueItem {
  id: string;
  status: ContentItemStatus;
  /** Safe leading slice of the caption body (never the whole thing in a list). */
  preview: string;
  createdAt: string;
  updatedAt: string;
}

export type CaptionQueueLoad =
  | { ok: true; items: CaptionQueueItem[]; count: number | null }
  | { ok: false };

/** Trim + slice a body to a scannable preview; empty body → an honest placeholder. */
function toPreview(body: unknown): string {
  const text = typeof body === "string" ? body.trim() : "";
  if (text === "") return "";
  return text.length > CAPTION_PREVIEW_CHARS ? `${text.slice(0, CAPTION_PREVIEW_CHARS)}…` : text;
}

/**
 * One client's captions (content_items.type='caption'), newest-first, capped.
 * The rows read + an exact HEAD count are one independent load: a read error is a
 * single FailedState (no fabricated rows), and the count backs the truncation
 * note past the cap. RLS scopes both queries to the caller's tenant/client-scope.
 */
export async function loadCaptionQueue(clientId: string): Promise<CaptionQueueLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const rowsQuery = supabase
      .from("content_items")
      .select("id, status, body, created_at, updated_at")
      .eq("client_id", clientId)
      .eq("type", "caption")
      .order("created_at", { ascending: false })
      .limit(CAPTION_QUEUE_LIMIT);
    const countQuery = supabase
      .from("content_items")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("type", "caption");

    const [rowsRes, countRes] = await Promise.all([rowsQuery, countQuery]);
    if (rowsRes.error || !rowsRes.data) return { ok: false };

    const items: CaptionQueueItem[] = (
      rowsRes.data as Array<{
        id: string;
        status: ContentItemStatus;
        body: unknown;
        created_at: string;
        updated_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      status: r.status,
      preview: toPreview(r.body),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return { ok: true, items, count: countRes.error ? null : countRes.count };
  } catch {
    return { ok: false };
  }
}
