/**
 * Brand-extract — the pure orchestrator + the ingest-draft mapping seam.
 *
 * `extractBrandCandidates` runs the sub-parsers over the RAW MATERIALS a gated
 * fetch layer will later hand it (HTML + CSS strings) and returns RANKED brand
 * candidates. It is pure and deterministic: no network, no vendor/LLM, no DOM,
 * no `Date.now`/`Math.random`. It NEVER throws — every sub-step is isolated so a
 * failure in one yields an honest empty for that slice, not a lost result.
 *
 * `toBrandKitDraft` maps the top candidates onto the FROZEN M7 ingest input
 * shape (`BrandKitInput` — `colors`/`typography`/`logoUrl`/`voice`) as a DRAFT
 * the operator reviews. It deliberately does NOT call `createBrandKit`, does NOT
 * lock a kit, and does NOT run (or bypass) the skill's contrast gate — the kit
 * is built + contrast-corrected only when the operator submits the reviewed
 * draft. Colors that fail the skill's hex grammar are dropped, never coerced;
 * voice is left empty with an honest "connect AI to auto-fill" flag.
 */

import { hexToRgb, normalizeHex, rgbToHsl, validateFontStack } from "@/lib/skills/brand-kit";
import { LOGO_URL_MAX_CHARS } from "@/lib/production/brand-kit/validate";
import { extractColors } from "./colors";
import { extractFonts } from "./fonts";
import { extractIdentity, buildSourceText } from "./identity";
import { extractImagery, extractLogos, readStructuredData } from "./logos";
import { parseCss } from "./css-scan";
import { scanPage, tokenize, type PageModel } from "./html-scan";
import { usableBase } from "./url";
import type {
  BrandKitDraft,
  ColorCandidate,
  ExtractedBrandCandidates,
  ExtractInput,
  FontCandidate,
  LogoCandidate,
} from "./types";

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/**
 * Defensive per-document input cap (characters ≈ bytes for typical markup). The
 * crawl layer already bounds fetched bytes, but this module is pure and
 * self-sufficient: if a future caller hands it an unbounded giant string, each
 * document (html / each cssBlob / aboutHtml) is truncated BEFORE any parse or
 * `toLowerCase`, and the truncation is disclosed as a diagnostic note. 8M chars
 * comfortably clears a real page + its stylesheets while capping a hostile one.
 */
export const MAX_INPUT_CHARS = 8_000_000;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function emptyPageModel(): PageModel {
  return {
    title: null,
    metaDescription: null,
    metaByName: new Map(),
    iconLinks: [],
    googleFontHrefs: [],
    styleBlocks: [],
    images: [],
    headerSvgs: [],
    inlineStyles: [],
    jsonLdBlocks: [],
    textChunks: [],
    hadAnyTag: false,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function extractBrandCandidates(input: ExtractInput): ExtractedBrandCandidates {
  const notes: string[] = [];
  let inputTruncated = false;
  const clampInput = (s: string): string => {
    if (s.length > MAX_INPUT_CHARS) {
      inputTruncated = true;
      return s.slice(0, MAX_INPUT_CHARS);
    }
    return s;
  };

  const html = clampInput(typeof input?.html === "string" ? input.html : "");
  const base = usableBase(input?.pageUrl);

  const tokens = safe(() => tokenize(html), []);
  const page = safe(() => scanPage(tokens), emptyPageModel());

  const providedCss = Array.isArray(input?.cssBlobs)
    ? input.cssBlobs.filter((s): s is string => typeof s === "string").map(clampInput)
    : [];
  const combinedCss = dedupeStrings([...providedCss, ...page.styleBlocks]);
  const cssAbsent = providedCss.length === 0;
  const parsed = safe(() => parseCss(combinedCss), { rules: [], fontFaces: [], ruleCount: 0 });

  const structured = safe(() => readStructuredData(page.jsonLdBlocks), { name: null, logo: null });

  const colors = safe(
    () => extractColors({ rules: parsed.rules, inlineStyles: page.inlineStyles, metaByName: page.metaByName }),
    [] as ColorCandidate[],
  );
  const fonts = safe(
    () =>
      extractFonts({
        rules: parsed.rules,
        fontFaces: parsed.fontFaces,
        googleFontHrefs: page.googleFontHrefs,
        inlineStyles: page.inlineStyles,
      }),
    [] as FontCandidate[],
  );
  const logos = safe(() => extractLogos(page, base, structured), [] as LogoCandidate[]);
  const imagery = safe(() => extractImagery(page, parsed.rules, base), []);
  const identity = safe(() => extractIdentity(page, structured), { siteName: null, title: null, tagline: null });

  const aboutHtml = clampInput(typeof input?.aboutHtml === "string" ? input.aboutHtml : "");
  const aboutTokens = aboutHtml !== "" ? safe(() => tokenize(aboutHtml), []) : [];
  const aboutPage = aboutTokens.length > 0 ? safe(() => scanPage(aboutTokens), null) : null;
  const sourceText = safe(() => buildSourceText(page.textChunks, aboutPage?.textChunks ?? []), "");

  const htmlEmpty = !page.hadAnyTag;
  if (htmlEmpty) notes.push("No readable HTML tags were found on the page — nothing could be extracted from it.");
  if (cssAbsent) {
    notes.push(
      "No stylesheet was provided — colors and fonts were read from inline styles only, so the proposed palette may be partial.",
    );
  }
  if (base === null) notes.push("The page URL could not be read, so relative image and logo links could not be resolved to full URLs.");
  if (inputTruncated) notes.push("An input document exceeded the analyzer's size limit and was truncated — this read may be partial.");

  return {
    colors,
    fonts,
    logos,
    imagery,
    identity,
    voiceExtractionAvailable: false,
    sourceText,
    diagnostics: {
      htmlEmpty,
      cssAbsent,
      baseUrlUnusable: base === null,
      cssRulesParsed: parsed.ruleCount,
      notes,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Draft mapping                                                       */
/* ------------------------------------------------------------------ */

/** A hex that survives the skill's `normalizeHex`, else null — the single source of hex validity. */
function validHex(hex: string): string | null {
  try {
    return normalizeHex(hex);
  } catch {
    return null;
  }
}

function lightnessOfHex(hex: string): number {
  return rgbToHsl(hexToRgb(hex)).l;
}

/**
 * Build a font stack (`Family, fallback`) and validate it through the frozen
 * skill's OWN `validateFontStack` — the single source of truth for the
 * font-family grammar (its B1 CSS-injection gate). Returns null when the skill
 * would reject the stack (it throws), so this module can never emit a stack the
 * skill would later refuse, even if the skill tightens its grammar.
 */
function safeFontStack(family: string, fallback: "serif" | "sans-serif" | "monospace"): string | null {
  const f = family.trim();
  if (f === "") return null;
  const stack = `${f}, ${fallback}`;
  try {
    return validateFontStack(stack, "typography");
  } catch {
    return null;
  }
}

function pickDisplay(fonts: FontCandidate[]): FontCandidate | undefined {
  return fonts.find((f) => !f.generic && f.role === "display") ?? fonts.find((f) => !f.generic && (f.role === "unknown" || f.role === "display"));
}

function pickBody(fonts: FontCandidate[], displayFamily: string | undefined): FontCandidate | undefined {
  return (
    fonts.find((f) => !f.generic && f.role === "body") ??
    fonts.find((f) => !f.generic && f.role === "unknown" && f.family !== displayFamily) ??
    fonts.find((f) => !f.generic && f.family !== displayFamily)
  );
}

/**
 * Map ranked candidates onto a DRAFT `BrandKitInput` prefill. Review-only: no
 * build, no lock, no contrast gate. Every emitted color passes `normalizeHex`;
 * voice is empty with the honest `voiceNeedsAi` flag.
 *
 * No throw-guard here (unlike the untrusted-input orchestrator): this consumes
 * only this module's OWN typed output, and `normalizeHex`/`validateFontStack`
 * throws are already caught locally in `validHex`/`safeFontStack`.
 */
export function toBrandKitDraft(candidates: ExtractedBrandCandidates): BrandKitDraft {
  const notes: string[] = [];

  /* Colors ------------------------------------------------------------ */
  const validColors = candidates.colors
    .map((c) => ({ ...c, hex: validHex(c.hex) }))
    .filter((c): c is ColorCandidate => c.hex !== null);

  const accents = validColors.filter((c) => c.classification === "accent");
  const brandAccents = accents.filter((c) => c.roles.brandVariable);
  const accent = (brandAccents[0] ?? accents[0])?.hex;
  const accentSecondary = accents.find((c) => c.hex !== accent)?.hex;

  const neutrals = validColors.filter((c) => c.classification === "neutral");
  const surfaceCand =
    neutrals.filter((c) => c.roles.background).sort((a, b) => lightnessOfHex(b.hex) - lightnessOfHex(a.hex))[0] ??
    [...neutrals].sort((a, b) => lightnessOfHex(b.hex) - lightnessOfHex(a.hex))[0];
  const inkCand =
    neutrals.filter((c) => c.roles.text || c.roles.header).sort((a, b) => lightnessOfHex(a.hex) - lightnessOfHex(b.hex))[0] ??
    [...neutrals].sort((a, b) => lightnessOfHex(a.hex) - lightnessOfHex(b.hex))[0];
  const surface = surfaceCand?.hex;
  const ink = inkCand?.hex && inkCand.hex !== surface ? inkCand.hex : undefined;

  const colors: BrandKitDraft["colors"] = {};
  if (accent !== undefined) colors.accent = accent;
  if (accentSecondary !== undefined) colors.accentSecondary = accentSecondary;
  if (surface !== undefined) colors.surface = surface;
  if (ink !== undefined) colors.ink = ink;

  if (accent !== undefined) notes.push("Accent color proposed from the site's most prominent brand color (buttons, links, and brand variables). Review before saving.");
  else notes.push("No clear brand accent color was found — add the brand's main color before saving.");
  if (surface !== undefined || ink !== undefined) notes.push("Surface and text colors proposed from the site's dominant neutrals. Review before saving.");

  /* Typography -------------------------------------------------------- */
  const typography: BrandKitDraft["typography"] = {};
  const displayFont = pickDisplay(candidates.fonts);
  const displayStack = displayFont ? safeFontStack(displayFont.family, "sans-serif") : null;
  if (displayStack !== null) typography.display = displayStack;

  const bodyFont = pickBody(candidates.fonts, displayFont?.family);
  const bodyStack = bodyFont ? safeFontStack(bodyFont.family, "sans-serif") : null;
  if (bodyStack !== null) typography.body = bodyStack;

  const monoFont = candidates.fonts.find((f) => !f.generic && f.role === "mono");
  const monoStack = monoFont ? safeFontStack(monoFont.family, "monospace") : null;
  if (monoStack !== null) typography.mono = monoStack;

  if (displayStack !== null || bodyStack !== null) notes.push("Fonts proposed from the families used on the site's headings and body text. Review before saving.");

  /* Logo -------------------------------------------------------------- */
  const topLogo = candidates.logos.find(
    (l): l is LogoCandidate & { url: string } => l.url !== null && l.url.length <= LOGO_URL_MAX_CHARS,
  );
  const logoUrl = topLogo?.url;
  if (logoUrl !== undefined) notes.push("Logo proposed from the top-ranked logo candidate. Confirm it is the right asset before saving.");

  /* Voice — never fabricated ----------------------------------------- */
  notes.push("Brand voice was not auto-filled. Connect AI to summarize the site's copy into voice descriptors and samples.");

  const draft: BrandKitDraft = {
    colors,
    typography,
    voice: { descriptors: [], samples: [], do: [], dont: [] },
    voiceNeedsAi: true,
    notes,
  };
  if (logoUrl !== undefined) draft.logoUrl = logoUrl;
  return draft;
}
