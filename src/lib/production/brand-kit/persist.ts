import "server-only";

/**
 * Brand-kit persistence + reads (M7; FROZEN schema:
 * supabase/migrations/0003_clients_properties_brand_kits.sql).
 *
 * Deliberately NOT a "use server" module (house rule — same rationale as
 * src/lib/plans/persist.ts and src/lib/intelligence/audit/persist.ts): exporting
 * helpers from an action file would mint each one as a browser-invokable RPC
 * endpoint. This stays a plain server-side module that only the audited actions
 * import. Every caller passes a claim-scoped Supabase client and a CLAIM-SOURCED
 * tenantId (never anything the browser sent); RLS (`brand_kits_insert` /
 * `brand_kits_select`, migration 0003) re-pins tenant scope below us regardless,
 * and the composite FK (tenant, client) → clients makes a cross-tenant client
 * reference structurally impossible.
 *
 * IMMUTABLE VERSIONS (immutable-audit pattern). Every persisted row is a LOCKED
 * capture; a change is a NEW version row (`brand_kits_client_version_key unique
 * (tenant_id, client_id, version)`); NOTHING is updated in place. So the write
 * surface here is INSERT-ONLY — no update, no in-place lock flip — and the read
 * surface is newest-version-wins. A failed insert is a HARD failure (the kit was
 * not saved), never a soft "warning" the way an audit-history write is: the
 * caller retries.
 */

import type { createClient } from "@/lib/supabase/server";
import type { IngestionReport } from "./ingest";
import {
  brandKitFromRow,
  brandKitInsertRow,
  brandKitVersionEntry,
  type BrandKitVersionEntry,
  type LockedBrandKit,
} from "./rows";
import type { BrandKit } from "@/lib/types/brand";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Version history is bounded newest-first (the operator needs recency, not the whole archive; PostgREST caps rows server-side anyway). */
export const BRAND_KIT_VERSION_HISTORY_MAX = 100;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — plans/persist.ts)      */
/* ------------------------------------------------------------------ */

/**
 * Every brand-kit write-failure path emits exactly ONE server-side
 * console.error carrying ONLY: the stable marker below, which stage failed, and
 * the Postgres/PostgREST error CODE (shape-checked — never free text). NO
 * payloads, NO brand data, NO tenant/client ids, NO error messages: a PostgREST
 * `message`/`details` can quote row data verbatim, and the secrets-in-logs rule
 * (docs/ops/environments.md §Secrets rules) is absolute.
 */
export const BRAND_KIT_FAILURE_MARKER = "[brand-kit-write-failure]";

export type BrandKitFailureStage = "brand_kit_insert" | "thrown";

export function logBrandKitFailure(stage: BrandKitFailureStage, cause: unknown): void {
  console.error(`${BRAND_KIT_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Extract a bare SQLSTATE/PostgREST code ("23505", "PGRST301"). Anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride
 * into the log line even through a hostile/misbehaving error object. (Local copy
 * — the plans/audit equivalents are module-private and out of bounds to import.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* persistLockedBrandKit — insert one immutable version row            */
/* ------------------------------------------------------------------ */

/**
 * The unique-violation branch: a version collision on
 * `brand_kits_client_version_key`. For a first kit (create) that means one
 * already exists; for a revision it means a concurrent revise already claimed
 * `version` — the caller maps each to its own outcome.
 */
export type PersistBrandKitResult =
  | { ok: true; brandKitId: string }
  | { ok: false; conflict: boolean };

/**
 * Insert ONE locked, immutable brand-kit version row. `kit` is the LOCKED kit
 * (from `lockKit`); `version` is set explicitly by the caller; RLS + the
 * composite FK re-pin scope below us. A `23505` is returned as `conflict: true`
 * so the caller can tell a version collision from any other write failure.
 */
export async function persistLockedBrandKit(
  supabase: Supabase,
  tenantId: string,
  clientId: string,
  args: { kit: BrandKit; version: number; logoUrl: string | null; report: IngestionReport }
): Promise<PersistBrandKitResult> {
  const row = brandKitInsertRow({
    tenantId,
    clientId,
    kit: args.kit,
    version: args.version,
    logoUrl: args.logoUrl,
    report: args.report,
  });
  const { data, error } = await supabase
    .from("brand_kits")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    logBrandKitFailure("brand_kit_insert", error);
    return { ok: false, conflict: (error as { code?: unknown } | null)?.code === "23505" };
  }
  return { ok: true, brandKitId: data.id as string };
}

/* ------------------------------------------------------------------ */
/* Reads (newest-version-wins)                                         */
/* ------------------------------------------------------------------ */

/**
 * The highest version number on record for a client, or null when the client
 * has no kit yet. Drives version numbering: create refuses when non-null; a
 * revision reads the current kit for its version. RLS scopes the read to the
 * caller's tenant AND `app.client_scope`.
 */
export async function readBrandKitMaxVersion(
  supabase: Supabase,
  clientId: string
): Promise<{ ok: true; maxVersion: number | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_kits")
    .select("version")
    .eq("client_id", clientId)
    .order("version", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<{ version: unknown }>;
  const top = rows[0]?.version;
  return { ok: true, maxVersion: typeof top === "number" && Number.isFinite(top) ? top : null };
}

/**
 * The CURRENT locked kit for a client — the one M8/M11/theming enforce against:
 * the highest-version LOCKED row. Null when the client has no locked kit yet.
 * RLS is the isolation boundary; ordering is applied server-side and the newest
 * locked row is taken in JS (no `.limit` dependency, matching readAuditHistory).
 */
export async function readCurrentLockedBrandKit(
  supabase: Supabase,
  clientId: string
): Promise<{ ok: true; kit: LockedBrandKit | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_kits")
    .select("id, client_id, version, locked, tokens, voice_profile, likeness_refs, assets, created_at")
    .eq("client_id", clientId)
    .order("version", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<Record<string, unknown>>;
  for (const raw of rows) {
    if (raw.locked !== true) continue;
    const kit = brandKitFromRow(raw as Parameters<typeof brandKitFromRow>[0]);
    // A structurally corrupt row (null) is skipped — the next-newest good
    // locked version is a better answer than handing back a broken kit.
    if (kit) return { ok: true, kit };
  }
  return { ok: true, kit: null };
}

/**
 * Newest-first version history for a client (bounded). RLS scopes the read to
 * the caller's tenant + `app.client_scope`; the full token/voice payloads are
 * NOT selected here — a history list needs recency + provenance counts, not
 * every version's full kit.
 */
export async function listBrandKitVersions(
  supabase: Supabase,
  clientId: string
): Promise<{ ok: true; entries: BrandKitVersionEntry[] } | { ok: false }> {
  const { data, error } = await supabase
    .from("brand_kits")
    .select("id, version, locked, assets, created_at")
    .eq("client_id", clientId)
    .order("version", { ascending: false });
  if (error || !data) return { ok: false };
  const rows = data as Array<Parameters<typeof brandKitVersionEntry>[0]>;
  return { ok: true, entries: rows.slice(0, BRAND_KIT_VERSION_HISTORY_MAX).map(brandKitVersionEntry) };
}
