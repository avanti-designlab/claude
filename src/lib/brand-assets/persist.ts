import "server-only";

/**
 * brand_assets persistence + reads (migration 0014). NOT a "use server" module
 * (house rule — same as brand-kit/plans persist): exporting these from an action
 * file would mint each as a browser-invokable RPC. A plain server-side module
 * that only the audited actions import. Every caller passes a claim-scoped
 * Supabase client + a CLAIM-SOURCED tenantId; RLS (`brand_assets_*`, 0014)
 * re-pins tenant scope below us, the composite FK forbids a cross-tenant client
 * reference, and `brand_assets_path_scoped` forbids a foreign object path.
 */

import type { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/db";
import { brandAssetFromRow, brandAssetInsertRow, type BrandAsset } from "./rows";
import type { BrandAssetMime, BrandAssetType } from "@/lib/types/db";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Library lists are bounded newest-first (an operator needs recency; PostgREST
 *  caps rows server-side regardless). */
export const BRAND_ASSET_LIST_MAX = 500;

/** Columns a read selects — never the bytes (there are none in the row). */
const SELECT_COLUMNS =
  "id, client_id, type, label, variants, storage_path, content_type, size_bytes, archived_at, created_at, updated_at";

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — brand-kit/persist)     */
/* ------------------------------------------------------------------ */

export const BRAND_ASSET_FAILURE_MARKER = "[brand-asset-write-failure]";

export type BrandAssetFailureStage =
  | "asset_insert"
  | "asset_repoint"
  | "asset_archive"
  | "asset_delete"
  | "asset_read"
  | "asset_list"
  | "thrown";

export function logAssetFailure(stage: BrandAssetFailureStage, cause: unknown): void {
  console.error(`${BRAND_ASSET_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/** Bare SQLSTATE/PostgREST code only — a hostile error object can never ride
 *  data into the log line (secrets-in-logs rule, docs/ops/environments.md). */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export type InsertAssetResult =
  | { ok: true; assetId: string }
  | { ok: false; conflict: boolean };

/** Insert ONE brand_assets row (a finalized, verified upload). A `23505` (path
 *  or anchor unique violation) is surfaced as `conflict: true`. */
export async function insertAsset(
  supabase: Supabase,
  args: {
    tenantId: string;
    clientId: string;
    type: BrandAssetType;
    label: string | null;
    variants: Record<string, Json>;
    storagePath: string;
    contentType: BrandAssetMime;
    sizeBytes: number;
  }
): Promise<InsertAssetResult> {
  const row = brandAssetInsertRow(args);
  const { data, error } = await supabase.from("brand_assets").insert(row).select("id").single();
  if (error || !data) {
    logAssetFailure("asset_insert", error);
    return { ok: false, conflict: (error as { code?: unknown } | null)?.code === "23505" };
  }
  return { ok: true, assetId: data.id as string };
}

/** Repoint an EXISTING asset row at new bytes (replace): swap storage_path +
 *  content_type + size_bytes (and optional metadata). RLS restricts to the
 *  caller's tenant; the path-scope CHECK restricts to its own client. Returns
 *  the rows touched (0 ⇒ not visible/does-not-exist under RLS). */
export async function repointAsset(
  supabase: Supabase,
  assetId: string,
  patch: {
    storagePath: string;
    contentType: BrandAssetMime;
    sizeBytes: number;
    label?: string | null;
    variants?: Record<string, Json>;
  }
): Promise<{ ok: true; touched: number } | { ok: false; conflict: boolean }> {
  const update: Record<string, Json | null> = {
    storage_path: patch.storagePath,
    content_type: patch.contentType,
    size_bytes: patch.sizeBytes,
  };
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.variants !== undefined) update.variants = patch.variants;
  const { data, error } = await supabase
    .from("brand_assets")
    .update(update)
    .eq("id", assetId)
    .select("id");
  if (error) {
    logAssetFailure("asset_repoint", error);
    return { ok: false, conflict: (error as { code?: unknown }).code === "23505" };
  }
  return { ok: true, touched: (data as unknown[] | null)?.length ?? 0 };
}

/** Soft-delete: set archived_at (KEEP the row + the object). Used when a locked
 *  kit still references the asset. */
export async function archiveAsset(
  supabase: Supabase,
  assetId: string
): Promise<{ ok: true; touched: number } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_assets")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", assetId)
    .is("archived_at", null)
    .select("id");
  if (error) {
    logAssetFailure("asset_archive", error);
    return { ok: false };
  }
  return { ok: true, touched: (data as unknown[] | null)?.length ?? 0 };
}

/** Hard-delete the row (the object is removed separately by the action, only
 *  when unreferenced). Returns rows touched. */
export async function deleteAssetRow(
  supabase: Supabase,
  assetId: string
): Promise<{ ok: true; touched: number } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_assets")
    .delete()
    .eq("id", assetId)
    .select("id");
  if (error) {
    logAssetFailure("asset_delete", error);
    return { ok: false };
  }
  return { ok: true, touched: (data as unknown[] | null)?.length ?? 0 };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** One asset by id (RLS-scoped). null ⇒ not visible to the caller / absent —
 *  the same observation for a cross-tenant id and a nonexistent one (by design,
 *  doc 03 §4). */
export async function readAsset(
  supabase: Supabase,
  assetId: string
): Promise<{ ok: true; asset: BrandAsset | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_assets")
    .select(SELECT_COLUMNS)
    .eq("id", assetId)
    .maybeSingle();
  if (error) {
    logAssetFailure("asset_read", error);
    return { ok: false };
  }
  if (!data) return { ok: true, asset: null };
  return { ok: true, asset: brandAssetFromRow(data as Parameters<typeof brandAssetFromRow>[0]) };
}

/** The client's live library (archived excluded unless asked), newest first. */
export async function listAssets(
  supabase: Supabase,
  clientId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<{ ok: true; assets: BrandAsset[] } | { ok: false }> {
  let query = supabase
    .from("brand_assets")
    .select(SELECT_COLUMNS)
    .eq("client_id", clientId);
  if (!opts.includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error || !data) {
    logAssetFailure("asset_list", error);
    return { ok: false };
  }
  const assets: BrandAsset[] = [];
  for (const raw of (data as Array<Parameters<typeof brandAssetFromRow>[0]>).slice(0, BRAND_ASSET_LIST_MAX)) {
    const asset = brandAssetFromRow(raw);
    if (asset) assets.push(asset);
  }
  return { ok: true, assets };
}
