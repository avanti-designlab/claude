/**
 * Brand-extract — identity facts + source copy (pure).
 *
 * Identity is BASIC FACTS only — site name (`og:site_name` / `application-name` /
 * structured-data Organization name), the raw `<title>`, and a tagline
 * (`meta description` / `og:description`). No interpretation, no summarization.
 *
 * `sourceText` is the cleaned visible copy (home + about, nav/footer excluded)
 * that a LATER LLM step will summarize into a brand voice. This module EXPOSES
 * that raw text and flags `voiceExtractionAvailable: false`; it deliberately does
 * NOT attempt any voice/tone summarization — that needs the deferred Anthropic
 * seam and would be a fabrication here.
 */

import type { PageModel } from "./html-scan";
import type { StructuredData } from "./logos";
import type { ExtractedIdentity } from "./types";

export const MAX_SOURCE_TEXT_CHARS = 20_000;

export function extractIdentity(page: PageModel, structured: StructuredData): ExtractedIdentity {
  const siteName =
    firstNonEmpty(page.metaByName.get("og:site_name"), page.metaByName.get("application-name"), structured.name) ?? null;
  const tagline = firstNonEmpty(page.metaByName.get("og:description"), page.metaDescription ?? undefined) ?? null;
  return {
    siteName,
    title: page.title,
    tagline,
  };
}

/**
 * Build the raw voice-material copy from home + about text chunks. Bounded and
 * whitespace-normalized; NOT summarized (that is the deferred LLM step's job).
 */
export function buildSourceText(homeChunks: string[], aboutChunks: string[]): string {
  const parts: string[] = [];
  let chars = 0;
  for (const chunk of [...homeChunks, ...aboutChunks]) {
    if (chars >= MAX_SOURCE_TEXT_CHARS) break;
    const room = MAX_SOURCE_TEXT_CHARS - chars;
    const clipped = chunk.length > room ? chunk.slice(0, room) : chunk;
    parts.push(clipped);
    chars += clipped.length + 1; // +1 for the joining space
  }
  return parts.join(" ").trim();
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}
