"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import {
  lockKit,
  reviseKit,
  type BrandKit,
  type BrandKitInput,
  type BrandKitRevision,
} from "@/lib/skills/brand-kit";
import { createClient } from "@/lib/supabase/server";
import { ingestBrandKit, revisionReport, type IngestionReport } from "./ingest";
import {
  listBrandKitVersions,
  logBrandKitFailure,
  persistLockedBrandKit,
  readBrandKitMaxVersion,
  readCurrentLockedBrandKit,
} from "./persist";
import type { BrandKitVersionEntry, LockedBrandKit } from "./rows";
import { sanitizeLogoUrl, validateBrandKitInput, validateBrandKitRevision } from "./validate";

/**
 * M7 Brand Kit engine — server actions (doc 05 M7, doc 07 §1.5). The
 * production-pipeline foundation: M8 (content voice), M11 (creative), schema-
 * generation (logo), and white-label theming all enforce against what these
 * persist + read. Security posture mirrors the M2/plans module actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a clientId + brand inputs; the tenant comes from the caller's VERIFIED
 *    JWT claim, and RLS (`brand_kits_*`, migration 0003) re-pins every row below
 *    us regardless. The persisted client_id comes from an RLS-SCOPED read of
 *    `clients` (never trusted from the caller), and the composite FK (tenant,
 *    client) → clients makes a cross-tenant reference structurally impossible.
 *  - WRITE RIGHTS MIRROR RLS HONESTLY. `brand_kits_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator, migration 0003), so the guard
 *    is `requireOperator()` (both staff roles) — mirroring the M2 audit action:
 *    brand ingestion is production work the 30-person operator team is hired to
 *    run (doc 03 §2 role matrix). OPEN PRODUCT QUESTION (like plan
 *    regeneration's): tighten locking to agency_admin-only if the product later
 *    wants approval to be an admin-only act; RLS stays the enforcement floor.
 *  - THE KIT IS BUILT SERVER-SIDE from the caller's brand inputs through the
 *    FROZEN skill (`ingestBrandKit` → `buildBrandKit`). Nothing generative
 *    round-trips through the browser: a caller cannot inject a pre-built kit,
 *    forge corrected tokens, or bypass the B1 font-grammar / WCAG gates.
 *
 * IMMUTABLE VERSIONS. Persistence is insert-only: `createBrandKit` writes
 * version 1 (and refuses if a kit already exists); `reviseBrandKit` reads the
 * current locked kit, applies the skill's `reviseKit`, and inserts version N+1.
 * Nothing is ever updated in place — a change is always a new version, history
 * preserved (skill rule 3 / immutable-audit pattern).
 *
 * HARD HONESTY GATE. A kit whose contrast the skill could NOT resolve (a surface
 * too close to mid-luminance for any accessible foreground) is REFUSED at lock
 * time (`contrast_unresolvable`) — an unreadable brand must never be locked and
 * enforced downstream. The corrections the skill DID make, and every defaulted/
 * missing input, ride back in the result's `report` (surfaced, never hidden) and
 * are persisted per version in `brand_kits.assets.ingestion`.
 */

/* ------------------------------------------------------------------ */
/* Result contracts (FROZEN once consumed by the frontend — post-handoff
   changes require Orchestrator + Code Review sign-off, CLAUDE.md rule 1) */
/* ------------------------------------------------------------------ */

export type CreateBrandKitResult =
  | { ok: true; brandKitId: string; version: number; report: IngestionReport }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_brand_input"
        | "contrast_unresolvable"
        | "already_exists"
        | "write_failed";
      error: string;
    };

export type ReviseBrandKitResult =
  | { ok: true; brandKitId: string; version: number; report: IngestionReport }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "no_kit" | "invalid_brand_input" | "contrast_unresolvable" | "write_failed";
      error: string;
    };

export type ReadLockedBrandKitResult =
  | { ok: true; kit: LockedBrandKit | null }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

export type ListBrandKitVersionsResult =
  | { ok: true; entries: BrandKitVersionEntry[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor/skill string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to manage brand kits — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_BRAND_INPUT_ERROR =
  "We couldn’t build a brand kit from these details. Check that every color is a valid hex code and every font is a plain font name, then try again.";
const CONTRAST_UNRESOLVABLE_ERROR =
  "This brand’s surface color is too close to mid-gray for readable text, so we can’t lock an inaccessible kit. Pick a lighter or darker surface (or background) and try again.";
const ALREADY_EXISTS_ERROR =
  "This client already has a brand kit — revise it to make changes, which keeps the version history.";
const NO_KIT_ERROR = "This client has no brand kit yet — create one first.";
const WRITE_FAILED_ERROR = "We couldn’t save this brand kit. Check your connection and try again.";
const READ_FAILED_ERROR = "We couldn’t load this brand kit. Check your connection and try again.";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Reconstruct a skill `BrandKit` from a stored LockedBrandKit (for `reviseKit`). */
function toBrandKit(locked: LockedBrandKit): BrandKit {
  return {
    tokens: locked.tokens,
    voice_profile: locked.voiceProfile,
    likeness_refs: locked.likenessRefs,
    locked: true,
    version: locked.version,
  };
}

/**
 * RLS-scoped confirmation that the client exists + is visible to the caller,
 * returning the DB-sourced client id to pin on the kit row. A cross-tenant or
 * nonexistent id is INDISTINGUISHABLE (RLS yields zero rows for both) — correct
 * and intended (doc 03 §4), and it means the caller never supplies the pinned
 * client_id directly.
 */
async function scopedClientId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clientId: string
): Promise<{ ok: true; id: string } | { ok: false; reason: "not_found" | "read_failed" }> {
  const { data, error } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, id: data.id as string };
}

/* ------------------------------------------------------------------ */
/* createBrandKit — the client's first, locked kit (version 1)          */
/* ------------------------------------------------------------------ */

export interface CreateBrandKitInput extends BrandKitInput {
  clientId: string;
}

export async function createBrandKit(input: CreateBrandKitInput): Promise<CreateBrandKitResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role case
  // is trapped; everything else, including NEXT_REDIRECT, rethrows).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  // RUNTIME CLAMP: size-cap the free-text/jsonb inputs before the skill (the
  // format authority) sees them; refusals are interface-voice.
  const validated = validateBrandKitInput(input);
  if (!validated.ok) return { ok: false, reason: "invalid_brand_input", error: validated.error };

  const supabase = await createClient();
  try {
    const scoped = await scopedClientId(supabase, clientId);
    if (!scoped.ok) {
      return { ok: false, reason: scoped.reason === "not_found" ? "not_found" : "write_failed", error: scoped.reason === "not_found" ? CLIENT_NOT_FOUND_ERROR : WRITE_FAILED_ERROR };
    }

    // BUILD via the frozen skill. A hostile font/color (B1) or any malformed
    // input is rejected INSIDE buildBrandKit; ingest returns invalid_brand_input
    // and we return interface copy WITHOUT echoing the skill's raw message.
    const ingest = ingestBrandKit(validated.value);
    if (!ingest.ok) return { ok: false, reason: "invalid_brand_input", error: INVALID_BRAND_INPUT_ERROR };

    // HARD HONESTY GATE: never lock an unreadable brand.
    if (!ingest.report.contrastResolved) {
      return { ok: false, reason: "contrast_unresolvable", error: CONTRAST_UNRESOLVABLE_ERROR };
    }

    // First version only. A concurrent create collides on the version unique
    // constraint below and is reported as already_exists there.
    const max = await readBrandKitMaxVersion(supabase, scoped.id);
    if (!max.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (max.maxVersion !== null) return { ok: false, reason: "already_exists", error: ALREADY_EXISTS_ERROR };

    const locked = lockKit(ingest.kit);
    const persisted = await persistLockedBrandKit(supabase, claims.tenantId, scoped.id, {
      kit: locked,
      version: 1,
      logoUrl: ingest.logoUrl,
      report: ingest.report,
    });
    if (!persisted.ok) {
      return persisted.conflict
        ? { ok: false, reason: "already_exists", error: ALREADY_EXISTS_ERROR }
        : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    return { ok: true, brandKitId: persisted.brandKitId, version: 1, report: ingest.report };
  } catch (err) {
    // Anything unexpected (an interrupted connection, a thrown client): one
    // redacted telemetry line, honest retryable failure — never a 500.
    logBrandKitFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* reviseBrandKit — the next locked version (immutable; never in place) */
/* ------------------------------------------------------------------ */

export interface ReviseBrandKitInput {
  clientId: string;
  /** The skill's revision diff (colors/typography/spacing/voice/likeness). */
  changes: BrandKitRevision;
  /** Optional new logo (not a skill token — handled here). Omit to carry the current one forward; null clears it. */
  logoUrl?: string | null;
}

export async function reviseBrandKit(input: ReviseBrandKitInput): Promise<ReviseBrandKitResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const validated = validateBrandKitRevision(input?.changes);
  if (!validated.ok) return { ok: false, reason: "invalid_brand_input", error: validated.error };
  const logo = sanitizeLogoUrl(input?.logoUrl);
  if (!logo.ok) return { ok: false, reason: "invalid_brand_input", error: logo.error };

  const supabase = await createClient();
  try {
    const scoped = await scopedClientId(supabase, clientId);
    if (!scoped.ok) {
      return { ok: false, reason: scoped.reason === "not_found" ? "not_found" : "write_failed", error: scoped.reason === "not_found" ? CLIENT_NOT_FOUND_ERROR : WRITE_FAILED_ERROR };
    }

    const current = await readCurrentLockedBrandKit(supabase, scoped.id);
    if (!current.ok) return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    if (current.kit === null) return { ok: false, reason: "no_kit", error: NO_KIT_ERROR };

    // REVISE via the frozen skill: it deep-merges the changes onto the prior
    // version and re-runs the SAME resolve/validate pipeline (contrast + B1
    // font-grammar). A hostile change is rejected here — try/catch → invalid.
    let revised;
    try {
      revised = reviseKit(toBrandKit(current.kit), validated.changes);
    } catch {
      return { ok: false, reason: "invalid_brand_input", error: INVALID_BRAND_INPUT_ERROR };
    }
    const report = revisionReport(revised.accessibility);
    if (!report.contrastResolved) {
      return { ok: false, reason: "contrast_unresolvable", error: CONTRAST_UNRESOLVABLE_ERROR };
    }

    // Logo: carry the current one forward unless the caller supplied one.
    const logoUrl = logo.value === undefined ? current.kit.logoUrl : logo.value;

    const locked = lockKit(revised.kit);
    const persisted = await persistLockedBrandKit(supabase, claims.tenantId, scoped.id, {
      kit: locked,
      // Skill-managed: reviseKit set version = prior + 1. The unique
      // (tenant, client, version) constraint is the concurrent-revise backstop.
      version: revised.kit.version,
      logoUrl,
      report,
    });
    if (!persisted.ok) {
      // A version collision means a concurrent revise already claimed this
      // version — retryable (re-read the current kit and revise again).
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    return { ok: true, brandKitId: persisted.brandKitId, version: revised.kit.version, report };
  } catch (err) {
    logBrandKitFailure("thrown", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/* ------------------------------------------------------------------ */
/* Reads — what M8/M11/theming enforce against + version history        */
/* ------------------------------------------------------------------ */

/**
 * The current locked kit for a client — the enforced brand system. Guarded by
 * `requireAuth` ONLY, mirroring `brand_kits_select` (migration 0003) honestly:
 * reads are open to any tenant member, and `app.client_scope` already narrows a
 * client_viewer to its own client's kit (the white-label theming read). RLS is
 * the enforcement boundary; this action adds nothing it would have to fake. A
 * foreign/nonexistent clientId yields `kit: null` (RLS returns no rows) — the
 * same observation as "no kit yet", by design.
 */
export async function readLockedBrandKit(input: { clientId: string }): Promise<ReadLockedBrandKitResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await readCurrentLockedBrandKit(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, kit: res.kit };
}

/** Newest-first version history for a client. Same `requireAuth`/RLS posture as the read above. */
export async function listBrandKitVersionHistory(input: { clientId: string }): Promise<ListBrandKitVersionsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };

  const supabase = await createClient();
  const res = await listBrandKitVersions(supabase, clientId);
  if (!res.ok) return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  return { ok: true, entries: res.entries };
}
