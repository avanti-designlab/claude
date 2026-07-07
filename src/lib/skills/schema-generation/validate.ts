/**
 * Field-level validators: URLs, dates, durations, times, ratings, prices, counts.
 *
 * Date policy (SKILL.md rule 5 / doc 05 M6): this module VALIDATES dates the caller
 * provides — it never generates, defaults, or "bumps" one.
 */

import type { IssueCode, IssueSeverity, ValidationIssue } from "./types";

export function issue(
  code: IssueCode,
  severity: IssueSeverity,
  path: string,
  message: string,
  claim?: string,
): ValidationIssue {
  return claim === undefined
    ? { code, severity, path, message }
    : { code, severity, path, message, claim };
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

export function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** YYYY-MM-DD, optionally with a T-separated time and timezone offset. */
const ISO_DATE_RE = new RegExp(
  "^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$",
);

export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000) return false;
  if (month < 1 || month > 12) return false;
  // Date.UTC months are 0-based, so (year, month, 0) = last day of `month` (1-based).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (m[4] !== undefined) {
    const hours = Number(m[4]);
    const minutes = Number(m[5]);
    const seconds = m[6] === undefined ? 0 : Number(m[6]);
    if (hours > 23 || minutes > 59 || seconds > 59) return false;
  }
  return true;
}

/** Epoch millis for comparing two already-validated ISO dates. */
export function isoDateToEpoch(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value}T00:00:00Z`);
}

/**
 * Epoch millis for the FUTURE_DATE reference point ("now"). A valid injected
 * ISO `referenceDate` (SchemaGenerationRequest.referenceDate) makes the check
 * deterministic and replayable; when it is absent — or not a valid ISO date —
 * this falls back to the wall clock, the library's only nondeterministic read.
 */
export function referenceEpoch(referenceDate?: string): number {
  return referenceDate !== undefined && isValidIsoDate(referenceDate)
    ? isoDateToEpoch(referenceDate)
    : Date.now();
}

/* ------------------------------------------------------------------ */
/* Durations & times                                                   */
/* ------------------------------------------------------------------ */

/** ISO 8601 duration (e.g. "PT2M12S", "PT1H05M"). */
const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/;

export function isValidIsoDuration(value: string): boolean {
  return ISO_DURATION_RE.test(value);
}

/** "HH:MM" 24h clock, for OpeningHoursSpecification. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

/* ------------------------------------------------------------------ */
/* Prices, currencies, ratings, counts                                 */
/* ------------------------------------------------------------------ */

const PRICE_STRING_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Canonicalizes a price to the string schema.org expects ("24.99", "45").
 * Returns undefined when the value is not a plain non-negative decimal.
 */
export function canonicalPrice(value: number | string): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const asString = String(value);
    return PRICE_STRING_RE.test(asString) ? asString : undefined;
  }
  const trimmed = value.trim();
  return PRICE_STRING_RE.test(trimmed) ? trimmed : undefined;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isValidCurrency(value: string): boolean {
  return CURRENCY_RE.test(value);
}

export interface RatingBounds {
  worst: number;
  best: number;
}

export function ratingBounds(worstRating?: number, bestRating?: number): RatingBounds {
  return { worst: worstRating ?? 1, best: bestRating ?? 5 };
}

export function isRatingInRange(
  ratingValue: number,
  worstRating?: number,
  bestRating?: number,
): boolean {
  if (!Number.isFinite(ratingValue)) return false;
  const { worst, best } = ratingBounds(worstRating, bestRating);
  return worst <= best && ratingValue >= worst && ratingValue <= best;
}

export function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
