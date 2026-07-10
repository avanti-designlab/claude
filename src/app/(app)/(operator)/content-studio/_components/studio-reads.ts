import "server-only";

/**
 * RLS-scoped reads for the Content Studio. Like the other operator surfaces
 * (reads.ts, the review queue, the Brand Kits studio), these pass the
 * claim-scoped server client so every row is pinned to `tenant_id =
 * app.tenant_id()` (and client-scope for a viewer) in the database — app code
 * writes no tenant filter; RLS is the boundary.
 *
 * WHY A DIRECT `content_items` READ (not M8's `listContentDrafts`): the pipeline
 * board needs each item's `title` and, for a sent-back row, the failing gate's
 * NOTE — neither is carried by M8's `ContentDraftSummary`. This is the SAME
 * direct RLS-scoped read the Review & Approvals queue uses (its precedent), not a
 * new endpoint. See STUDIO_CONTENT_READ_GAP for the flagged backend enrichment.
 */

import { tryCreateClient, type Supabase } from "../../../_components/reads";
import { parseVerdict } from "@/lib/production/review/detail-reads";
import type { ContentItemStatus, ContentItemType } from "@/lib/types/db";

/**
 * Flag (greppable by the Orchestrator/docs agent — M8/M10 precedent): M8's read
 * contract (`listContentDrafts` → `ContentDraftSummary`) surfaces neither the
 * `content_items.title` column nor the review-verdict notes the sent-back
 * summary needs, so the studio reads the table directly (queue precedent). A
 * `title` + first-failing-note projection on `ContentDraftSummary` would let a
 * single canonical read serve both surfaces — post-handoff Orchestrator + Code
 * Review path, not an ad-hoc change.
 */
export const STUDIO_CONTENT_READ_GAP =
  "content Studio reads content_items directly (title + send-back note) because " +
  "M8's ContentDraftSummary carries neither; a backend projection would unify it.";

/**
 * Flag: the brief form cannot capture an operator-supplied TITLE. `content_items`
 * has a `title` column (migration 0009), but `CreateContentDraftInput` accepts no
 * title and M8's insert row never writes it — the working title is produced BY
 * the generator (returned as `createContentDraft`'s `title`). Capturing a title
 * at brief time would need a `title` field on the create contract + the insert
 * row (post-freeze Orchestrator + Code Review path); until then the brief form
 * offers no title field (faking one would be a field that goes nowhere), and the
 * pipeline renders the stored title or an honest "Untitled".
 */
export const STUDIO_TITLE_AT_BRIEF_GAP =
  "createContentDraft accepts no title and M8's insert row never writes " +
  "content_items.title; a brief-time title needs a create-contract + insert-row change.";

/* ------------------------------------------------------------------ */
/* Client directory — split by brand-kit eligibility                   */
/* ------------------------------------------------------------------ */

/** Only what the studio renders (CR minor 3: no dead columns in the select). */
export interface StudioClient {
  id: string;
  name: string;
}

export type DirectoryLoad =
  | { ok: false }
  | { ok: true; eligible: StudioClient[]; needsKit: StudioClient[] };

/**
 * Every in-scope client, split by whether a LOCKED brand kit exists. A
 * `brand_kits` row IS a locked kit (persistence is insert-only and stores only
 * locked captures — the same signal the Brand Kits ingest picker uses), so:
 *   - eligible  = has a kit  → M8 can generate in the client's brand voice;
 *   - needsKit  = no kit     → M8 refuses with `no_brand_kit`, so the studio
 *                              points the operator at the kit-ingest flow first.
 * Both reads are RLS-scoped; the split is done in app code, never a cross-tenant
 * query. Env-unset (tryCreateClient → null) fails to `ok:false`, never a 500.
 */
export async function loadDirectory(): Promise<DirectoryLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [clientsRes, kitsRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name")
        .order("name", { ascending: true }),
      supabase.from("brand_kits").select("client_id"),
    ]);
    if (clientsRes.error || !clientsRes.data) return { ok: false };
    if (kitsRes.error || !kitsRes.data) return { ok: false };

    const withKit = new Set(
      (kitsRes.data as Array<{ client_id: string }>).map((r) => r.client_id),
    );
    const eligible: StudioClient[] = [];
    const needsKit: StudioClient[] = [];
    for (const c of clientsRes.data as StudioClient[]) {
      const bucket = withKit.has(c.id) ? eligible : needsKit;
      bucket.push({ id: c.id, name: c.name });
    }
    return { ok: true, eligible, needsKit };
  } catch {
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline lanes — one client's content_items, grouped by real status */
/* ------------------------------------------------------------------ */

export interface PipelineItem {
  id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  /** Null renders as "Untitled" (never fabricated from the body). */
  title: string | null;
  updatedAt: string;
  /** First failing gate's note — only for a needs_revision row (queue parity). */
  sendBackNote: string | null;
}

export type LaneSection =
  | { ok: true; items: PipelineItem[]; count: number | null }
  | { ok: false };

export interface PipelineLoad {
  draft: LaneSection;
  inReview: LaneSection;
  needsRevision: LaneSection;
  approved: LaneSection;
}

/** Rows shown per lane; the exact HEAD count backs an honest truncation note. */
export const LANE_LIMIT = 24;

/** First failing gate's note for a needs_revision row — the queue's exact rule. */
function sendBackSummary(
  status: ContentItemStatus,
  quality: unknown,
  compliance: unknown,
): string | null {
  if (status !== "needs_revision") return null;
  const q = parseVerdict(quality);
  if (q?.passed === false && q.note) return q.note;
  const c = parseVerdict(compliance);
  if (c?.passed === false && c.note) return c.note;
  return null;
}

async function loadLane(
  supabase: Supabase,
  clientId: string,
  statuses: ContentItemStatus[],
): Promise<LaneSection> {
  const rowsQuery = supabase
    .from("content_items")
    .select("id, type, status, title, updated_at, quality_review, compliance_review")
    .eq("client_id", clientId)
    .in("status", statuses)
    .order("updated_at", { ascending: false })
    .limit(LANE_LIMIT);
  const countQuery = supabase
    .from("content_items")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .in("status", statuses);

  const [rowsRes, countRes] = await Promise.all([rowsQuery, countQuery]);
  if (rowsRes.error || !rowsRes.data) return { ok: false };

  const items: PipelineItem[] = (
    rowsRes.data as Array<{
      id: string;
      type: ContentItemType;
      status: ContentItemStatus;
      title: unknown;
      updated_at: string;
      quality_review: unknown;
      compliance_review: unknown;
    }>
  ).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    title: typeof r.title === "string" && r.title.trim() !== "" ? r.title : null,
    updatedAt: r.updated_at,
    sendBackNote: sendBackSummary(r.status, r.quality_review, r.compliance_review),
  }));
  return { ok: true, items, count: countRes.error ? null : countRes.count };
}

/**
 * One client's pipeline, grouped into the four real lanes. Each lane is its own
 * rows + exact-count pair (independent failure domain — one lane read failing
 * shows a FailedState for that lane only). `null` = the whole load couldn't run
 * (env-unset or a thrown error), rendered as a single FailedState. The Approved
 * lane also carries `published` rows (structurally unreachable today — publish is
 * not wired — but honest if one ever exists).
 */
export async function loadPipeline(clientId: string): Promise<PipelineLoad | null> {
  const supabase = await tryCreateClient();
  if (!supabase) return null;
  try {
    const [draft, inReview, needsRevision, approved] = await Promise.all([
      loadLane(supabase, clientId, ["draft"]),
      loadLane(supabase, clientId, ["in_review"]),
      loadLane(supabase, clientId, ["needs_revision"]),
      loadLane(supabase, clientId, ["approved", "published"]),
    ]);
    return { draft, inReview, needsRevision, approved };
  } catch {
    return null;
  }
}
