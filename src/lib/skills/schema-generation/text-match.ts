/**
 * Visible-text verification — the hard-rule-1 contract (SKILL.md rule 1, doc 05 M10).
 *
 * Every user-visible claim encoded in the JSON-LD must actually appear in the
 * rendered page text the caller supplies. Matching is deterministic and
 * deliberately conservative:
 *
 * - "text" claims:  normalized substring match. Normalization is NFKC + typographic
 *   quote/dash folding + whitespace collapse + lowercase — so markup-driven casing
 *   or curly quotes never cause false mismatches, but reworded content always does.
 * - "price"/"number" claims: digit-boundary numeric match ("24.99" matches "$24.99"
 *   but never "124.99"; "45" also matches "45.00" and vice versa).
 * - "phone" claims: digit-sequence match tolerant of separators; falls back to the
 *   last 10 digits so "+1-619-555-0143" matches "(619) 555-0143".
 *
 * Dates are validated for sanity (validate.ts) but are NOT text-matched: rendered
 * date formats ("July 12, 2026") cannot be matched against ISO input deterministically.
 */

import type {
  ClaimSpec,
  CorrespondenceEntry,
  ValidationIssue,
} from "./types";
import { issue } from "./validate";

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** Curly/low-9 single quotes → apostrophe. */
const SINGLE_QUOTES = /[‘’‚‛]/g;
/** Curly/low-9 double quotes → straight quote. */
const DOUBLE_QUOTES = /[“”„‟]/g;
/** Figure/en/em/horizontal-bar dashes → hyphen. */
const DASHES = /[‒–—―]/g;
/** Non-breaking and typographic spaces → plain space. */
const EXOTIC_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** Zero-width characters stripped entirely. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export function normalizeVisibleText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(EXOTIC_SPACES, " ")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Kind-specific matchers                                              */
/* ------------------------------------------------------------------ */

interface MatchHit {
  matched: boolean;
  index?: number;
  length?: number;
}

function matchText(claimValue: string, normalizedPage: string): MatchHit {
  const needle = normalizeVisibleText(claimValue);
  if (needle === "") return { matched: false };
  const index = normalizedPage.indexOf(needle);
  return index === -1 ? { matched: false } : { matched: true, index, length: needle.length };
}

/**
 * Digit-boundary regex: no digit or decimal point immediately before, and no
 * "(optionally .)digit" immediately after — so "24" never matches inside "124"
 * or "24.99". Built via the RegExp constructor because lookbehind syntax is
 * newer than the project's ES2017 target (runtime Node supports it).
 */
function numberBoundaryRegex(value: string): RegExp {
  return new RegExp(`(?<![\\d.])${escapeRegExp(value)}(?!\\.?\\d)`);
}

/** Candidate renderings of a numeric value: "45" ↔ "45.00", "6.5" ↔ "6.50", "24.50" ↔ "24.5". */
export function numericCandidates(value: string): string[] {
  const candidates = new Set<string>([value]);
  if (/^\d+$/.test(value)) {
    candidates.add(`${value}.00`);
  } else if (/^\d+\.\d+$/.test(value)) {
    const [whole, fraction] = value.split(".");
    if (fraction.length === 1) candidates.add(`${value}0`); // 6.5 → 6.50
    const trimmedFraction = fraction.replace(/0+$/, "");
    if (trimmedFraction === "") {
      candidates.add(whole); // 45.00 → 45
    } else if (trimmedFraction !== fraction) {
      candidates.add(`${whole}.${trimmedFraction}`); // 24.50 → 24.5
    }
  }
  return [...candidates];
}

function matchNumeric(claimValue: string, normalizedPage: string): MatchHit {
  for (const candidate of numericCandidates(claimValue.trim())) {
    const match = numberBoundaryRegex(candidate).exec(normalizedPage);
    if (match) return { matched: true, index: match.index, length: match[0].length };
  }
  return { matched: false };
}

const PHONE_SEPARATOR = "[\\s\\-\\.\\(\\)\\/]*";

function phoneRegex(digits: string): RegExp {
  return new RegExp(digits.split("").map(escapeRegExp).join(PHONE_SEPARATOR));
}

function matchPhone(claimValue: string, normalizedPage: string): MatchHit {
  const digits = claimValue.replace(/\D+/g, "");
  if (digits.length < 5) return matchText(claimValue, normalizedPage);
  const attempts = [digits];
  // Tolerate a country-code prefix present in the data but not on the page.
  if (digits.length > 10) attempts.push(digits.slice(-10));
  for (const attempt of attempts) {
    const match = phoneRegex(attempt).exec(normalizedPage);
    if (match) return { matched: true, index: match.index, length: match[0].length };
  }
  return { matched: false };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

const EVIDENCE_RADIUS = 40;

function excerpt(normalizedPage: string, index: number, length: number): string {
  const start = Math.max(0, index - EVIDENCE_RADIUS);
  const end = Math.min(normalizedPage.length, index + length + EVIDENCE_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalizedPage.length ? "…" : "";
  return `${prefix}${normalizedPage.slice(start, end)}${suffix}`;
}

export interface VerificationOutcome {
  correspondence: CorrespondenceEntry[];
  issues: ValidationIssue[];
}

/**
 * Verifies every registered claim against the visible page text. Mismatched
 * error-severity claims are what make `generateSchema` refuse to emit.
 */
export function verifyClaims(
  claims: ClaimSpec[],
  visiblePageText: string,
): VerificationOutcome {
  const normalizedPage = normalizeVisibleText(visiblePageText);
  const correspondence: CorrespondenceEntry[] = [];
  const issues: ValidationIssue[] = [];

  for (const claim of claims) {
    let hit: MatchHit;
    switch (claim.kind) {
      case "price":
      case "number":
        hit = matchNumeric(claim.value, normalizedPage);
        break;
      case "phone":
        hit = matchPhone(claim.value, normalizedPage);
        break;
      default:
        hit = matchText(claim.value, normalizedPage);
    }

    const entry: CorrespondenceEntry = {
      path: claim.path,
      label: claim.label,
      claim: claim.value,
      kind: claim.kind,
      severity: claim.severity,
      matched: hit.matched,
    };
    if (hit.matched && hit.index !== undefined && hit.length !== undefined) {
      entry.evidence = excerpt(normalizedPage, hit.index, hit.length);
    }
    correspondence.push(entry);

    if (!hit.matched) {
      issues.push(
        issue(
          "TEXT_MISMATCH",
          claim.severity,
          claim.path,
          `${claim.label} ("${claim.value}") does not appear in the visible page text — structured data must match rendered content exactly (manual-action risk).`,
          claim.value,
        ),
      );
    }
  }

  return { correspondence, issues };
}
