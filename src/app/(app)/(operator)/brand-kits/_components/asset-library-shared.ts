/**
 * Pure, client-safe helpers for the per-client Brand Asset Library UI.
 *
 * NO "use client", NO server imports — importable by both the client island and
 * the default `npm test` run (unit-tested in asset-library-shared.test.ts). The
 * enums/caps/messages come from the LANDED validator (src/lib/brand-assets/
 * validate.ts, re-exported by the client-safe barrel) — this module never forks
 * a message or a bound; it mirrors the server's grammar so a client-side
 * pre-check and the server's real gate speak with one voice (the server stays
 * the enforcement floor — this only keeps an obviously-wrong file out of a
 * doomed round-trip).
 */

import {
  BRAND_ASSET_MAX_BYTES,
  BRAND_ASSET_MIME_TYPES,
  SVG_MIME,
  ASSET_EMPTY_ERROR,
  ASSET_INVALID_MIME_ERROR,
  ASSET_TOO_LARGE_ERROR,
  type BrandAssetMime,
  type BrandAssetType,
} from "@/lib/brand-assets/validate";

/* ------------------------------------------------------------------ */
/* Friendly labels for the closed type taxonomy (doc: BRAND_ASSET_TYPES) */
/* ------------------------------------------------------------------ */

/** Interface-voice name for each stored `type` — no internal codes rendered. */
export const ASSET_TYPE_LABEL: Record<BrandAssetType, string> = {
  primary_logo: "Primary logo",
  secondary_logo: "Secondary logo",
  mono_logo: "Monochrome logo",
  reversed_logo: "Reversed logo",
  favicon: "Favicon",
  icon: "Icon",
  imagery: "Imagery",
  other: "Other",
};

/** A one-line hint of what each type is for, shown in the type picker. */
export const ASSET_TYPE_HINT: Record<BrandAssetType, string> = {
  primary_logo: "The main, full-colour logo",
  secondary_logo: "An alternate or stacked lockup",
  mono_logo: "Single-colour (black or brand) version",
  reversed_logo: "Light version for dark backgrounds",
  favicon: "The small square browser/tab mark",
  icon: "An iconography mark or glyph",
  imagery: "A photo or brand image",
  other: "Anything that doesn't fit above",
};

/* ------------------------------------------------------------------ */
/* Grouping — the library's home-of-assets structure                    */
/* ------------------------------------------------------------------ */

export interface AssetGroupDef {
  /** Stable group id (also used as a React key + icon selector in the island). */
  id: "logos" | "favicon" | "icons" | "imagery" | "other";
  /** Section title. */
  title: string;
  /** Which stored types belong to this group, in display order. */
  types: readonly BrandAssetType[];
  /** Honest per-group empty title (the island appends "— upload one" for staff). */
  emptyTitle: string;
}

/** The library's sections, in display order. Logos leads (four sub-types). */
export const ASSET_GROUPS: readonly AssetGroupDef[] = [
  {
    id: "logos",
    title: "Logos",
    types: ["primary_logo", "secondary_logo", "mono_logo", "reversed_logo"],
    emptyTitle: "No logos yet",
  },
  { id: "favicon", title: "Favicon", types: ["favicon"], emptyTitle: "No favicon yet" },
  { id: "icons", title: "Icons", types: ["icon"], emptyTitle: "No icons yet" },
  { id: "imagery", title: "Imagery", types: ["imagery"], emptyTitle: "No imagery yet" },
  { id: "other", title: "Other", types: ["other"], emptyTitle: "Nothing else yet" },
] as const;

/** The four logo sub-types (used for the type-picker grouping too). */
export const LOGO_TYPES: readonly BrandAssetType[] = ASSET_GROUPS[0].types;

/** Minimal shape the grouping needs — a structural subset of BrandAsset. */
interface TypedAsset {
  type: BrandAssetType;
}

/**
 * Partition assets into the display groups (order preserved from `assets`, which
 * the server already returns newest-first). An asset whose `type` isn't in any
 * group's list falls into "other", so an unexpected/legacy value is never
 * silently dropped from the library.
 */
export function groupAssets<T extends TypedAsset>(
  assets: readonly T[],
): Array<{ group: AssetGroupDef; assets: T[] }> {
  const byGroup = new Map<AssetGroupDef["id"], T[]>();
  for (const g of ASSET_GROUPS) byGroup.set(g.id, []);

  const typeToGroup = new Map<BrandAssetType, AssetGroupDef["id"]>();
  for (const g of ASSET_GROUPS) for (const t of g.types) typeToGroup.set(t, g.id);

  for (const asset of assets) {
    const gid = typeToGroup.get(asset.type) ?? "other";
    byGroup.get(gid)!.push(asset);
  }
  return ASSET_GROUPS.map((group) => ({ group, assets: byGroup.get(group.id)! }));
}

/* ------------------------------------------------------------------ */
/* File-kind routing + pre-check (mirrors the action floors)            */
/* ------------------------------------------------------------------ */

/** The raster MIME types — the allowlist minus SVG (which is server-mediated). */
export const RASTER_MIMES: readonly string[] = BRAND_ASSET_MIME_TYPES.filter(
  (m) => m !== SVG_MIME,
);

/** `accept` attribute for the file input (a UX hint; the server is the gate). */
export const ASSET_ACCEPT_ATTR = BRAND_ASSET_MIME_TYPES.join(",");

export type AssetFileKind = "svg" | "raster" | "unsupported";

/** The minimal File shape the pure helpers read (so tests need no real File). */
export interface FileFacts {
  name: string;
  type: string;
  size: number;
}

const RASTER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Extension → raster MIME, for browsers that report an empty `type`. */
const EXTENSION_MIME: Record<string, BrandAssetMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Resolve the concrete raster MIME to declare for a file: its declared type when
 * that's an allowlisted raster MIME, else mapped from the extension. null when
 * neither yields an allowlisted raster MIME. The server re-sniffs the real bytes
 * regardless and stores the SNIFFED type — this only picks a valid value to
 * declare for the signed-URL request + finalize validation.
 */
export function resolveRasterMime(file: FileFacts): BrandAssetMime | null {
  if (RASTER_MIMES.includes(file.type)) return file.type as BrandAssetMime;
  return EXTENSION_MIME[extensionOf(file.name)] ?? null;
}

/**
 * Route a file to its upload flow by its declared MIME (falling back to the
 * extension when the browser reports an empty type, common for `.svg`). SVG
 * ALWAYS routes to the sanitizing server path — NEVER the signed PUT. The server
 * re-verifies regardless (magic-byte sniff for raster; sanitizer for SVG), so a
 * lie here only wastes the caller's own round-trip.
 */
export function detectAssetKind(file: FileFacts): AssetFileKind {
  const ext = extensionOf(file.name);
  if (file.type === SVG_MIME || ext === "svg") return "svg";
  if (RASTER_MIMES.includes(file.type) || RASTER_EXTENSIONS.has(ext)) return "raster";
  return "unsupported";
}

export type FilePrecheck =
  | { ok: true; kind: "svg" }
  | { ok: true; kind: "raster"; contentType: BrandAssetMime }
  | { ok: false; error: string };

/**
 * Client-side pre-flight, in the SAME order the server validator checks so the
 * message matches: unsupported MIME → empty → too large. Returns the routed kind
 * (and, for raster, the resolved MIME to declare). Every message is imported
 * from the landed validator (never hardcoded here), so it stays byte-identical
 * to what the server would return; the server remains the real gate.
 */
export function precheckFile(file: FileFacts): FilePrecheck {
  const kind = detectAssetKind(file);
  if (kind === "unsupported") return { ok: false, error: ASSET_INVALID_MIME_ERROR };
  if (!(file.size > 0)) return { ok: false, error: ASSET_EMPTY_ERROR };
  if (file.size > BRAND_ASSET_MAX_BYTES) return { ok: false, error: ASSET_TOO_LARGE_ERROR };
  if (kind === "svg") return { ok: true, kind: "svg" };
  const contentType = resolveRasterMime(file);
  if (!contentType) return { ok: false, error: ASSET_INVALID_MIME_ERROR };
  return { ok: true, kind: "raster", contentType };
}

/* ------------------------------------------------------------------ */
/* Display formatting                                                   */
/* ------------------------------------------------------------------ */

/** Human-readable byte size (binary units), e.g. 10485760 → "10 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Short, interface-voice name of a stored MIME for the meta line. */
export function mimeShortLabel(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPG";
    case "image/webp":
      return "WebP";
    case "image/gif":
      return "GIF";
    case "image/svg+xml":
      return "SVG";
    default:
      return "Image";
  }
}
