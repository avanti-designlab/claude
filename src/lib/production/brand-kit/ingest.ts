/**
 * M7 Brand Kit engine — ingestion (the skill wrapper) + the honesty report.
 *
 * WRAPS the frozen brand-kit-design-token skill (src/lib/skills/brand-kit —
 * GATED + FROZEN by its 0.2 + F2 review, incl. the B1 CSS-injection
 * font-grammar defense). This module NEVER reimplements the skill's token
 * resolution, WCAG contrast auto-correction, or the B1 gate — it CALLS
 * `buildBrandKit` and reads its result. Two consequences the M7 spec turns on:
 *
 *  1. B1 HOLDS THROUGH THE WRAPPER. A hostile font/color brand input is
 *     rejected INSIDE `buildBrandKit` (`validateFontStack` / `normalizeHex`
 *     throw before a kit ever exists). This wrapper catches that throw and
 *     surfaces it as an `invalid_brand_input` failure — the payload never
 *     reaches persistence. Nothing here string-concatenates brand input into
 *     CSS: this module emits NO CSS at all. Consumers that need CSS call the
 *     skill's B1-gated serializer (`toCssBlock` / `toCssVariables`); we store
 *     and return the token SET (jsonb) only.
 *
 *  2. HONESTY IS M7's JOB. The skill fills anything the brand did not specify
 *     with its neutral-premium "Signal" defaults and silently auto-corrects
 *     contrast. M7 turns the build result into a provenance report: which
 *     attributes the client actually specified vs. which are Signal DEFAULTS
 *     (never presented as the client's brand), which inputs are simply MISSING
 *     (voice/likeness/logo — no default exists), and the contrast corrections
 *     the skill made ("we darkened your orange to meet contrast"), surfaced
 *     verbatim, never hidden.
 *
 * Pure module: no network, no DB, no DOM, no timestamps. Unit-tested in the
 * default `npm test` run; the write action (./actions) feeds its output to
 * persistence, and the report rides into `brand_kits.assets.ingestion` so the
 * version-history read can show, per version, what was corrected/defaulted.
 */

import {
  buildBrandKit,
  type AccessibilityReport,
  type BrandKit,
  type BrandKitInput,
  type ContrastCheck,
  type TokenAdjustment,
} from "@/lib/skills/brand-kit";

/* ------------------------------------------------------------------ */
/* The honesty report                                                  */
/* ------------------------------------------------------------------ */

/**
 * One thing the client did NOT specify.
 *  - `defaulted`: the skill filled it from a Signal default (colors, type,
 *    spacing). Reported as a default, WITH the value the skill chose, so the
 *    operator sees "this is ours, not your brand" — never invented as theirs.
 *  - `missing`: no default exists for it (voice / likeness / logo). A real
 *    content-production gap the operator should close, not a silent fill-in.
 */
export interface IngestionNote {
  /** Dotted path into the kit, e.g. "colors.accentSecondary", "typography.body", "voice". */
  field: string;
  status: "defaulted" | "missing";
  /** Human-readable, interface-voice: what was not specified and what happened to it. */
  note: string;
  /** For a `defaulted` value: the exact value the skill filled in (labeled a default, not the client's choice). */
  value?: string;
}

/**
 * The full ingestion provenance for one kit build. Deterministic and pure.
 * Stored per version (`brand_kits.assets.ingestion`) AND returned live at
 * save time so the operator reviews corrections/gaps before the kit is enforced
 * downstream.
 */
export interface IngestionReport {
  /** Everything the client did not specify — defaults + missing inputs (see IngestionNote). */
  notes: IngestionNote[];
  /**
   * Contrast auto-corrections the skill applied, VERBATIM (the skill computed
   * `from`/`to`/`reason`). Empty when the input palette passed as-is.
   */
  contrastCorrections: TokenAdjustment[];
  /** True when every WCAG contrast requirement passes post-correction (the skill's `report.pass`). */
  contrastResolved: boolean;
  /**
   * Checks still failing after correction — a surface too close to mid-
   * luminance for any accessible foreground. Empty when `contrastResolved`.
   * The write path refuses to LOCK a kit with a non-empty list here (never
   * enforce an unreadable brand downstream).
   */
  unresolvedContrast: ContrastCheck[];
}

/* ------------------------------------------------------------------ */
/* Ingest result                                                       */
/* ------------------------------------------------------------------ */

export type IngestBrandKitResult =
  | {
      ok: true;
      /** The built kit (unlocked, version 1 from the skill). The caller locks it before persisting. */
      kit: BrandKit;
      /** Provenance: defaults, missing inputs, contrast corrections (see IngestionReport). */
      report: IngestionReport;
      /** Echoed for the caller to thread into `brand_kits.assets.logo_url` — the kit row itself has no logo column (doc 03 §3). */
      logoUrl: string | null;
    }
  | {
      ok: false;
      reason: "invalid_brand_input";
      /**
       * The skill's own validation message (which field, which offending
       * character). For SERVER telemetry + tests only — proves the rejection
       * came from the skill's gate. The action maps this to interface-voice
       * copy and NEVER echoes it to the browser.
       */
      detail: string;
    };

/* ------------------------------------------------------------------ */
/* Defaulted / missing detection (reads INPUT presence, never recomputes) */
/* ------------------------------------------------------------------ */

/**
 * The optional color tokens and their operator-facing labels. `accent` is
 * required (the brand color) and so is never in this list — it can never be a
 * default. `accentSecondary` / `accentWarm` are the documented two-accent
 * defaults (skill rule); the neutrals adapt to a client surface when one is
 * given, else fall to Signal.
 */
const OPTIONAL_COLORS: ReadonlyArray<{ key: keyof BrandKit["tokens"]["colors"]; label: string }> = [
  { key: "surface", label: "surface (background chrome)" },
  { key: "surfaceRaised", label: "raised surface (cards/panels)" },
  { key: "ink", label: "ink (primary text)" },
  { key: "muted", label: "muted (secondary text)" },
  { key: "accentSecondary", label: "secondary accent" },
  { key: "accentWarm", label: "warm accent" },
  { key: "positive", label: "positive (up/success)" },
  { key: "negative", label: "negative (down/error)" },
];

const TYPE_FACES: ReadonlyArray<{ key: "display" | "body" | "mono"; label: string }> = [
  { key: "display", label: "display font" },
  { key: "body", label: "body font" },
  { key: "mono", label: "mono font" },
];

/**
 * Build the honesty notes by comparing the RAW input (what the client
 * specified) against the built kit (what the skill produced). We read INPUT
 * presence only — the skill owns the actual defaulting, and we never recompute
 * a value, only report the one it chose.
 */
function ingestionNotes(input: BrandKitInput, kit: BrandKit, logoUrl: string | null): IngestionNote[] {
  const notes: IngestionNote[] = [];
  const colors = input.colors ?? ({} as BrandKitInput["colors"]);

  // Colors: each unspecified optional token is a Signal/derived default.
  for (const { key, label } of OPTIONAL_COLORS) {
    if (colors[key] === undefined) {
      notes.push({
        field: `colors.${key}`,
        status: "defaulted",
        note: `No ${label} specified — filled with the skill's default (not your brand's choice).`,
        value: kit.tokens.colors[key],
      });
    }
  }

  // Typography faces + scale.
  const typo = input.typography;
  for (const { key, label } of TYPE_FACES) {
    if (typo?.[key] === undefined) {
      notes.push({
        field: `typography.${key}`,
        status: "defaulted",
        note: `No ${label} specified — using the Signal default face.`,
        value: kit.tokens.typography[key],
      });
    }
  }
  if (typo?.scale === undefined) {
    notes.push({
      field: "typography.scale",
      status: "defaulted",
      note: `No type scale specified — using the Signal scale (${Object.keys(kit.tokens.typography.scale).length} steps).`,
    });
  }

  // Spacing.
  if (input.spacing === undefined) {
    notes.push({
      field: "spacing",
      status: "defaulted",
      note: "No spacing scale specified — using the Signal 4px scale.",
    });
  } else {
    if (input.spacing.unit === undefined) {
      notes.push({ field: "spacing.unit", status: "defaulted", note: "No spacing unit specified — using the Signal 4px unit." });
    }
    if (input.spacing.steps === undefined) {
      notes.push({ field: "spacing.steps", status: "defaulted", note: "No spacing steps specified — using the Signal step scale." });
    }
  }

  // Voice — no default exists (resolveVoice returns empty lists). An empty
  // voice profile is the real gap: M8 content generation reads this AT
  // generation time, so an empty one means brand voice can't be enforced.
  const voice = kit.voice_profile;
  if (voice.descriptors.length === 0 && voice.samples.length === 0) {
    notes.push({
      field: "voice",
      status: "missing",
      note: "No brand voice provided (no descriptors or samples). Content generation can't enforce brand voice until this is added.",
    });
  }

  // Likeness — no default exists. Missing refs mean media generation (M11) has
  // no on-likeness anchor for product/founder imagery.
  const likeness = kit.likeness_refs;
  if (likeness.higgsfieldElementIds.length === 0 && likeness.motionElementIds.length === 0) {
    notes.push({
      field: "likeness",
      status: "missing",
      note: "No product/founder likeness references provided. On-likeness media generation has no anchor until these are added.",
    });
  }

  // Logo — lives on assets, no default.
  if (logoUrl === null) {
    notes.push({
      field: "logo",
      status: "missing",
      note: "No logo provided. Organization/Person schema and press placements have no logo until one is added.",
    });
  }

  return notes;
}

/** Turn the skill's accessibility report into the contrast half of the ingestion report. */
function contrastProvenance(accessibility: AccessibilityReport): Pick<
  IngestionReport,
  "contrastCorrections" | "contrastResolved" | "unresolvedContrast"
> {
  return {
    contrastCorrections: accessibility.adjustments,
    contrastResolved: accessibility.pass,
    unresolvedContrast: accessibility.checks.filter((c) => !c.pass),
  };
}

/**
 * The provenance report for a REVISION (skill `reviseKit`). Its honesty is
 * contrast-focused: a revision deep-merges its changes onto the prior version,
 * so unspecified fields CARRY FORWARD from that version — they are not Signal
 * defaults, and `notes` is therefore empty. The corrections the skill applied
 * to the merged palette are the provenance that matters, surfaced the same way.
 */
export function revisionReport(accessibility: AccessibilityReport): IngestionReport {
  return { notes: [], ...contrastProvenance(accessibility) };
}

/* ------------------------------------------------------------------ */
/* ingestBrandKit — the wrapper                                        */
/* ------------------------------------------------------------------ */

/**
 * Ingest a client brand into a built (unlocked) kit + an honesty report.
 *
 * Delegates ALL validation + token math to the frozen skill: `buildBrandKit`
 * throws on any invalid brand input (bad hex, a font stack that fails the B1
 * grammar gate, an empty scale, bad spacing). We catch that and return
 * `invalid_brand_input` with the skill's message as `detail` — proving the
 * rejection was the skill's, not ours, and keeping hostile input off every
 * downstream path. On success the kit is unlocked (version 1); the caller
 * runs it through `lockKit` before persisting an immutable version row.
 */
export function ingestBrandKit(input: BrandKitInput): IngestBrandKitResult {
  let built;
  try {
    built = buildBrandKit(input);
  } catch (err) {
    // The skill's gate fired (font-grammar / hex / scale / spacing). Surface
    // its message for telemetry + tests; the action never echoes it out.
    return {
      ok: false,
      reason: "invalid_brand_input",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const report: IngestionReport = {
    notes: ingestionNotes(input, built.kit, built.logoUrl),
    ...contrastProvenance(built.accessibility),
  };

  return { ok: true, kit: built.kit, report, logoUrl: built.logoUrl };
}
