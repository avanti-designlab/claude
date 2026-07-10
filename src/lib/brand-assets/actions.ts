"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import {
  BRAND_ASSET_MAX_BYTES,
  buildStoragePath,
  isSvgMime,
  isTenantClientScopedPath,
  sniffRasterMagic,
  validateAssetMetadata,
  type BrandAssetMime,
  type ValidAssetMetadata,
} from "./validate";
import {
  archiveAsset,
  deleteAssetRow,
  insertAsset,
  listAssets,
  logAssetFailure,
  readAsset,
  repointAsset,
} from "./persist";
import { isAssetReferencedByLockedKit } from "./references";
import { sanitizeSvg } from "./svg-sanitize";
import type { BrandAsset } from "./rows";

/**
 * Brand ASSET LIBRARY — server actions (Orchestrator ruling, 2026-07-10). The
 * platform's FIRST object-storage surface. Security posture mirrors the M7 brand
 * kit + M2 module actions, PLUS a second isolation surface (private Storage
 * bucket):
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends a
 *    clientId + metadata + (SVG only) bytes; the tenant comes from the caller's
 *    VERIFIED JWT claim. RLS (`brand_assets_*`, 0014) re-pins every row, the
 *    composite FK makes a cross-tenant client reference impossible, and the
 *    storage bucket's own RLS (brand-assets-bucket.sql) independently re-checks
 *    the caller's tenant against the object PATH — defense in depth, never path
 *    obscurity alone. The persisted client_id comes from an RLS-scoped read of
 *    `clients` (never trusted from the caller).
 *  - WRITE RIGHTS MIRROR RLS HONESTLY: `requireOperator()` (agency_admin |
 *    operator = `app.is_writer`), the same floor the `brand_assets_insert`
 *    policy admits. Reads are `requireAuth()` — RLS' `app.client_scope` already
 *    narrows a client_viewer to its own client's library.
 *
 * TWO-PHASE UPLOAD, HONESTLY (ruling condition 5):
 *  - RASTER (png/jpeg/webp/gif): `requestAssetUpload` issues a signed upload URL
 *    to a server-computed, tenant/client-scoped path (NO row yet); the browser
 *    PUTs the bytes; `finalizeAssetUpload` VERIFIES the object exists, checks its
 *    REAL size from storage against the cap, and — CRITICALLY — MAGIC-BYTE
 *    SNIFFS the actual leading bytes to confirm an allowlisted RASTER signature,
 *    since Supabase records the object's mimetype from the browser-asserted
 *    Content-Type (unsniffed): a caller could PUT an SVG/HTML file with
 *    `Content-Type: image/png` and the declared type alone would pass. The sniff
 *    reads the object's bytes (bounded by the size cap) and REFUSES + PURGES
 *    anything whose real bytes are not PNG/JPEG/GIF/WEBP (SVG/XML/`<`-leading or
 *    unknown). The stored `content_type` is the SNIFFED type, never the claim.
 *    Then it inserts the row. An upload that never finalizes leaves an ORPHAN
 *    OBJECT, not a dangling row (verify-on-finalize) — the orphan-object
 *    reconciliation sweep is the documented backstop (live-staging canary).
 *  - SVG: bytes travel in the ACTION BODY (never a direct PUT), are sanitized by
 *    the security-critical `sanitizeSvg` (REFUSED if unsafe — throw-not-serve),
 *    and only the sanitized bytes are written server-side. The size cap is
 *    enforced on the action body before sanitizing.
 *
 * REMOVE/REPLACE respect locked-kit snapshots (never dangle): a referenced asset
 * is ARCHIVED (row + object kept), never hard-deleted; a failed reference scan
 * fails SAFE (refuse to destroy bytes). See references.ts.
 *
 * STORAGE IS THE LIVE-STAGING CANARY. The Supabase Storage calls below cannot be
 * exercised by the local Postgres isolation harness (no storage-api locally);
 * everything AROUND them (auth, validation, path scoping, SVG sanitize, the
 * reference scan, row mapping/persistence, the storage.objects RLS policies via
 * the storage shim) IS tested. What needs the canary is called out in the
 * report + docs/ops/environments.md.
 */

const BUCKET = "brand-assets";
const SIGNED_URL_TTL_SECONDS = 300; // 5 min — issued on demand, short-lived
const SIGNED_URL_TTL_MAX = 3600;

/* ------------------------------------------------------------------ */
/* Result contracts (FROZEN once consumed by the frontend slice)       */
/* ------------------------------------------------------------------ */

type FailReason =
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "unsafe_svg"
  | "wrong_flow"
  | "upload_incomplete"
  | "too_large"
  | "already_exists"
  | "storage_failed"
  | "write_failed";

export type RequestUploadResult =
  | { ok: true; storagePath: string; uploadUrl: string; token: string; expiresInSeconds: number }
  | { ok: false; reason: FailReason; error: string };

export type FinalizeUploadResult =
  | { ok: true; asset: BrandAsset }
  | { ok: false; reason: FailReason; error: string };

export type UploadSvgResult =
  | { ok: true; asset: BrandAsset }
  | { ok: false; reason: FailReason; error: string };

export type ListAssetsResult =
  | { ok: true; assets: BrandAsset[] }
  | { ok: false; reason: "forbidden" | "not_found" | "read_failed"; error: string };

export type SignedUrlResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; reason: "forbidden" | "not_found" | "storage_failed"; error: string };

export type RemoveAssetResult =
  | { ok: true; outcome: "removed" | "archived" }
  | { ok: false; reason: FailReason; error: string };

/* Interface-voice copy (doc 06 §6). */
const FORBIDDEN_ERROR =
  "You don’t have permission to manage brand assets — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const ASSET_NOT_FOUND_ERROR =
  "We couldn’t find that asset. It may have been removed — refresh the library and try again.";
const INVALID_INPUT_ERROR =
  "We couldn’t read those asset details. Check the file type and try again.";
const UNSAFE_SVG_ERROR =
  "We couldn’t safely process that SVG. Re-export it as a plain SVG (no scripts, external references, or embedded objects) and try again.";
const WRONG_FLOW_SVG_ERROR =
  "SVGs are uploaded through the secure SVG path — send the file contents, not a direct upload.";
const UPLOAD_INCOMPLETE_ERROR =
  "We didn’t find the uploaded file. The upload may not have finished — try uploading again.";
const TOO_LARGE_ERROR =
  "That file is over the 10 MB limit. Export a smaller version and try again.";
const STORAGE_FAILED_ERROR =
  "We couldn’t reach asset storage. Check your connection and try again.";
const WRITE_FAILED_ERROR =
  "We couldn’t save this asset. Check your connection and try again.";
const READ_FAILED_ERROR =
  "We couldn’t load the asset library. Check your connection and try again.";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Trap ONLY the wrong-role case; a NEXT_REDIRECT (unauthenticated) rethrows. */
async function operatorClaims(): Promise<
  { ok: true; tenantId: string } | { ok: false }
> {
  try {
    const claims = await requireOperator();
    return { ok: true, tenantId: claims.tenantId };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false };
    throw err;
  }
}

/** RLS-scoped confirmation the client exists + is visible; returns its id (never
 *  caller-supplied). A cross-tenant / nonexistent id is INDISTINGUISHABLE (RLS
 *  yields zero rows for both) — correct + intended (doc 03 §4). */
async function scopedClientId(
  supabase: Supabase,
  clientId: string
): Promise<{ ok: true; id: string } | { ok: false; reason: "not_found" | "read_failed" }> {
  const { data, error } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, id: data.id as string };
}

/** Probe a stored object: does it exist, and what is its REAL size + MIME? Reads
 *  the folder listing (never trusts the caller's claim). null ⇒ not found. */
async function probeObject(
  supabase: Supabase,
  path: string
): Promise<{ ok: true; found: false } | { ok: true; found: true; size: number | null; mime: string | null } | { ok: false }> {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const filename = path.slice(slash + 1);
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { search: filename, limit: 100 });
  if (error || !data) return { ok: false };
  const match = (data as Array<{ name: string; metadata?: { size?: unknown; mimetype?: unknown } | null }>).find(
    (o) => o.name === filename
  );
  if (!match) return { ok: true, found: false };
  const size = typeof match.metadata?.size === "number" ? match.metadata.size : null;
  const mime = typeof match.metadata?.mimetype === "string" ? match.metadata.mimetype : null;
  return { ok: true, found: true, size, mime };
}

/** Best-effort object removal (used for cleanup + rejected-finalize). Never
 *  throws into the caller; a failed cleanup is logged, not surfaced. */
async function removeObject(supabase: Supabase, path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) logAssetFailure("thrown", error);
  } catch (err) {
    logAssetFailure("thrown", err);
  }
}

/** Download the object's leading bytes and MAGIC-BYTE SNIFF for an allowlisted
 *  RASTER signature — bytes are truth, never the browser-asserted Content-Type
 *  Supabase stored. `mime: null` ⇒ NOT an allowlisted raster (SVG/HTML/`<`-
 *  leading or unknown) ⇒ the caller purges + refuses. The object size is already
 *  cap-bounded, so downloading it to sniff is bounded work. */
async function sniffStoredRaster(
  supabase: Supabase,
  path: string
): Promise<{ ok: true; mime: BrandAssetMime | null } | { ok: false }> {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !data) return { ok: false };
    const head = new Uint8Array((await data.arrayBuffer()).slice(0, 16));
    return { ok: true, mime: sniffRasterMagic(head) };
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* requestAssetUpload — RASTER phase 1 (signed URL, no row yet)         */
/* ------------------------------------------------------------------ */

export interface RequestUploadInput {
  clientId: string;
  type: unknown;
  label?: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  variants?: unknown;
}

export async function requestAssetUpload(input: RequestUploadInput): Promise<RequestUploadResult> {
  const auth = await operatorClaims();
  if (!auth.ok) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const meta = validateAssetMetadata(input);
  if (!meta.ok) return { ok: false, reason: "invalid_input", error: meta.error };
  // SVG must go through the sanitizing path, never a direct PUT.
  if (isSvgMime(meta.value.contentType)) {
    return { ok: false, reason: "wrong_flow", error: WRONG_FLOW_SVG_ERROR };
  }

  const supabase = await createClient();
  try {
    const scoped = await scopedClientId(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }

    const storagePath = buildStoragePath(auth.tenantId, scoped.id, meta.value.contentType);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data) {
      logAssetFailure("thrown", error);
      return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }
    return {
      ok: true,
      storagePath,
      uploadUrl: data.signedUrl,
      token: data.token,
      expiresInSeconds: SIGNED_URL_TTL_MAX,
    };
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* finalizeAssetUpload — RASTER phase 2 (verify object, then persist)  */
/* ------------------------------------------------------------------ */

export interface FinalizeUploadInput {
  clientId: string;
  storagePath: unknown;
  type: unknown;
  label?: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  variants?: unknown;
  /** When set, REPLACE this existing asset's bytes instead of inserting anew. */
  replaceAssetId?: unknown;
}

export async function finalizeAssetUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
  const auth = await operatorClaims();
  if (!auth.ok) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const meta = validateAssetMetadata(input);
  if (!meta.ok) return { ok: false, reason: "invalid_input", error: meta.error };
  if (isSvgMime(meta.value.contentType)) {
    return { ok: false, reason: "wrong_flow", error: WRONG_FLOW_SVG_ERROR };
  }

  // The returned path MUST be scoped to THIS tenant+client (mirrors the DB
  // CHECK + storage RLS) — rejects a tampered/foreign/traversal path.
  const path = typeof input?.storagePath === "string" ? input.storagePath : "";
  if (!isTenantClientScopedPath(path, auth.tenantId, clientId)) {
    return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };
  }

  const replaceId = typeof input?.replaceAssetId === "string" ? input.replaceAssetId.trim() : "";
  if (input?.replaceAssetId !== undefined && !isUuidV4(replaceId)) {
    return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  try {
    const scoped = await scopedClientId(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }

    // VERIFY-ON-FINALIZE (bytes, not claims). The object must exist and its REAL
    // size must satisfy the cap.
    const probe = await probeObject(supabase, path);
    if (!probe.ok) return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    if (!probe.found) return { ok: false, reason: "upload_incomplete", error: UPLOAD_INCOMPLETE_ERROR };

    const realSize = probe.size ?? meta.value.sizeBytes;
    if (realSize <= 0 || realSize > BRAND_ASSET_MAX_BYTES) {
      await removeObject(supabase, path);
      return { ok: false, reason: "too_large", error: TOO_LARGE_ERROR };
    }

    // MAGIC-BYTE SNIFF: read the object's ACTUAL bytes and require an allowlisted
    // RASTER signature. Supabase stores the browser-asserted Content-Type
    // unsniffed, so a declared `image/png` on genuinely SVG/HTML bytes would slip
    // past a declared-type check — we trust the bytes instead. SVG/`<`-leading or
    // any unknown signature ⇒ null ⇒ purge + refuse. The stored content_type is
    // the SNIFFED type (bytes-truth), never the caller's claim.
    const sniff = await sniffStoredRaster(supabase, path);
    if (!sniff.ok) return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    if (sniff.mime === null) {
      await removeObject(supabase, path);
      return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };
    }
    const realMime: BrandAssetMime = sniff.mime;

    return await persistFinalized(supabase, {
      tenantId: auth.tenantId,
      clientId: scoped.id,
      meta: meta.value,
      storagePath: path,
      contentType: realMime,
      sizeBytes: realSize,
      replaceAssetId: replaceId || null,
    });
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* uploadSvgAsset — SVG single-phase (sanitize → server upload → row)  */
/* ------------------------------------------------------------------ */

export interface UploadSvgInput {
  clientId: string;
  type: unknown;
  label?: unknown;
  /** The RAW SVG file contents (passes through the server sanitizer). */
  svg: unknown;
  variants?: unknown;
  replaceAssetId?: unknown;
}

export async function uploadSvgAsset(input: UploadSvgInput): Promise<UploadSvgResult> {
  const auth = await operatorClaims();
  if (!auth.ok) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const svgText = typeof input?.svg === "string" ? input.svg : "";
  // Size cap on the action body BEFORE sanitizing (bytes, not chars).
  const byteLength = Buffer.byteLength(svgText, "utf8");
  if (byteLength === 0) return { ok: false, reason: "invalid_input", error: INVALID_INPUT_ERROR };
  if (byteLength > BRAND_ASSET_MAX_BYTES) {
    return { ok: false, reason: "too_large", error: TOO_LARGE_ERROR };
  }

  // Metadata: force contentType to SVG (the caller doesn't choose it here).
  const meta = validateAssetMetadata({
    type: input?.type,
    label: input?.label,
    variants: input?.variants,
    contentType: "image/svg+xml",
    sizeBytes: byteLength,
  });
  if (!meta.ok) return { ok: false, reason: "invalid_input", error: meta.error };

  // SANITIZE — the security gate. Unsafe/unsanitizable SVG is REFUSED (never
  // served). We upload ONLY the sanitized bytes.
  const clean = sanitizeSvg(svgText);
  if (!clean.ok) return { ok: false, reason: "unsafe_svg", error: UNSAFE_SVG_ERROR };
  const bytes = new TextEncoder().encode(clean.svg);
  if (bytes.byteLength > BRAND_ASSET_MAX_BYTES) {
    return { ok: false, reason: "too_large", error: TOO_LARGE_ERROR };
  }

  const replaceId = typeof input?.replaceAssetId === "string" ? input.replaceAssetId.trim() : "";
  if (input?.replaceAssetId !== undefined && !isUuidV4(replaceId)) {
    return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  try {
    const scoped = await scopedClientId(supabase, clientId);
    if (!scoped.ok) {
      return scoped.reason === "not_found"
        ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
        : { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }

    const storagePath = buildStoragePath(auth.tenantId, scoped.id, "image/svg+xml");
    const { error } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "image/svg+xml",
      upsert: false,
    });
    if (error) {
      logAssetFailure("thrown", error);
      return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }

    const result = await persistFinalized(supabase, {
      tenantId: auth.tenantId,
      clientId: scoped.id,
      meta: meta.value,
      storagePath,
      contentType: "image/svg+xml",
      sizeBytes: bytes.byteLength,
      replaceAssetId: replaceId || null,
    });
    // If the row write failed, don't leave a stranded object.
    if (!result.ok) await removeObject(supabase, storagePath);
    return result;
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* persistFinalized — shared insert-or-replace tail                    */
/* ------------------------------------------------------------------ */

async function persistFinalized(
  supabase: Supabase,
  args: {
    tenantId: string;
    clientId: string;
    meta: ValidAssetMetadata;
    storagePath: string;
    contentType: BrandAssetMime;
    sizeBytes: number;
    replaceAssetId: string | null;
  }
): Promise<FinalizeUploadResult> {
  if (args.replaceAssetId) {
    // REPLACE: read the target (RLS-scoped), repoint it at the new object, then
    // clean up the OLD object ONLY if no locked kit references it (never dangle).
    const existing = await readAsset(supabase, args.replaceAssetId);
    if (!existing.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (!existing.asset) {
      await removeObject(supabase, args.storagePath); // orphan the just-uploaded object
      return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };
    }
    const oldPath = existing.asset.storagePath;

    const repoint = await repointAsset(supabase, args.replaceAssetId, {
      storagePath: args.storagePath,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      label: args.meta.label,
      variants: args.meta.variants,
    });
    if (!repoint.ok || repoint.touched === 0) {
      await removeObject(supabase, args.storagePath);
      return repoint.ok
        ? { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR }
        : { ok: false, reason: repoint.conflict ? "already_exists" : "write_failed", error: WRITE_FAILED_ERROR };
    }

    // Old object cleanup — fail SAFE: keep it unless we can PROVE it unreferenced.
    if (oldPath !== args.storagePath) {
      const ref = await isAssetReferencedByLockedKit(supabase, {
        clientId: args.clientId,
        assetId: args.replaceAssetId,
        storagePath: oldPath,
      });
      if (ref.ok && !ref.referenced) await removeObject(supabase, oldPath);
    }

    const updated = await readAsset(supabase, args.replaceAssetId);
    if (!updated.ok || !updated.asset) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    return { ok: true, asset: updated.asset };
  }

  // INSERT a new library row.
  const inserted = await insertAsset(supabase, {
    tenantId: args.tenantId,
    clientId: args.clientId,
    type: args.meta.type,
    label: args.meta.label,
    variants: args.meta.variants,
    storagePath: args.storagePath,
    contentType: args.contentType,
    sizeBytes: args.sizeBytes,
  });
  if (!inserted.ok) {
    await removeObject(supabase, args.storagePath);
    return inserted.conflict
      ? { ok: false, reason: "already_exists", error: WRITE_FAILED_ERROR }
      : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  const created = await readAsset(supabase, inserted.assetId);
  if (!created.ok || !created.asset) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  return { ok: true, asset: created.asset };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** The client's live library. `requireAuth` + RLS (`app.client_scope`) — a
 *  client_viewer sees only its OWN client's assets (its "home of assets"). */
export async function listBrandAssets(input: { clientId: string }): Promise<ListAssetsResult> {
  await requireAuth();
  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await listAssets(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, assets: res.assets };
}

/**
 * Issue a short-lived signed READ URL for one asset — the ONLY way to reach the
 * bytes (bucket is private). AUTHORIZATION FIRST: the asset row is read under
 * RLS; a cross-tenant / sibling-client / nonexistent id yields no row ⇒
 * not_found, and NO url is minted. So a guessed/enumerated path can never be
 * signed by this action.
 */
export async function getAssetSignedUrl(input: {
  assetId: string;
  expiresIn?: number;
}): Promise<SignedUrlResult> {
  await requireAuth();
  const assetId = typeof input?.assetId === "string" ? input.assetId.trim() : "";
  if (!isUuidV4(assetId)) return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };

  const ttl = Math.min(
    SIGNED_URL_TTL_MAX,
    Math.max(30, typeof input?.expiresIn === "number" && Number.isFinite(input.expiresIn) ? input.expiresIn : SIGNED_URL_TTL_SECONDS)
  );

  const supabase = await createClient();
  const res = await readAsset(supabase, assetId);
  if (!res.ok) return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
  if (!res.asset) return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };

  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(res.asset.storagePath, ttl);
    if (error || !data) {
      logAssetFailure("thrown", error);
      return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
    }
    return { ok: true, url: data.signedUrl, expiresInSeconds: ttl };
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false, reason: "storage_failed", error: STORAGE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* removeAsset — archive-if-referenced, else hard delete               */
/* ------------------------------------------------------------------ */

export async function removeAsset(input: { assetId: string }): Promise<RemoveAssetResult> {
  const auth = await operatorClaims();
  if (!auth.ok) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };

  const assetId = typeof input?.assetId === "string" ? input.assetId.trim() : "";
  if (!isUuidV4(assetId)) return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };

  const supabase = await createClient();
  try {
    const existing = await readAsset(supabase, assetId);
    if (!existing.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (!existing.asset) return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };

    // Fail SAFE: only hard-delete when PROVEN unreferenced by any locked kit.
    const ref = await isAssetReferencedByLockedKit(supabase, {
      clientId: existing.asset.clientId,
      assetId,
      storagePath: existing.asset.storagePath,
    });
    if (!ref.ok || ref.referenced) {
      const archived = await archiveAsset(supabase, assetId);
      if (!archived.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
      return { ok: true, outcome: "archived" };
    }

    const deleted = await deleteAssetRow(supabase, assetId);
    if (!deleted.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (deleted.touched === 0) return { ok: false, reason: "not_found", error: ASSET_NOT_FOUND_ERROR };
    // Row gone → remove the object (best-effort; a failure here is a harmless
    // orphan object, swept later — never a dangling row).
    await removeObject(supabase, existing.asset.storagePath);
    return { ok: true, outcome: "removed" };
  } catch (err) {
    logAssetFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}
