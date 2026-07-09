/**
 * M10 schema generation — the crawl → skill visible-text bridge (doc 05 M10,
 * doc 07 §1.5).
 *
 * The schema-generation skill's hard rule 1 ("schema must match the visible
 * page text exactly") is enforced INSIDE the skill: `generateSchema` takes a
 * `visiblePageText` string and verifies every user-visible claim against it.
 * M10 does NOT re-implement that match — it decides, honestly and in ONE place,
 * WHICH rendered surfaces of a crawled page count as "visible text" and hands
 * that corpus to the skill.
 *
 * WHAT COUNTS AS VISIBLE (this boundary is the whole point of the gate — get it
 * wrong and the gate blesses facts a user never sees):
 *  - `visibleText` — the rendered body an AI crawler that does not run JS sees
 *    (headings, paragraphs, lists, FAQ Q/A, prices, addresses, phone numbers).
 *    The primary and authoritative surface (src/lib/intelligence/crawl/extract).
 *  - `h1s` — already contained in `visibleText` (headings ARE body text in the
 *    extractor); re-joined defensively — harmless in a substring corpus.
 *  - `title` — the `<title>`. INCLUDED because it is genuinely user-visible
 *    (browser tab + the clickable SERP headline) and conventionally mirrors an
 *    on-page name, so an Organization/LocalBusiness/Person name that lives in the
 *    title is a legitimate visible claim, not an overclaim.
 *
 * DELIBERATELY EXCLUDED:
 *  - `metaDescription` — NOT rendered on the page (SERP-only). Matching schema
 *    against it would defeat the gate: it would bless a claim no visitor sees.
 *    This exclusion is the honesty guard.
 *  - `jsonLdBlocks` — existing structured data is not visible text; matching new
 *    schema against the page's OLD schema would let one overclaim ride on
 *    another. The page's rendered content is the only source of truth.
 */

import type { ExtractedDoc } from "@/lib/intelligence/crawl";

/**
 * Build the "visible page text" corpus M10 hands the skill's match gate.
 *
 * Accepts either a crawl-layer {@link ExtractedDoc} (the normal path — M10 sits
 * downstream of the M2 crawler) or a raw string, for callers that already hold
 * the rendered text of a page they are producing (e.g. an FAQ page whose Q/A the
 * content module just wrote). A string passes through verbatim; the skill still
 * runs the full match against it.
 *
 * Surfaces are newline-joined (a separator the normalizer collapses) and empty
 * fields are dropped, so no phantom whitespace ever pads the corpus. The result
 * may legitimately be empty (a blank page) — the skill then rejects with
 * `EMPTY_VISIBLE_TEXT`, which is correct: nothing is verifiable, so nothing ships.
 */
export function buildVisibleCorpus(source: ExtractedDoc | string): string {
  if (typeof source === "string") return source;

  const parts: string[] = [];
  if (source.title !== null && source.title !== "") parts.push(source.title);
  for (const h1 of source.h1s) {
    if (h1 !== "") parts.push(h1);
  }
  if (source.visibleText !== "") parts.push(source.visibleText);
  return parts.join("\n");
}
