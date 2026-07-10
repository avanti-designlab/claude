/**
 * Runtime clamps for competitor write inputs (migration 0010). Mirrors the
 * onboarding clamp pattern: shape-check, trim, cap, and refuse with
 * interface-voice errors BEFORE anything reaches Postgres. The DB CHECKs
 * (competitors_name_len, the case-insensitive unique index) remain the backstop.
 */

/** Matches the competitors_name_len CHECK (migration 0010). */
export const COMPETITOR_NAME_MAX = 120;

/**
 * Per-client competitor cap — enforced HERE (at the write seam), because a
 * CHECK cannot count sibling rows (migration 0010 header). ⚑ ratify at wiring.
 */
export const COMPETITORS_PER_CLIENT_CAP = 10;

/** Bare hostname: dot-separated labels, alpha TLD, ≤253 (no scheme/path/port). */
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Normalize an optional competitor domain to a BARE hostname, or refuse.
 *   - absent / empty  → undefined (no domain — a name-only competitor).
 *   - a full http(s) URL → its hostname is extracted (helpful, not pedantic).
 *   - a bare hostname → lowercased + grammar-checked.
 *   - anything else   → null (refused).
 */
export function sanitizeCompetitorDomain(
  raw: unknown
): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (s === "") return undefined;

  if (/^https?:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else if (s.includes("/") || s.includes(":") || s.includes(" ")) {
    // A bare hostname carries no path/scheme/port/space.
    return null;
  }
  s = s.replace(/\.$/, ""); // tolerate a trailing FQDN dot
  return HOSTNAME_RE.test(s) ? s : null;
}

export interface ValidCompetitor {
  name: string;
  /** Null when no domain was entered; a bare hostname otherwise. */
  domain: string | null;
}

export type CompetitorValidation =
  | { ok: true; value: ValidCompetitor }
  | { ok: false; error: string };

const NAME_REQUIRED_ERROR = "Add the competitor's name before saving.";
const NAME_TOO_LONG_ERROR = `Competitor names are capped at ${COMPETITOR_NAME_MAX} characters — shorten this one and try again.`;
const DOMAIN_INVALID_ERROR =
  "That domain doesn't look right. Enter just the site's domain, like competitor.com.";

export function validateCompetitorInput(input: unknown): CompetitorValidation {
  const r = (input ?? {}) as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (name === "") return { ok: false, error: NAME_REQUIRED_ERROR };
  if (name.length > COMPETITOR_NAME_MAX) {
    return { ok: false, error: NAME_TOO_LONG_ERROR };
  }

  const domain = sanitizeCompetitorDomain(r.domain);
  if (domain === null) return { ok: false, error: DOMAIN_INVALID_ERROR };

  return { ok: true, value: { name, domain: domain ?? null } };
}
