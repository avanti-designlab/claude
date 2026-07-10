/**
 * Brand ASSET LIBRARY (migration 0014) — barrel.
 *
 * CLIENT-SAFE surface only: the pure sanitizer/validator/row types + result
 * contracts. The SERVER actions are "use server" and must be imported directly
 * in server code:
 *   import { requestAssetUpload, finalizeAssetUpload, uploadSvgAsset,
 *            listBrandAssets, getAssetSignedUrl, removeAsset }
 *     from "@/lib/brand-assets/actions";
 */

export {
  sanitizeSvg,
  sanitizeSvgOrThrow,
  SvgUnsafeError,
  SVG_SANITIZE_MAX_CHARS,
  type SvgRefusalReason,
  type SvgSanitizeResult,
} from "./svg-sanitize";

export {
  BRAND_ASSET_TYPES,
  BRAND_ASSET_MIME_TYPES,
  BRAND_ASSET_MAX_BYTES,
  BRAND_ASSET_LABEL_MAX_CHARS,
  BRAND_ASSET_VARIANTS_MAX_JSON_CHARS,
  SVG_MIME,
  isBrandAssetType,
  isBrandAssetMime,
  isSvgMime,
  extensionForMime,
  buildStoragePath,
  isTenantClientScopedPath,
  validateAssetMetadata,
  type BrandAssetType,
  type BrandAssetMime,
  type ValidAssetMetadata,
  type AssetMetadataValidation,
} from "./validate";

export { brandAssetFromRow, brandAssetInsertRow, type BrandAsset } from "./rows";

// NOTE: references.ts is "server-only" and is intentionally NOT re-exported here
// (this barrel is client-safe). Server code imports it directly:
//   import { isAssetReferencedByLockedKit, ASSET_REF_CONTRACT }
//     from "@/lib/brand-assets/references";

export type {
  RequestUploadResult,
  FinalizeUploadResult,
  UploadSvgResult,
  ListAssetsResult,
  SignedUrlResult,
  RemoveAssetResult,
} from "./actions";
