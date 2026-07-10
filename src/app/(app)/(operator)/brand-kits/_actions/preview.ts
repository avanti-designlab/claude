"use server";

/**
 * Brand-kit REVIEW-step preview — a thin, read-only dry-run seam over the FROZEN
 * M7 brand-kit engine + skill. It exists because the engine's write actions
 * (`createBrandKit` / `reviseBrandKit`) build, contrast-gate, lock, and persist
 * ATOMICALLY, and their FAILURE paths return only `{ reason, error }` — the
 * structured `IngestionReport` (which contrast checks failed, which tokens were
 * adjusted from/to, which inputs defaulted or are missing) is dropped on refusal.
 * The ingest UI needs that report BEFORE the irreversible act (locking): to show
 * the operator what the engine will do, and — when a palette is unresolvable — to
 * render exactly WHY instead of a bare sentence. That callable seam genuinely did
 * not exist, so this wrapper adds it WITHOUT reimplementing or weakening anything:
 *
 *  - It calls the engine's OWN pure functions — `validateBrandKitInput` /
 *    `validateBrandKitRevision` (the size/grammar clamp), `ingestBrandKit`
 *    (the skill wrapper: build + WCAG contrast auto-correction + honesty report),
 *    and `reviseKit` + `revisionReport` for a revision. No token math, no gate,
 *    no default is re-authored here.
 *  - It NEVER writes. No insert, no lock flip. `createBrandKit` / `reviseBrandKit`
 *    remain the only persistence path and the authoritative build — this preview
 *    shares their exact code path, so what it shows is what they will do.
 *  - It is `requireOperator`-gated (the same staff floor as the write actions),
 *    so it is not an open compute endpoint, and it inherits RLS below it for the
 *    one read the revision preview performs (the current locked kit).
 *
 * SCHEMA/CONTRACT NOTE (flagged, not forced): the cleaner long-term home for this
 * is a dry-run flag on the frozen engine actions themselves — deferred to the
 * post-freeze Orchestrator + Code Review path (CLAUDE.md rule 1). This wrapper is
 * a UI-layer read seam only; it changes nothing under src/lib.
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import {
  ingestBrandKit,
  revisionReport,
  sanitizeLogoUrl,
  validateBrandKitInput,
  validateBrandKitRevision,
  type IngestionReport,
} from "@/lib/production/brand-kit";
import {
  readLockedBrandKit,
  type CreateBrandKitInput,
  type ReviseBrandKitInput,
} from "@/lib/production/brand-kit/actions";
import { reviseKit, type BrandKit } from "@/lib/skills/brand-kit";
import type { LockedBrandKit } from "@/lib/production/brand-kit";
import type { ColorTokens, TypographyTokens } from "@/lib/types/brand";

/**
 * The RESOLVED token set the lock would persist — post-merge (for a revision),
 * post-default, post-contrast-correction. Rendered on the review step so the
 * operator sees exactly what locking will store, never less (the engine computes
 * it; this seam only passes it through).
 */
export interface ResolvedPreviewTokens {
  colors: ColorTokens;
  typography: TypographyTokens;
}

/**
 * Preview outcome. `ok: true` always carries the full report — the caller reads
 * `report.contrastResolved` to tell a lockable kit (true) from a structured
 * contrast REFUSAL (false, with `unresolvedContrast` + the resolved:false
 * adjustments explaining why) — plus the resolved tokens the lock would persist.
 * `ok: false` is an input/read failure, kept distinct so the UI can say "fix
 * your inputs" vs "this client's kit couldn't be loaded" honestly.
 */
export type BrandKitPreviewResult =
  | { ok: true; report: IngestionReport; resolved: ResolvedPreviewTokens }
  | {
      ok: false;
      reason: "forbidden" | "invalid_brand_input" | "not_found" | "no_kit" | "read_failed";
      error: string;
    };

/* Interface-voice copy — matched to the M7 engine's own wording so preview and
 * the real write speak with one voice (the engine does not export these). */
const FORBIDDEN_ERROR =
  "You don’t have permission to manage brand kits — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const INVALID_BRAND_INPUT_ERROR =
  "We couldn’t build a brand kit from these details. Check that every color is a valid hex code and every font is a plain font name, then try again.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const NO_KIT_ERROR = "This client has no brand kit yet — create one first.";
const READ_FAILED_ERROR =
  "We couldn’t load this brand kit. Check your connection and try again.";

/** Reconstruct a skill `BrandKit` from a stored locked kit (for `reviseKit`). */
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
 * Dry-run a NEW kit build. Runs the exact clamp + skill build + honesty report
 * that `createBrandKit` runs, then STOPS before the already-exists check, lock,
 * and insert. The returned report drives the review step (corrections + defaults
 * + missing) and — when `contrastResolved` is false — the structured refusal.
 */
export async function previewNewBrandKit(
  input: CreateBrandKitInput,
): Promise<BrandKitPreviewResult> {
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const validated = validateBrandKitInput(input);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_brand_input", error: validated.error };
  }

  const ingest = ingestBrandKit(validated.value);
  if (!ingest.ok) {
    // The skill's gate fired (bad hex / font grammar / empty scale). Same as the
    // write action: interface copy, never the raw skill message.
    return { ok: false, reason: "invalid_brand_input", error: INVALID_BRAND_INPUT_ERROR };
  }
  return {
    ok: true,
    report: ingest.report,
    resolved: {
      colors: ingest.kit.tokens.colors,
      typography: ingest.kit.tokens.typography,
    },
  };
}

/**
 * Dry-run a REVISION. Reads the current locked kit (RLS-scoped), applies the
 * skill's `reviseKit` (deep-merge + the same resolve/contrast pipeline), and
 * returns the revision report — WITHOUT inserting the next version. Mirrors
 * `reviseBrandKit`'s validation + read + merge exactly.
 */
export async function previewBrandKitRevision(
  input: ReviseBrandKitInput,
): Promise<BrandKitPreviewResult> {
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const validated = validateBrandKitRevision(input?.changes);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_brand_input", error: validated.error };
  }
  const logo = sanitizeLogoUrl(input?.logoUrl);
  if (!logo.ok) {
    return { ok: false, reason: "invalid_brand_input", error: logo.error };
  }

  // The current kit is read through the frozen, RLS-scoped read action; a
  // foreign / nonexistent client yields kit: null (indistinguishable, by design).
  const current = await readLockedBrandKit({ clientId: input?.clientId });
  if (!current.ok) {
    return current.reason === "not_found"
      ? { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR }
      : { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  }
  if (current.kit === null) {
    return { ok: false, reason: "no_kit", error: NO_KIT_ERROR };
  }

  let revised;
  try {
    revised = reviseKit(toBrandKit(current.kit), validated.changes);
  } catch {
    return { ok: false, reason: "invalid_brand_input", error: INVALID_BRAND_INPUT_ERROR };
  }
  return {
    ok: true,
    report: revisionReport(revised.accessibility),
    // The MERGED result: carried-forward values + this revision's changes,
    // post-contrast-correction — exactly what reviseBrandKit would lock.
    resolved: {
      colors: revised.kit.tokens.colors,
      typography: revised.kit.tokens.typography,
    },
  };
}
