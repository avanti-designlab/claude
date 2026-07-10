/**
 * Runtime clamps for property write inputs — the ONE property-input validator,
 * reused by BOTH the onboarding website persist (src/lib/clients/actions.ts)
 * and the workspace properties seam (src/lib/properties/actions.ts). Mirrors the
 * onboarding clamp pattern (src/lib/clients/validate.ts): shape-check, trim,
 * length-cap, and refuse non-conforming input BEFORE anything reaches Postgres.
 *
 * A property URL is stored data only (connection_method 'none', no crawl until
 * the runs/processor block wires it with socket-pinning) — so this validates
 * SHAPE (a real http(s) URL within a cap), not reachability. RLS + the frozen
 * properties CHECKs (migration 0003) remain the backstop; this keeps junk out of
 * the column and gives interface-voice refusals (doc 06 §6).
 *
 * CONNECTION METHOD (scope condition; Orchestrator ruling 2026-07-10):
 * connection_method must NEVER be written to a connected-looking value without a
 * real connection, and no connection flow exists yet — so the ONLY value
 * writable at these seams is 'none'. NO exceptions: 'pr' is the GIT/PULL-REQUEST
 * write method (doc 04 — one of the four auto-fix write methods, alongside
 * api/edge_worker; NOT press-release outreach, which is M12 and has nothing to
 * do with this column), and like every connected method it becomes writable only
 * when its wiring block lands with a real connection. The full CHECK-allowed set
 * ('api' | 'edge_worker' | 'pr' | 'none') is owned by the future Connections
 * block, which sets it alongside a real auth_ref.
 */

import { isPropertyPlatform, type PropertyPlatform } from "@/lib/types/db";

/** A generous cap that keeps junk out of the url column (URLs are well under this). */
export const PROPERTY_URL_MAX_CHARS = 2048;

/**
 * A trimmed, validated http(s) URL, or null. Stores the operator's exact input
 * (only trimmed) — canonicalization for crawling happens at fetch time behind
 * the egress guard, never here.
 */
export function sanitizePropertyUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > PROPERTY_URL_MAX_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Onboarding website (soft — never fails the whole onboarding)        */
/* ------------------------------------------------------------------ */

/**
 * Onboarding's optional website property. Soft by design: a property must
 * never fail the whole client save.
 *   - "none":    no URL was entered — no property, no warning.
 *   - "invalid": a URL was entered but it (or its platform) can't be persisted
 *                as a website — the client saves; the action surfaces a warning.
 *   - "ok":      a persistable website (url + a valid platform, which the frozen
 *                properties_website_has_platform CHECK requires).
 */
export type WebsiteValidation =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; url: string; platform: PropertyPlatform };

export function validateWebsiteInput(raw: unknown): WebsiteValidation {
  if (raw === null || typeof raw !== "object") return { kind: "none" };
  const r = raw as Record<string, unknown>;
  const rawUrl = typeof r.url === "string" ? r.url.trim() : "";
  if (rawUrl === "") return { kind: "none" };
  const url = sanitizePropertyUrl(rawUrl);
  if (!url || !isPropertyPlatform(r.platform)) return { kind: "invalid" };
  return { kind: "ok", url, platform: r.platform };
}

/* ------------------------------------------------------------------ */
/* Workspace seam (hard — an explicit create/edit refuses on bad input)*/
/* ------------------------------------------------------------------ */

const URL_REQUIRED_ERROR =
  "Enter a full website address starting with http:// or https:// (for example https://yoursite.com).";
const PLATFORM_REQUIRED_ERROR =
  "Pick the platform this site runs on so we know how we'll connect to it.";
const CONNECTION_LOCKED_ERROR =
  "Connections aren't wired up yet, so a site can only be added as “not connected”. You'll connect it in the Connections step once that ships.";
const NOTHING_TO_UPDATE_ERROR =
  "Change the website address or platform before saving.";

/** connection_method accepted at these seams today: only 'none' (see header). */
function connectionMethodOk(value: unknown): boolean {
  return value === undefined || value === "none";
}

export interface ValidPropertyCreate {
  url: string;
  platform: PropertyPlatform;
  /** Always 'none' at this seam (documented); never a connected value. */
  connectionMethod: "none";
}

export type PropertyCreateValidation =
  | { ok: true; value: ValidPropertyCreate }
  | { ok: false; error: string };

export function validatePropertyCreateInput(
  input: unknown
): PropertyCreateValidation {
  const r = (input ?? {}) as Record<string, unknown>;
  if (!connectionMethodOk(r.connectionMethod)) {
    return { ok: false, error: CONNECTION_LOCKED_ERROR };
  }
  const url = sanitizePropertyUrl(r.url);
  if (!url) return { ok: false, error: URL_REQUIRED_ERROR };
  // type is pinned to 'website' at this seam (the frozen CHECK then requires a
  // platform), so a platform is mandatory.
  if (!isPropertyPlatform(r.platform)) {
    return { ok: false, error: PLATFORM_REQUIRED_ERROR };
  }
  return { ok: true, value: { url, platform: r.platform, connectionMethod: "none" } };
}

export interface ValidPropertyEdit {
  url: string;
  platform: PropertyPlatform;
}

export type PropertyEditValidation =
  | { ok: true; value: ValidPropertyEdit }
  | { ok: false; error: string };

/**
 * Edit clamps url + platform (both required — a website always needs a platform,
 * per the frozen CHECK). connection_method stays 'none' and is not editable here
 * (the Connections block owns transitions to connected values).
 */
export function validatePropertyEditInput(
  input: unknown
): PropertyEditValidation {
  const r = (input ?? {}) as Record<string, unknown>;
  if (!connectionMethodOk(r.connectionMethod)) {
    return { ok: false, error: CONNECTION_LOCKED_ERROR };
  }
  const url = sanitizePropertyUrl(r.url);
  const platform = isPropertyPlatform(r.platform) ? r.platform : null;
  if (!url && !platform) return { ok: false, error: NOTHING_TO_UPDATE_ERROR };
  if (!url) return { ok: false, error: URL_REQUIRED_ERROR };
  if (!platform) return { ok: false, error: PLATFORM_REQUIRED_ERROR };
  return { ok: true, value: { url, platform } };
}
