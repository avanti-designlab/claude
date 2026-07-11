/**
 * Brand-extract — public API.
 *
 * The deterministic, vendor-free analyzer behind a future "paste the client's
 * URL → propose a draft brand kit" flow. Pure: no network, no fetch, no vendor/
 * LLM, no DOM, no `Date.now`/`Math.random`. It consumes the RAW MATERIALS a
 * gated fetch layer will later hand it (HTML + CSS strings) and proposes ranked
 * brand candidates; `toBrandKitDraft` maps the top candidates onto the frozen
 * M7 ingest input shape as a review-only DRAFT (it never builds/locks/contrast-
 * gates a kit). Voice is NOT summarized here — that needs the deferred Anthropic
 * seam; the raw copy is exposed as `sourceText` with `voiceExtractionAvailable:
 * false`. The fetch wiring and the UI are separate, later, gated slices.
 */

export { extractBrandCandidates, toBrandKitDraft } from "./extract";

// The HTML tokenizer is part of the public surface: the fetch adapter reuses it
// to find <link rel=stylesheet> hrefs in the ONE page it scans for stylesheets,
// so stylesheet discovery and the engine's own scan can never disagree on how
// HTML parses. Pure, like everything else exported here.
export { tokenize } from "./html-scan";
export type {
  HtmlCloseToken,
  HtmlOpenToken,
  HtmlTextToken,
  HtmlToken,
} from "./html-scan";

export type {
  BrandKitDraft,
  ColorCandidate,
  ColorClassification,
  ColorRoleSignals,
  ExtractDiagnostics,
  ExtractedBrandCandidates,
  ExtractedIdentity,
  ExtractInput,
  FontCandidate,
  FontRole,
  FontSourceKind,
  ImageryCandidate,
  ImageryKind,
  LogoCandidate,
  LogoKind,
} from "./types";
