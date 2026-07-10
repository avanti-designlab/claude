/**
 * Runtime clamp + shared constants for the brand ASSET LIBRARY write seam
 * (migration 0014). Same posture as src/lib/clients/validate.ts: a server action
 * is a public RPC endpoint, so every field is shape-checked, trimmed, and
 * bounded HERE before it reaches Postgres or Storage; refusals speak interface
 * voice (doc 06 6: what happened + what to do, never a raw vendor string). RLS
 * + the 0014 CHECKs remain the enforcement floor -- this only keeps junk out.
 *
 * Pure + zero-dependency (unit-tested in the default `npm test` run). The
 * caps/enums below MIRROR the migration 0014 CHECK constraints one-for-one; the
 * action, the DB, and (for MIME/size) the Storage bucket policy all enforce
 * them, so a bypass at any single layer is still caught by the next.
 */

import { isUuidV4 } from "@/lib/clients/validate";
import {
  BRAND_ASSET_MIME_TYPES,
  BRAND_ASSET_TYPES,
  type BrandAssetMime,
  type BrandAssetType,
  type Json,
} from "@/lib/types/db";

export {
  BRAND_ASSET_MIME_TYPES,
  BRAND_ASSET_TYPES,
  type BrandAssetMime,
  type BrandAssetType,
};

/* ------------------------------------------------------------------ */
/* Caps + enums (single source of truth; DB CHECKs mirror these)       */
/* ------------------------------------------------------------------ */

/** The one MIME that MUST pass through the server SVG sanitizer, not a direct PUT. */
export const SVG_MIME: BrandAssetMime = "image/svg+xml";

/** Content-type -> canonical file extension (used to build storage paths). */
const MIME_EXTENSION: Record<BrandAssetMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** Size cap = 10 MiB. The ratified default -- mirrors `brand_assets_size_capped`
 *  (0014) AND the bucket file_size_limit. On the ratify set. */
export const BRAND_ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10485760

export const BRAND_ASSET_LABEL_MAX_CHARS = 120;
export const BRAND_ASSET_VARIANTS_MAX_JSON_CHARS = 4096;
const VARIANTS_MAX_DEPTH = 6;

export function isBrandAssetType(value: unknown): value is BrandAssetType {
  return typeof value === "string" && (BRAND_ASSET_TYPES as readonly string[]).includes(value);
}

export function isBrandAssetMime(value: unknown): value is BrandAssetMime {
  return typeof value === "string" && (BRAND_ASSET_MIME_TYPES as readonly string[]).includes(value);
}

export function isSvgMime(value: unknown): boolean {
  return value === SVG_MIME;
}

export function extensionForMime(mime: BrandAssetMime): string {
  return MIME_EXTENSION[mime];
}

/**
 * Magic-byte sniff for the RASTER finalize path — bytes are TRUTH, never the
 * client's declared Content-Type (which Supabase copies onto the object as-is,
 * unsniffed). Returns the detected allowlisted raster MIME, or null for anything
 * that is NOT an allowlisted raster image — SVG/XML/HTML/`<`-leading content, or
 * an unknown signature. The finalize action PURGES + REFUSES on null, so a
 * hostile SVG/HTML uploaded on the raster path with `Content-Type: image/png`
 * never gets a finalized row. Signatures:
 *   PNG  89 50 4E 47 · JPEG FF D8 FF · GIF 47 49 46 38 · WEBP "RIFF"…"WEBP"
 * SVG is deliberately absent here — SVG only ever enters via the sanitizing
 * `uploadSvgAsset` flow, whose bytes we write ourselves.
 */
export function sniffRasterMagic(bytes: Uint8Array): BrandAssetMime | null {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }
  return null; // SVG/XML/HTML/`<`-leading, or no allowlisted raster signature
}

/* ------------------------------------------------------------------ */
/* Interface-voice refusals                                            */
/* ------------------------------------------------------------------ */

export const ASSET_INVALID_TYPE_ERROR =
  "Pick an asset type (logo, favicon, icon, imagery, ...) before uploading.";
export const ASSET_INVALID_MIME_ERROR =
  "That file type isn't supported. Upload a PNG, JPG, WebP, GIF, or SVG.";
export const ASSET_TOO_LARGE_ERROR =
  "That file is over the 10 MB limit. Export a smaller version and try again.";
export const ASSET_EMPTY_ERROR =
  "That file looked empty. Choose a real image file and try again.";
export const ASSET_LABEL_TOO_LONG_ERROR = `Asset labels are capped at ${BRAND_ASSET_LABEL_MAX_CHARS} characters -- shorten it and try again.`;
export const ASSET_VARIANTS_INVALID_ERROR =
  "We couldn't read this asset's details. Remove them and try again.";

/* ------------------------------------------------------------------ */
/* Metadata validation                                                 */
/* ------------------------------------------------------------------ */

export interface ValidAssetMetadata {
  type: BrandAssetType;
  label: string | null;
  contentType: BrandAssetMime;
  sizeBytes: number;
  variants: Record<string, Json>;
}

export type AssetMetadataValidation =
  | { ok: true; value: ValidAssetMetadata }
  | { ok: false; error: string };

/**
 * Validate the caller-declared asset metadata. `sizeBytes` here is the DECLARED
 * size for pre-flight (the signed-URL request); the action ALSO re-checks the
 * REAL object size from storage on finalize, so a lie about size is caught even
 * if this passes. Raster vs SVG routing is decided by the action off
 * `contentType`.
 */
export function validateAssetMetadata(input: unknown): AssetMetadataValidation {
  const raw = (input ?? {}) as Record<string, unknown>;

  if (!isBrandAssetType(raw.type)) return { ok: false, error: ASSET_INVALID_TYPE_ERROR };
  if (!isBrandAssetMime(raw.contentType)) return { ok: false, error: ASSET_INVALID_MIME_ERROR };

  const size = typeof raw.sizeBytes === "number" ? raw.sizeBytes : NaN;
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0) {
    return { ok: false, error: ASSET_EMPTY_ERROR };
  }
  if (size > BRAND_ASSET_MAX_BYTES) return { ok: false, error: ASSET_TOO_LARGE_ERROR };

  const label = validateLabel(raw.label);
  if (!label.ok) return { ok: false, error: label.error };

  const variants = validateVariants(raw.variants);
  if (!variants.ok) return { ok: false, error: variants.error };

  return {
    ok: true,
    value: {
      type: raw.type,
      label: label.value,
      contentType: raw.contentType,
      sizeBytes: size,
      variants: variants.value,
    },
  };
}

function validateLabel(
  value: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: ASSET_VARIANTS_INVALID_ERROR };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > BRAND_ASSET_LABEL_MAX_CHARS) {
    return { ok: false, error: ASSET_LABEL_TOO_LONG_ERROR };
  }
  return { ok: true, value: trimmed };
}

/** `variants` must be a plain JSON object, prototype-pollution-stripped, within
 *  the serialized-size + depth bounds. Absent => {}. */
function validateVariants(
  value: unknown
): { ok: true; value: Record<string, Json> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: ASSET_VARIANTS_INVALID_ERROR };
  }
  if (!isJsonValue(value, VARIANTS_MAX_DEPTH)) {
    return { ok: false, error: ASSET_VARIANTS_INVALID_ERROR };
  }
  const stripped = stripUnsafeKeys(value as Json);
  if (typeof stripped !== "object" || stripped === null || Array.isArray(stripped)) {
    return { ok: false, error: ASSET_VARIANTS_INVALID_ERROR };
  }
  if (JSON.stringify(stripped).length > BRAND_ASSET_VARIANTS_MAX_JSON_CHARS) {
    return { ok: false, error: ASSET_VARIANTS_INVALID_ERROR };
  }
  return { ok: true, value: stripped as Record<string, Json> };
}

/* ------------------------------------------------------------------ */
/* Storage path helpers (mirror `brand_assets_path_scoped`, 0014)      */
/* ------------------------------------------------------------------ */

/**
 * Build the object path for a NEW asset: "<tenantId>/<clientId>/<uuid>.<ext>".
 * Both ids MUST be trusted (claim-sourced tenantId, RLS-confirmed clientId).
 * `newId` is injectable for deterministic tests; defaults to a fresh UUID.
 */
export function buildStoragePath(
  tenantId: string,
  clientId: string,
  contentType: BrandAssetMime,
  newId: string = globalThis.crypto.randomUUID()
): string {
  return `${tenantId}/${clientId}/${newId}.${extensionForMime(contentType)}`;
}

/**
 * True iff `path` is exactly scoped to this tenant+client -- the app-layer mirror
 * of the DB `brand_assets_path_scoped` CHECK and the storage RLS segment check.
 * Used to reject a finalize whose returned path was tampered to point elsewhere.
 * Rejects traversal ("..") and absolute paths defensively.
 */
export function isTenantClientScopedPath(
  path: unknown,
  tenantId: string,
  clientId: string
): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return false;
  if (!isUuidV4(tenantId) || !isUuidV4(clientId)) return false;
  const prefix = `${tenantId}/${clientId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return false;
  // No further path traversal or nested folders beyond the single object name.
  if (rest.includes("/") || rest.includes("..") || rest.includes("\\")) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* JSON safety (local copies -- clients/validate keeps its private)     */
/* ------------------------------------------------------------------ */

function isJsonValue(value: unknown, depth: number): value is Json {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value as number);
  if (depth <= 0) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth - 1));
  if (kind === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) =>
      isJsonValue(item, depth - 1)
    );
  }
  return false;
}

function stripUnsafeKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripUnsafeKeys);
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor") continue;
      out[key] = stripUnsafeKeys(value[key]);
    }
    return out;
  }
  return value;
}
