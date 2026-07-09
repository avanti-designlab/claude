/**
 * M7 Brand Kit engine — public API (docs 05 M7, 07 §1.5).
 *
 * The FIRST module under `src/lib/production/` — the brand-consistent
 * production pipeline's foundation. Everything downstream (M8 content voice,
 * M11 creative, schema-generation's logo, the white-label theming engine) reads
 * a client's LOCKED kit from here so all assets ship looking like the same
 * brand. Wraps the FROZEN `brand-kit-design-token` skill (never reimplements or
 * weakens it — including its B1 CSS-injection font-grammar defense).
 *
 * Server actions (`createBrandKit`, `reviseBrandKit`, `readLockedBrandKit`,
 * `listBrandKitVersionHistory`) live in ./actions — imported directly by the
 * app layer + downstream modules, deliberately NOT re-exported here so this
 * pure surface stays importable from client-adjacent code without dragging in
 * a "use server" module (same convention as the M2 audit index).
 */

// Ingestion (the pure skill wrapper) + the honesty report.
export {
  ingestBrandKit,
  revisionReport,
  type IngestBrandKitResult,
  type IngestionNote,
  type IngestionReport,
} from "./ingest";

// Row mapping + read shapes (the locked-kit + version-history contracts).
export {
  brandKitFromRow,
  brandKitInsertRow,
  brandKitVersionEntry,
  BRAND_KIT_PROVENANCE_GAP,
  type BrandKitAssets,
  type BrandKitInsertRow,
  type BrandKitVersionEntry,
  type LockedBrandKit,
} from "./rows";

// Input clamp caps (tests + callers reference these).
export {
  sanitizeLogoUrl,
  validateBrandKitInput,
  validateBrandKitRevision,
  type BrandKitInputValidation,
  type BrandKitRevisionValidation,
} from "./validate";
