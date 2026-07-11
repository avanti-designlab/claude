/**
 * Pure, client-safe helpers for the paste-URL brand-extract flow — the parse
 * boundary between the STORED draft jsonb (untrusted extracted DATA, bounded at
 * the database but shaped by a fetch of an external site) and everything the
 * panel renders / the form prefills. Same discipline as the audit fix-list
 * parser: throw-free under hostile input, unknown keys dropped, malformed
 * values dropped (absent ≠ fabricated), every string trimmed + length-bounded,
 * every list count-bounded. No React, no server imports — testable in isolation.
 */

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/** Longest hex form the skill emits is #RRGGBBAA (9 chars); clamp generously. */
const COLOR_MAX_CHARS = 32;
/** Font stacks validate at a few families; clamp generously. */
const FONT_MAX_CHARS = 512;
/** Mirrors the adapter's candidate-URL length cap. */
const URL_MAX_CHARS = 2048;
/** Mirrors the adapter's per-list candidate count caps. */
const CANDIDATES_MAX = 8;
const NOTES_MAX = 24;
const NOTE_MAX_CHARS = 500;

/** The color keys the ingest form offers — the only ones handed across. */
export const DRAFT_COLOR_KEYS = [
  "accent",
  "accentSecondary",
  "accentWarm",
  "surface",
  "surfaceRaised",
  "ink",
  "muted",
  "positive",
  "negative",
] as const;
export type DraftColorKey = (typeof DRAFT_COLOR_KEYS)[number];

export const DRAFT_FACE_KEYS = ["display", "body", "mono"] as const;
export type DraftFaceKey = (typeof DRAFT_FACE_KEYS)[number];

/* ------------------------------------------------------------------ */
/* View type                                                           */
/* ------------------------------------------------------------------ */

/** The proposed kit, parsed + bounded for the review panel and form prefill. */
export interface ExtractDraftView {
  draftId: string;
  createdAt: string;
  colors: Partial<Record<DraftColorKey, string>>;
  typography: Partial<Record<DraftFaceKey, string>>;
  /** The engine's top logo pick (prefills the form's logo field). */
  logoUrl: string | null;
  /** Alternate logo/imagery URLs the operator can pick instead. Plain DATA —
   *  the panel renders them as text, never loads external bytes. */
  logoCandidates: string[];
  imageryCandidates: string[];
  /** Operator-facing provenance, verbatim from the engine (fixed strings). */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Parse boundary                                                      */
/* ------------------------------------------------------------------ */

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function boundedStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  // Deduped: the panel keys list items by content, so a hostile draft with
  // duplicate entries must not produce duplicate React keys (the adapter
  // dedupes on the legitimate path; this boundary re-guarantees it).
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= maxItems) break;
    const s = boundedString(item, maxChars);
    if (s === null || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Parse one stored draft jsonb into the view. Throw-free under hostile input. */
export function parseStoredExtractDraft(
  raw: unknown,
  draftId: string,
  createdAt: string
): ExtractDraftView {
  const obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const colors: Partial<Record<DraftColorKey, string>> = {};
  const rawColors = obj.colors;
  if (rawColors !== null && typeof rawColors === "object" && !Array.isArray(rawColors)) {
    for (const key of DRAFT_COLOR_KEYS) {
      const v = boundedString((rawColors as Record<string, unknown>)[key], COLOR_MAX_CHARS);
      if (v !== null) colors[key] = v;
    }
  }

  const typography: Partial<Record<DraftFaceKey, string>> = {};
  const rawFaces = obj.typography;
  if (rawFaces !== null && typeof rawFaces === "object" && !Array.isArray(rawFaces)) {
    for (const key of DRAFT_FACE_KEYS) {
      const v = boundedString((rawFaces as Record<string, unknown>)[key], FONT_MAX_CHARS);
      if (v !== null) typography[key] = v;
    }
  }

  return {
    draftId,
    createdAt,
    colors,
    typography,
    logoUrl: boundedString(obj.logoUrl, URL_MAX_CHARS),
    logoCandidates: boundedStringList(obj.logoCandidates, CANDIDATES_MAX, URL_MAX_CHARS),
    imageryCandidates: boundedStringList(obj.imageryCandidates, CANDIDATES_MAX, URL_MAX_CHARS),
    notes: boundedStringList(obj.notes, NOTES_MAX, NOTE_MAX_CHARS),
  };
}
