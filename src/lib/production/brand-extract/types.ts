/**
 * Brand-extract — public shapes.
 *
 * The deterministic, vendor-free parsing brain behind a future "paste the
 * client's URL → propose a draft brand kit" flow. This module takes the RAW
 * MATERIALS a gated fetch layer will later hand it (HTML + CSS strings) and
 * proposes RANKED brand CANDIDATES — colors, typography, logos, imagery,
 * identity — plus the raw copy a LATER LLM step will summarize into voice.
 *
 * It NEVER fetches, NEVER calls a vendor/LLM, NEVER touches the DOM, and NEVER
 * summarizes voice. Everything it emits is a candidate the operator reviews;
 * `toBrandKitDraft` maps the top candidates onto the frozen M7 ingest input
 * shape as a DRAFT — it does not build, lock, or contrast-gate a kit.
 */

import type { BrandColorInput, BrandTypographyInput } from "@/lib/skills/brand-kit";

/* ------------------------------------------------------------------ */
/* Input — the raw materials from a (later, gated) fetch layer          */
/* ------------------------------------------------------------------ */

export interface ExtractInput {
  /** The page's raw HTML string (home/landing page). Untrusted. */
  html: string;
  /**
   * Absolute http(s) URL of the page — used ONLY to resolve relative asset URLs
   * (URL as data, never dereferenced). When unusable, relative assets cannot be
   * resolved and are surfaced honestly with a null URL.
   */
  pageUrl: string;
  /**
   * CSS text blobs the fetch layer collected (linked stylesheet contents AND
   * `<style>` block contents). Optional — when absent/empty, extraction falls
   * back to inline `style=""` attributes plus any `<style>` blocks embedded in
   * the HTML itself.
   */
  cssBlobs?: string[];
  /** Optional second page's HTML (e.g. an About page). Its visible copy joins `sourceText`. */
  aboutHtml?: string;
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

/** Which prominent roles a color (or a near-duplicate collapsed into it) was seen on. */
export interface ColorRoleSignals {
  /** Backgrounds (page/section/hero chrome). */
  background: boolean;
  /** Button / CTA fills or text. */
  button: boolean;
  /** Heading (h1–h6) text color. */
  header: boolean;
  /** Link text color. */
  link: boolean;
  /** Body/paragraph text color. */
  text: boolean;
  /** Borders / outlines. */
  border: boolean;
  /** Seen in a brand-named custom property (`--accent`, `--primary`, `--brand`…) or `theme-color`. */
  brandVariable: boolean;
  /** Seen in an inline `style=""` attribute. */
  inline: boolean;
}

export type ColorClassification = "accent" | "neutral";

export interface ColorCandidate {
  /** Normalized lowercase `#rrggbb` — a valid `normalizeHex` output. */
  hex: string;
  /** Total raw occurrences (near-duplicate frequencies merged in). */
  frequency: number;
  roles: ColorRoleSignals;
  /** `accent` = chromatic/brand-ish; `neutral` = grayscale or near-black/near-white. */
  classification: ColorClassification;
}

/* ------------------------------------------------------------------ */
/* Typography                                                          */
/* ------------------------------------------------------------------ */

export type FontRole = "display" | "body" | "mono" | "unknown";
export type FontSourceKind = "css-selector" | "font-face" | "google-fonts-link" | "inline-style";

export interface FontCandidate {
  /** Cleaned primary family name (surrounding quotes stripped). */
  family: string;
  role: FontRole;
  /** Distinct sources this family was seen in (canonical order). */
  sources: FontSourceKind[];
  /** Reference count across declarations/links. */
  frequency: number;
  /** True when the family name is itself a generic CSS keyword (serif/sans-serif/monospace/…). */
  generic: boolean;
}

/* ------------------------------------------------------------------ */
/* Logos + imagery                                                     */
/* ------------------------------------------------------------------ */

export type LogoKind =
  | "header-img"
  | "nav-img"
  | "structured-data"
  | "inline-svg"
  | "apple-touch-icon"
  | "icon-link"
  | "og-image";

export interface LogoCandidate {
  kind: LogoKind;
  /** Resolved absolute URL, or null for an inline SVG / unresolvable reference (honestly, not fabricated). */
  url: string | null;
  /** Short operator-facing reason for the ranking (plain language — no internal codes). */
  reason: string;
}

export type ImageryKind = "og-image" | "twitter-image" | "hero-image" | "hero-background";

export interface ImageryCandidate {
  kind: ImageryKind;
  url: string;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface ExtractedIdentity {
  /** `og:site_name` / `application-name` / structured-data Organization name. */
  siteName: string | null;
  /** Raw `<title>` (may include " | Brand" suffixes — not split here). */
  title: string | null;
  /** `meta description` / `og:description` — a tagline candidate. */
  tagline: string | null;
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

export interface ExtractDiagnostics {
  /** No parseable tags in the page HTML — an honestly empty read. */
  htmlEmpty: boolean;
  /** No CSS blobs were provided — colors/fonts fell back to inline styles + embedded `<style>`. */
  cssAbsent: boolean;
  /** The page URL was unusable — relative asset URLs could not be resolved to absolute. */
  baseUrlUnusable: boolean;
  /** Rules parsed from the combined CSS (bounded). */
  cssRulesParsed: number;
  /** Operator-facing honest notes about what could/couldn't be read. */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Top-level output                                                    */
/* ------------------------------------------------------------------ */

export interface ExtractedBrandCandidates {
  /** Ranked palette (most brand-prominent first), deduped + near-duplicates collapsed. */
  colors: ColorCandidate[];
  /** Ranked font-family candidates with a display/body/mono heuristic. */
  fonts: FontCandidate[];
  /** Ranked logo candidates, best first; each with a resolved absolute URL (or null) + a reason. */
  logos: LogoCandidate[];
  /** Imagery candidates (og:image, hero images) with resolved absolute URLs. */
  imagery: ImageryCandidate[];
  identity: ExtractedIdentity;
  /**
   * ALWAYS false in this pure module: voice/tone is NOT summarized here — that
   * needs the deferred Anthropic seam. `sourceText` carries the raw material.
   */
  voiceExtractionAvailable: false;
  /** Cleaned visible copy (home + about, nav/footer excluded), bounded — raw material for a later voice summary. */
  sourceText: string;
  diagnostics: ExtractDiagnostics;
}

/* ------------------------------------------------------------------ */
/* Draft (the seam the UI/ingest will consume)                         */
/* ------------------------------------------------------------------ */

export interface BrandKitDraft {
  /**
   * Prefill for `BrandKitInput.colors` (skill `BrandColorInput`). `accent` is
   * the skill's ONLY required color — left undefined when no chromatic candidate
   * was found (the operator supplies it; we never fabricate one). Every value is
   * a valid `normalizeHex` output; anything failing the grammar was dropped.
   */
  colors: Partial<BrandColorInput>;
  /** Prefill for `BrandKitInput.typography` (skill `BrandTypographyInput`) — top display/body/mono families. */
  typography: Partial<BrandTypographyInput>;
  /** Prefill for `BrandKitInput.logoUrl` — the top logo candidate with an addressable URL, else omitted. */
  logoUrl?: string;
  /** Prefill for `BrandKitInput.voice` — ALWAYS empty here (see `voiceNeedsAi`). */
  voice: { descriptors: string[]; samples: string[]; do: string[]; dont: string[] };
  /** Honest flag: voice was NOT auto-filled — connect AI to summarize `sourceText` into it. */
  voiceNeedsAi: true;
  /** Operator-facing provenance for each prefilled field (plain language — no internal codes). */
  notes: string[];
}
