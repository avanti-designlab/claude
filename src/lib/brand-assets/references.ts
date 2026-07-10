import "server-only";

/**
 * Locked-kit reference scan — the "never dangle an immutable kit's snapshot"
 * enforcement (Orchestrator ruling, conditions 1 + 5). The remove/replace
 * actions consult this BEFORE deleting a row or its stored object; when a LOCKED
 * brand_kit version references the asset, remove ARCHIVES instead of deleting
 * and replace KEEPS the old object — the on-delete-restrict discipline applied
 * to storage.
 *
 * THE REFERENCE CONTRACT (published: docs/contracts/data-model.md §13.8). A
 * locked brand_kit snapshot records the assets it froze in the frozen, open
 * `brand_kits.assets` jsonb (0003) under `asset_refs` — an array of
 * `{ asset_id, storage_path }` (mirroring likeness_refs). Using the existing
 * open jsonb keeps this slice to migration 0014 + brand_assets ONLY (the
 * brand_kits schema is FROZEN and untouched). The WRITING side (M7's lock/revise
 * flow populating asset_refs) is future work; this READING side is built and
 * correct now — with no refs yet recorded it simply reports `referenced:false`,
 * and it starts honoring snapshots the moment M7 writes them, no change here.
 *
 * A match is by asset_id OR storage_path: the path is what resolves to bytes (so
 * a path still referenced must keep its object); the id catches a reference that
 * outlived a replace. Scan is scoped to the SAME client's locked kits (a kit
 * references only its own client's assets) and runs under the caller's RLS
 * (is_writer sees the whole tenant), so it needs no elevated access.
 */

import type { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/types/db";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Stable, greppable marker for the future M7 writing side. */
export const ASSET_REF_CONTRACT =
  "Locked brand_kits snapshot referenced assets in brand_kits.assets.asset_refs " +
  "([{asset_id, storage_path}]). remove()/replace() honor these to never dangle " +
  "an immutable kit's snapshot. Writing side (M7 lock/revise) is future work.";

export type AssetReferenceScan =
  | { ok: true; referenced: boolean }
  | { ok: false };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract the `asset_refs` array from a kit's `assets` jsonb, tolerantly. */
function assetRefsOf(assets: Json | null): Array<{ asset_id?: unknown; storage_path?: unknown }> {
  if (!isObject(assets)) return [];
  const refs = (assets as Record<string, unknown>).asset_refs;
  if (!Array.isArray(refs)) return [];
  return refs.filter(isObject) as Array<{ asset_id?: unknown; storage_path?: unknown }>;
}

/**
 * Is `assetId` (or its `storagePath`) referenced by any LOCKED brand_kit version
 * of the given client? `{ ok: false }` on a read failure — callers MUST treat a
 * failed scan as "cannot prove unreferenced" and refuse to hard-delete (fail
 * safe: never destroy bytes a snapshot might need).
 */
export async function isAssetReferencedByLockedKit(
  supabase: Supabase,
  args: { clientId: string; assetId: string; storagePath: string }
): Promise<AssetReferenceScan> {
  const { data, error } = await supabase
    .from("brand_kits")
    .select("assets")
    .eq("client_id", args.clientId)
    .eq("locked", true);
  if (error || !data) return { ok: false };

  for (const row of data as Array<{ assets: Json | null }>) {
    for (const ref of assetRefsOf(row.assets)) {
      if (ref.asset_id === args.assetId || ref.storage_path === args.storagePath) {
        return { ok: true, referenced: true };
      }
    }
  }
  return { ok: true, referenced: false };
}
