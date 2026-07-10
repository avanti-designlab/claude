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
