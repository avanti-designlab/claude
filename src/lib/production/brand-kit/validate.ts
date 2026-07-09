/**
 * Runtime clamp for the brand-kit write seam (house posture — mirrors
 * src/lib/clients/validate.ts).
 *
 * A server action is a public RPC endpoint: a hostile caller POSTs any JSON
 * shape regardless of the compile-time types. The FROZEN skill already owns
 * SEMANTIC validation — hex format, the B1 font-family grammar gate, non-empty
 * scale, positive spacing (`buildBrandKit` throws on all of these) — and its
 * resolve functions read only known token fields, so unknown keys on the token
 * input never reach jsonb. This clamp closes the gap the skill does NOT cover:
 * SIZE. `resolveVoice` / `resolveLikeness` deep-clone whatever arrays the caller
 * sent, and `logoUrl` rides straight into `brand_kits.assets.logo_url` — so a
 * 10 MB voice sample, ten-thousand likeness ids, or a non-string array entry
 * would land in a jsonb column untouched by the skill.
 *
 * So this layer: gross-shape-gates the token containers (so the skill receives
 * clean-typed input and its format errors stay legible), caps the free-text
 * arrays + logo url + string lengths, and drops non-string array entries —
 * refusing over-cap payloads with interface-voice copy (doc 06 §6). It keeps
 * junk out of jsonb; RLS remains the isolation boundary and the skill remains
 * the format validator. Pure + unit-tested in the default `npm test` run.
 */

import type { BrandKitInput, BrandKitRevision } from "@/lib/skills/brand-kit";

/* ------------------------------------------------------------------ */
/* Caps (single source of truth — tests import these)                  */
/* ------------------------------------------------------------------ */

export const LOGO_URL_MAX_CHARS = 2048;
export const COLOR_VALUE_MAX_CHARS = 100;
export const FONT_STACK_MAX_CHARS = 300;
export const VOICE_LIST_MAX = 40;
export const VOICE_ENTRY_MAX_CHARS = 600;
export const VOICE_SAMPLE_MAX_CHARS = 5000;
export const LIKENESS_IDS_MAX = 100;
export const LIKENESS_ID_MAX_CHARS = 200;
export const TYPE_SCALE_STEPS_MAX = 60;
export const SPACING_STEPS_MAX = 200;

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export type BrandKitInputValidation =
  | { ok: true; value: BrandKitInput }
  | { ok: false; error: string };

export type BrandKitRevisionValidation =
  | { ok: true; changes: BrandKitRevision }
  | { ok: false; error: string };

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Shared field sanitizers                                             */
/* ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The logo url as sent by the caller. String within cap, else refuse.
 * `undefined` → not provided (kept absent); `null` → cleared. Scheme/render
 * safety is the consuming renderer's / schema-generation's job (it escapes),
 * exactly as `properties.url` is treated (doc 03 §3) — this only caps size and
 * gates type so junk never reaches the jsonb column.
 */
export function sanitizeLogoUrl(
  value: unknown
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return refuse("That logo reference couldn’t be read — provide it as a URL, or leave it blank.");
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > LOGO_URL_MAX_CHARS) {
    return refuse(`Logo URLs are capped at ${LOGO_URL_MAX_CHARS} characters — shorten it and try again.`);
  }
  return { ok: true, value: trimmed };
}

/** Cap the count + per-entry length of a string list; drop nothing silently — refuse on any violation. */
function sanitizeStringList(
  raw: unknown,
  field: string,
  maxCount: number,
  maxEntry: number
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return refuse(`We couldn’t read the ${field} list — remove and re-add it, then save again.`);
  }
  if (raw.length > maxCount) {
    return refuse(`The ${field} list is capped at ${maxCount} entries — remove some and try again.`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return refuse(`One ${field} entry couldn’t be read — remove it and try again.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > maxEntry) {
      return refuse(`A ${field} entry is too long (max ${maxEntry} characters) — shorten it and try again.`);
    }
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

/** Sanitize a partial voice profile (any subset of descriptors/samples/do/dont). */
function sanitizeVoice(
  raw: unknown
): { ok: true; value: BrandKitInput["voice"] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObject(raw)) {
    return refuse("We couldn’t read the brand voice — remove and re-add it, then save again.");
  }
  const descriptors = sanitizeStringList(raw.descriptors, "voice descriptor", VOICE_LIST_MAX, VOICE_ENTRY_MAX_CHARS);
  if (!descriptors.ok) return descriptors;
  const samples = sanitizeStringList(raw.samples, "voice sample", VOICE_LIST_MAX, VOICE_SAMPLE_MAX_CHARS);
  if (!samples.ok) return samples;
  const dos = sanitizeStringList(raw.do, "voice do-rule", VOICE_LIST_MAX, VOICE_ENTRY_MAX_CHARS);
  if (!dos.ok) return dos;
  const donts = sanitizeStringList(raw.dont, "voice don’t-rule", VOICE_LIST_MAX, VOICE_ENTRY_MAX_CHARS);
  if (!donts.ok) return donts;

  const value: NonNullable<BrandKitInput["voice"]> = {};
  if (descriptors.value !== undefined) value.descriptors = descriptors.value;
  if (samples.value !== undefined) value.samples = samples.value;
  if (dos.value !== undefined) value.do = dos.value;
  if (donts.value !== undefined) value.dont = donts.value;
  return { ok: true, value };
}

/** Sanitize partial likeness refs (Higgsfield/Motion reference-element ids). */
function sanitizeLikeness(
  raw: unknown
): { ok: true; value: BrandKitInput["likeness"] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObject(raw)) {
    return refuse("We couldn’t read the likeness references — remove and re-add them, then save again.");
  }
  const higgs = sanitizeStringList(raw.higgsfieldElementIds, "Higgsfield likeness id", LIKENESS_IDS_MAX, LIKENESS_ID_MAX_CHARS);
  if (!higgs.ok) return higgs;
  const motion = sanitizeStringList(raw.motionElementIds, "Motion likeness id", LIKENESS_IDS_MAX, LIKENESS_ID_MAX_CHARS);
  if (!motion.ok) return motion;

  const value: NonNullable<BrandKitInput["likeness"]> = {};
  if (higgs.value !== undefined) value.higgsfieldElementIds = higgs.value;
  if (motion.value !== undefined) value.motionElementIds = motion.value;
  return { ok: true, value };
}

/**
 * Gross-gate + size-cap the color container. The skill validates hex FORMAT and
 * auto-corrects contrast; here we only ensure it's an object of string values
 * within a sane length, so the skill's parser gets clean input and a hostile
 * mega-string never reaches it. Unknown keys are ignored by the skill's
 * resolver, so we pass the container through untouched once gated.
 */
function gateColors(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!isObject(raw)) {
    return refuse("Add at least a brand color before saving a brand kit.");
  }
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (typeof v !== "string") {
      return refuse(`The ${key} color couldn’t be read — provide it as a hex value like #2b6cff.`);
    }
    if (v.length > COLOR_VALUE_MAX_CHARS) {
      return refuse(`The ${key} color value is too long — provide a hex value like #2b6cff.`);
    }
  }
  return { ok: true };
}

/** Gross-gate + size-cap the typography container (faces are strings; scale is a bounded map). */
function gateTypography(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!isObject(raw)) {
    return refuse("We couldn’t read the typography — remove and re-add it, then save again.");
  }
  for (const face of ["display", "body", "mono"] as const) {
    const v = raw[face];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      return refuse(`The ${face} font couldn’t be read — provide a plain font name.`);
    }
    if (v.length > FONT_STACK_MAX_CHARS) {
      return refuse(`The ${face} font list is too long — shorten it and try again.`);
    }
  }
  if (raw.scale !== undefined) {
    if (!isObject(raw.scale)) {
      return refuse("We couldn’t read the type scale — remove and re-add it, then save again.");
    }
    if (Object.keys(raw.scale).length > TYPE_SCALE_STEPS_MAX) {
      return refuse(`The type scale is capped at ${TYPE_SCALE_STEPS_MAX} steps — remove some and try again.`);
    }
  }
  return { ok: true };
}

/** Gross-gate + size-cap the spacing container (unit is a number; steps is a bounded list). */
function gateSpacing(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (!isObject(raw)) {
    return refuse("We couldn’t read the spacing scale — remove and re-add it, then save again.");
  }
  if (Array.isArray(raw.steps) && raw.steps.length > SPACING_STEPS_MAX) {
    return refuse(`The spacing scale is capped at ${SPACING_STEPS_MAX} steps — remove some and try again.`);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/**
 * Clamp a full create payload. Colors/typography/spacing are gross-gated and
 * size-capped then passed to the skill (the format authority); voice/likeness
 * are sanitized; logo url is sanitized. The returned value is what the skill
 * and persistence may use — never the raw input.
 */
export function validateBrandKitInput(input: unknown): BrandKitInputValidation {
  const raw = (isObject(input) ? input : {}) as Record<string, unknown>;

  const colorsGate = gateColors(raw.colors);
  if (!colorsGate.ok) return colorsGate;
  const typoGate = gateTypography(raw.typography);
  if (!typoGate.ok) return typoGate;
  const spacingGate = gateSpacing(raw.spacing);
  if (!spacingGate.ok) return spacingGate;

  const voice = sanitizeVoice(raw.voice);
  if (!voice.ok) return voice;
  const likeness = sanitizeLikeness(raw.likeness);
  if (!likeness.ok) return likeness;
  const logo = sanitizeLogoUrl(raw.logoUrl);
  if (!logo.ok) return logo;

  const value: BrandKitInput = {
    // Skill-owned containers: gated above; the skill reads only known keys and
    // validates format/contrast. Cast is safe — buildBrandKit re-validates.
    colors: raw.colors as BrandKitInput["colors"],
    ...(raw.typography !== undefined ? { typography: raw.typography as BrandKitInput["typography"] } : {}),
    ...(raw.spacing !== undefined ? { spacing: raw.spacing as BrandKitInput["spacing"] } : {}),
    ...(voice.value !== undefined ? { voice: voice.value } : {}),
    ...(likeness.value !== undefined ? { likeness: likeness.value } : {}),
    ...(logo.value ? { logoUrl: logo.value } : {}),
  };
  return { ok: true, value };
}

/**
 * Clamp a revision payload (the skill's `BrandKitRevision` — colors/typography/
 * spacing/voice/likeness diffs). Same caps as create; no `colors.accent`
 * requirement (a revision may touch anything or nothing). Logo is NOT part of
 * `BrandKitRevision` (it's not a skill token) — the action clamps it separately
 * via `sanitizeLogoUrl`.
 */
export function validateBrandKitRevision(changes: unknown): BrandKitRevisionValidation {
  const raw = (isObject(changes) ? changes : {}) as Record<string, unknown>;

  const tokens = isObject(raw.tokens) ? raw.tokens : undefined;
  if (raw.tokens !== undefined && tokens === undefined) {
    return refuse("We couldn’t read these brand changes — review them and try again.");
  }
  if (tokens) {
    if (tokens.colors !== undefined) {
      const colorsGate = gateColors(tokens.colors);
      if (!colorsGate.ok) return colorsGate;
    }
    const typoGate = gateTypography(tokens.typography);
    if (!typoGate.ok) return typoGate;
    const spacingGate = gateSpacing(tokens.spacing);
    if (!spacingGate.ok) return spacingGate;
  }

  const voice = sanitizeVoice(raw.voice_profile);
  if (!voice.ok) return voice;
  const likeness = sanitizeLikeness(raw.likeness_refs);
  if (!likeness.ok) return likeness;

  const out: BrandKitRevision = {};
  if (tokens) {
    const t: NonNullable<BrandKitRevision["tokens"]> = {};
    if (tokens.colors !== undefined) t.colors = tokens.colors as NonNullable<BrandKitRevision["tokens"]>["colors"];
    if (tokens.typography !== undefined) t.typography = tokens.typography as NonNullable<BrandKitRevision["tokens"]>["typography"];
    if (tokens.spacing !== undefined) t.spacing = tokens.spacing as NonNullable<BrandKitRevision["tokens"]>["spacing"];
    if (Object.keys(t).length > 0) out.tokens = t;
  }
  if (voice.value !== undefined) out.voice_profile = voice.value;
  if (likeness.value !== undefined) out.likeness_refs = likeness.value;

  return { ok: true, changes: out };
}
