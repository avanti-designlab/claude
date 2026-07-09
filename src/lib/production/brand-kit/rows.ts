/**
 * Pure BrandKit ⇄ `brand_kits` row mapping (FROZEN schema:
 * supabase/migrations/0003_clients_properties_brand_kits.sql). Mirrors the
 * audit/plans split (src/lib/intelligence/audit/rows.ts): no server imports, no
 * Supabase client — unit-tested in the default `npm test` run; the write action
 * feeds these rows to PostgREST and shapes reads back through them.
 *
 * Column mapping (per 0003's comments):
 *  - `tokens`        — DesignTokenSet jsonb, the TS camelCase shape verbatim
 *    (e.g. `colors.surfaceRaised`). Stored exactly as the skill produced it.
 *  - `voice_profile` — {descriptors, samples, do, dont} verbatim.
 *  - `likeness_refs` — {higgsfieldElementIds, motionElementIds} verbatim.
 *  - `assets`        — {logo_url, ingestion}. The logo (0003 added `assets` at
 *    F1 for exactly the logo, feeding schema-generation's
 *    SchemaBrandContext.logoUrl) PLUS the ingestion provenance.
 *  - `locked`        — ALWAYS true. We persist only LOCKED, immutable version
 *    captures (see persist.ts); drafts are the ingest return value, never a
 *    row. Immutability is structural: insert-only, newest-version-wins, nothing
 *    updated in place — the immutable-audit pattern.
 *  - `version`       — set explicitly by the caller (1 for the first kit, N+1
 *    for a revision), NOT read from the in-memory kit; the DB unique
 *    `(tenant_id, client_id, version)` is the collision backstop.
 *
 * SCHEMA-GAP NOTE (M3 precedent): the frozen schema has no dedicated column for
 * ingestion provenance (contrast corrections + defaulted/missing inputs). Per
 * the task's "store in the available jsonb or flag the gap" guidance, it rides
 * in `assets.ingestion` — a legitimate use of the open `{logo_url, ...}` jsonb,
 * and it lets the version-history read surface per-version corrections. The
 * cleaner long-term home is a dedicated `brand_kits.provenance` jsonb column;
 * that is the post-freeze Orchestrator + Code Review path (CLAUDE.md rule 1),
 * flagged by `BRAND_KIT_PROVENANCE_GAP` below.
 *
 * Scoping ids (tenant_id / client_id) are pinned HERE from caller-supplied
 * values that are claim-/RLS-sourced upstream — and re-pinned below us by RLS
 * (`brand_kits_insert`, migration 0003) plus the composite FK (tenant, client)
 * → clients, so a row can never land outside the caller's tenant or reference
 * another tenant's client.
 */

import type {
  BrandKit,
  DesignTokenSet,
  LikenessRefs,
  VoiceProfile,
} from "@/lib/types/brand";
import type { IngestionReport } from "./ingest";

/** Stable flag for the schema-gap follow-up (greppable by the Orchestrator/docs agent). */
export const BRAND_KIT_PROVENANCE_GAP =
  "Ingestion provenance (contrast corrections + defaulted/missing inputs) has no dedicated " +
  "column in the frozen brand_kits schema (migration 0003); it rides in assets.ingestion. " +
  "Proposed addition: a brand_kits.provenance jsonb column — deferred to the post-freeze " +
  "Orchestrator + Code Review path.";

/** `brand_kits.assets` jsonb shape (0003: `{logo_url, ...}`). */
export interface BrandKitAssets {
  logo_url: string | null;
  /** Ingestion provenance for this version (see BRAND_KIT_PROVENANCE_GAP). */
  ingestion: IngestionReport;
}

/** Insert shape for `brand_kits` (migration 0003 — only the caller-set columns). */
export interface BrandKitInsertRow {
  tenant_id: string;
  client_id: string;
  tokens: DesignTokenSet;
  voice_profile: VoiceProfile;
  likeness_refs: LikenessRefs;
  assets: BrandKitAssets;
  locked: boolean;
  version: number;
}

/**
 * Build the `brand_kits` row for ONE locked, immutable version capture. `kit`
 * is the LOCKED (deep-frozen) kit from the skill's `lockKit`; `version` is set
 * explicitly by the caller (never trusted from `kit.version`).
 */
export function brandKitInsertRow(args: {
  tenantId: string;
  clientId: string;
  kit: BrandKit;
  version: number;
  logoUrl: string | null;
  report: IngestionReport;
}): BrandKitInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    tokens: args.kit.tokens,
    voice_profile: args.kit.voice_profile,
    likeness_refs: args.kit.likeness_refs,
    assets: { logo_url: args.logoUrl, ingestion: args.report },
    // Always true: only locked captures are persisted (see persist.ts header).
    locked: true,
    version: args.version,
  };
}

/* ------------------------------------------------------------------ */
/* Reads (defensive jsonb parsing)                                     */
/* ------------------------------------------------------------------ */

/**
 * The locked kit shape M8 (content voice), M11 (creative), schema-generation
 * (logo), and the white-label theming engine (tokens) enforce against. Nested
 * jsonb is trusted-by-construction (we wrote it through the validated skill),
 * so the parse is light — but a structurally corrupt `tokens` makes the whole
 * row unusable and is reported as such (null), never handed on as a broken kit.
 */
export interface LockedBrandKit {
  id: string;
  clientId: string;
  version: number;
  /** The design token set (colors/typography/spacing) — the enforced brand system. */
  tokens: DesignTokenSet;
  /** Read at GENERATION time by M8 (brand voice from the start). */
  voiceProfile: VoiceProfile;
  /** Higgsfield/Motion reference-element ids for on-likeness media (M11). */
  likenessRefs: LikenessRefs;
  /** Feeds schema-generation's SchemaBrandContext.logoUrl; null when none provided. */
  logoUrl: string | null;
  /** Provenance stored with this version (contrast corrections + defaults/missing). null if absent/corrupt. */
  provenance: IngestionReport | null;
  createdAt: string;
}

/** One version-history data point — the lean shape for a version list. */
export interface BrandKitVersionEntry {
  id: string;
  version: number;
  locked: boolean;
  createdAt: string;
  /** From assets.ingestion: how many contrast corrections this version carried. null if provenance absent. */
  contrastCorrectionCount: number | null;
  /** From assets.ingestion: how many inputs were defaulted or missing. null if provenance absent. */
  unspecifiedInputCount: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The empty voice profile — the honest fallback when the column is malformed (same as "no voice"). */
const EMPTY_VOICE: VoiceProfile = { descriptors: [], samples: [], do: [], dont: [] };
const EMPTY_LIKENESS: LikenessRefs = { higgsfieldElementIds: [], motionElementIds: [] };

/**
 * Shape a raw `brand_kits` row (RLS-scoped read) into a LockedBrandKit, or null
 * when `tokens` is structurally unusable (a corrupt kit must never be handed to
 * a consumer as if it were enforceable). Voice/likeness degrade to empty (the
 * "not provided" state) rather than nulling the whole kit, since content/media
 * generation already tolerate an empty voice/likeness.
 */
export function brandKitFromRow(row: {
  id: string;
  client_id: string;
  version: unknown;
  tokens: unknown;
  voice_profile: unknown;
  likeness_refs: unknown;
  assets: unknown;
  created_at: string;
}): LockedBrandKit | null {
  if (!isObject(row.tokens)) return null;
  const version = finiteNumber(row.version);
  if (version === null) return null;

  const assets = isObject(row.assets) ? row.assets : {};
  const logoUrl = typeof assets.logo_url === "string" ? assets.logo_url : null;
  const provenance = isObject(assets.ingestion) ? (assets.ingestion as unknown as IngestionReport) : null;

  return {
    id: row.id,
    clientId: row.client_id,
    version,
    tokens: row.tokens as unknown as DesignTokenSet,
    voiceProfile: isObject(row.voice_profile) ? (row.voice_profile as unknown as VoiceProfile) : EMPTY_VOICE,
    likenessRefs: isObject(row.likeness_refs) ? (row.likeness_refs as unknown as LikenessRefs) : EMPTY_LIKENESS,
    logoUrl,
    provenance,
    createdAt: row.created_at,
  };
}

/** Shape a raw `brand_kits` row into a lean version-history entry. */
export function brandKitVersionEntry(row: {
  id: string;
  version: unknown;
  locked: unknown;
  assets: unknown;
  created_at: string;
}): BrandKitVersionEntry {
  const assets = isObject(row.assets) ? row.assets : {};
  const ingestion = isObject(assets.ingestion) ? assets.ingestion : null;
  const corrections = ingestion && Array.isArray(ingestion.contrastCorrections)
    ? ingestion.contrastCorrections.length
    : null;
  const unspecified = ingestion && Array.isArray(ingestion.notes) ? ingestion.notes.length : null;
  return {
    id: row.id,
    version: finiteNumber(row.version) ?? 0,
    locked: row.locked === true,
    createdAt: row.created_at,
    contrastCorrectionCount: corrections,
    unspecifiedInputCount: unspecified,
  };
}
