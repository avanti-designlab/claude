/**
 * Pure BrandAsset ⇄ `brand_assets` row mapping (FROZEN-pattern schema:
 * supabase/migrations/0014_brand_assets.sql). Mirrors the brand-kit/audit split
 * (src/lib/production/brand-kit/rows.ts): no server imports, no Supabase client
 * — unit-tested in the default `npm test` run; the actions feed these rows to
 * PostgREST and shape reads back through them.
 *
 * Scoping ids (tenant_id/client_id) are pinned here from caller-supplied values
 * that are claim-/RLS-sourced upstream, and re-pinned below us by RLS
 * (`brand_assets_insert`, 0014) + the composite FK (tenant, client) → clients +
 * the `brand_assets_path_scoped` CHECK — so a row can never land outside the
 * caller's tenant/client or point at a foreign object path. `storage_path`
 * carries the ONLY pointer to the bytes; raw bytes never live in the row.
 */

import type { BrandAssetMime, BrandAssetType, Json } from "@/lib/types/db";

/** Insert shape for `brand_assets` (only the caller-set columns; id/timestamps
 *  default in the DB, archived_at starts NULL). */
export interface BrandAssetInsertRow {
  tenant_id: string;
  client_id: string;
  type: BrandAssetType;
  label: string | null;
  variants: Record<string, Json>;
  storage_path: string;
  content_type: BrandAssetMime;
  size_bytes: number;
}

export function brandAssetInsertRow(args: {
  tenantId: string;
  clientId: string;
  type: BrandAssetType;
  label: string | null;
  variants: Record<string, Json>;
  storagePath: string;
  contentType: BrandAssetMime;
  sizeBytes: number;
}): BrandAssetInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    type: args.type,
    label: args.label,
    variants: args.variants,
    storage_path: args.storagePath,
    content_type: args.contentType,
    size_bytes: args.sizeBytes,
  };
}

/** The library item shape the actions return + the UI slice renders (metadata
 *  only — NEVER the bytes; a signed URL is issued separately, on demand). */
export interface BrandAsset {
  id: string;
  clientId: string;
  type: BrandAssetType;
  label: string | null;
  variants: Record<string, Json>;
  /** The private-bucket object path. Not directly usable — the caller must
   *  request a signed URL (getAssetSignedUrl) after an authorization check. */
  storagePath: string;
  contentType: BrandAssetMime;
  sizeBytes: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape a raw `brand_assets` row (RLS-scoped read) into a BrandAsset, or null
 * when a load-bearing column is structurally unusable (an unusable row must
 * never masquerade as a real asset). `variants` degrades to `{}` (the "no
 * details" state) rather than nulling the whole asset.
 */
export function brandAssetFromRow(row: {
  id: unknown;
  client_id: unknown;
  type: unknown;
  label: unknown;
  variants: unknown;
  storage_path: unknown;
  content_type: unknown;
  size_bytes: unknown;
  archived_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}): BrandAsset | null {
  if (typeof row.id !== "string" || typeof row.client_id !== "string") return null;
  if (typeof row.type !== "string") return null;
  if (typeof row.storage_path !== "string" || row.storage_path.length === 0) return null;
  if (typeof row.content_type !== "string") return null;
  const size = typeof row.size_bytes === "number" ? row.size_bytes : Number(row.size_bytes);
  if (!Number.isFinite(size)) return null;

  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type as BrandAssetType,
    label: typeof row.label === "string" ? row.label : null,
    variants: isObject(row.variants) ? (row.variants as Record<string, Json>) : {},
    storagePath: row.storage_path,
    contentType: row.content_type as BrandAssetMime,
    sizeBytes: size,
    archived: row.archived_at != null,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}
