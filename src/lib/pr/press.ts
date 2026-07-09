/**
 * M12 PR entity-leverage — on-page entity mention + Press-section READINESS
 * assessment (doc 05 M12; task deliverable 2). PURE.
 *
 * Assesses whether the client's OWN site establishes entity authority:
 *   - is the key person (founder/principal) present on the page + in Person
 *     schema (with a `sameAs`)?
 *   - is there a Press / "As Featured In" surface, and are the client's claimed
 *     press items actually corroborated in the page's visible text?
 *
 * HONESTY-FIRST (task point 4): an uncrawlable site yields a `not_assessable`
 * verdict — never a fabricated "no press" score. A claimed press item whose
 * publication is NOT mentioned on the page is flagged `mentionedOnPage: false`
 * (never asserted as authority). Detection is deliberately CONSERVATIVE
 * (curated multi-word markers + exact short-heading matches; the M14 transcript-
 * marker discipline) — a false positive would hand out unearned authority.
 *
 * FIDELITY BOUNDARY (documented, not hidden): this reads the crawl's per-page
 * VISIBLE TEXT + headings + raw JSON-LD block strings. The audit crawl drops
 * off-origin hrefs (CrawledPage carries only internalLinks), so press
 * corroboration is by TEXT MENTION of the publication/domain label — link-level
 * corroboration (an actual outbound link to the article) is not available from
 * this crawl surface. Person-schema detection is a conservative raw-string
 * signal (a block containing `"@type"` + `"Person"`), not a full JSON-LD parse.
 */

import type { CrawledSite } from "@/lib/skills/aeo-audit";
import type {
  PersonEntityAssessment,
  PressItemAssessment,
  PressSurfaceAssessment,
} from "./types";

/* ------------------------------------------------------------------ */
/* Corpus + label helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * The crawled visible-text corpus: per page, its title + H1s + visible text,
 * joined. This is what the M10 visible-text gate checks entity names against and
 * what press corroboration searches. Mirrors M14's `siteVisibleCorpus`.
 */
export function buildEntityCorpus(site: CrawledSite): string {
  const parts: string[] = [];
  for (const page of site.pages) {
    if (page.title !== null && page.title !== "") parts.push(page.title);
    for (const h1 of page.h1s) parts.push(h1);
    if (page.visibleText !== "") parts.push(page.visibleText);
  }
  return parts.join("\n");
}

/**
 * Derive a searchable publication label from a press item value — a URL's
 * registrable second-level label (e.g. "https://www.forbes.com/x" → "forbes",
 * "https://nar.realtor/y" → "nar"), or a trimmed plain name lowercased
 * ("Forbes" → "forbes"). Returns null for an empty/unusable value.
 */
export function publicationLabel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".").filter((l) => l !== "");
    if (labels.length === 0) return null;
    // Second-level label: for "forbes.com" → "forbes"; for "a.co.uk" → "a".
    // The registrable label is the strongest single token to search for.
    return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  } catch {
    // Not a URL — a plain publication name; use the whole normalized string.
    return trimmed.toLowerCase();
  }
}

/** Case-insensitive substring presence, empty-safe. */
function mentions(corpus: string, needle: string | null): boolean {
  if (needle === null || needle === "") return false;
  return corpus.toLowerCase().includes(needle.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Press-section markers (conservative)                                */
/* ------------------------------------------------------------------ */

/** Multi-word markers of an "As Featured In"/press surface — specific on purpose. */
const PRESS_SECTION_MARKERS: readonly string[] = [
  "as featured in",
  "as seen in",
  "as seen on",
  "featured in",
  "in the press",
  "in the news",
  "press coverage",
  "media coverage",
  "media mentions",
  "press mentions",
];

/** Exact short-heading labels that establish a press surface (matched on H1s). */
const PRESS_HEADING_LABELS: ReadonlySet<string> = new Set([
  "press",
  "media",
  "news",
  "in the news",
  "press & media",
  "media & press",
]);

/** True when the crawled site shows a conservative Press / "As Featured In" surface. */
export function detectPressSection(site: CrawledSite): boolean {
  const corpus = buildEntityCorpus(site).toLowerCase();
  for (const marker of PRESS_SECTION_MARKERS) {
    if (corpus.includes(marker)) return true;
  }
  for (const page of site.pages) {
    for (const h1 of page.h1s) {
      if (PRESS_HEADING_LABELS.has(h1.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Person-schema signal (conservative raw-string detection)            */
/* ------------------------------------------------------------------ */

/**
 * Whether the site already carries a Person JSON-LD block, and whether that
 * block declares a `sameAs`. Conservative raw-string signal (not a full parse):
 * a block containing both `"@type"` and `"Person"` counts as Person present; a
 * Person block additionally containing `"sameAs"` counts as sameAs present. An
 * author-Person inside an Article still counts (it is a real entity signal).
 */
export function personSchemaSignals(site: CrawledSite): { present: boolean; withSameAs: boolean } {
  let present = false;
  let withSameAs = false;
  for (const page of site.pages) {
    for (const block of page.jsonLdBlocks) {
      if (block.includes('"@type"') && block.includes("Person")) {
        present = true;
        if (block.includes("sameAs")) withSameAs = true;
      }
    }
  }
  return { present, withSameAs };
}

/* ------------------------------------------------------------------ */
/* Assessment builders (pure)                                          */
/* ------------------------------------------------------------------ */

export interface AssessPersonInput {
  /** The claimed key person (founder/principal) — operator-entered, or null. */
  keyPersonName: string | null;
  corpus: string;
  /** False when the site had no crawlable pages (on-site verdict withheld). */
  corpusAssessable: boolean;
  personSchema: { present: boolean; withSameAs: boolean };
}

/** Assess the key-person entity surface on the client's own site (honesty-first). */
export function assessPersonEntity(input: AssessPersonInput): PersonEntityAssessment {
  const name = input.keyPersonName !== null && input.keyPersonName.trim() !== "" ? input.keyPersonName.trim() : null;
  const notes: string[] = [];

  if (name === null) {
    notes.push("No key person (founder/principal) supplied — the person entity surface was not assessed.");
    return {
      status: "no_key_person",
      keyPersonName: null,
      namePresentOnPage: false,
      personSchemaPresent: input.personSchema.present,
      sameAsPresentInSchema: input.personSchema.withSameAs,
      notes,
    };
  }

  if (!input.corpusAssessable) {
    notes.push("Site had no crawlable pages — on-site person presence was not assessed (verdict withheld, not fabricated).");
    return {
      status: "not_assessable",
      keyPersonName: name,
      namePresentOnPage: false,
      personSchemaPresent: input.personSchema.present,
      sameAsPresentInSchema: input.personSchema.withSameAs,
      notes,
    };
  }

  const namePresentOnPage = mentions(input.corpus, name);
  if (!namePresentOnPage) {
    notes.push(`"${name}" does not appear in the site's visible text — Person schema asserting this name would be rejected by the visible-text gate until it does.`);
  }
  if (!input.personSchema.present) {
    notes.push("No Person JSON-LD found on the site — the key-person entity is not yet machine-resolvable.");
  } else if (!input.personSchema.withSameAs) {
    notes.push("Person schema is present but carries no sameAs — the highest-value entity signal (press/profiles) is missing.");
  }

  return {
    status: "assessed",
    keyPersonName: name,
    namePresentOnPage,
    personSchemaPresent: input.personSchema.present,
    sameAsPresentInSchema: input.personSchema.withSameAs,
    notes,
  };
}

/** One claimed press item (operator-entered). Publication and/or URL. */
export interface ClaimedPressItem {
  publication?: string;
  url?: string;
}

export interface AssessPressInput {
  claimedPress: ClaimedPressItem[];
  corpus: string;
  /** False when the site had no crawlable pages (on-site verdict withheld). */
  corpusAssessable: boolean;
  pressSectionPresent: boolean;
}

/** Assess the press surface + corroborate each claimed press item on-page. */
export function assessPressSurface(input: AssessPressInput): PressSurfaceAssessment {
  const notes: string[] = [];

  if (!input.corpusAssessable) {
    notes.push("Site had no crawlable pages — the press surface and on-page corroboration were not assessed.");
    return {
      status: "not_assessable",
      pressSectionPresent: false,
      claimedPress: [],
      corroboratedCount: 0,
      claimedCount: input.claimedPress.length,
      notes,
    };
  }

  const claimedPress: PressItemAssessment[] = [];
  let corroborated = 0;
  for (const item of input.claimedPress) {
    const url = typeof item.url === "string" && item.url.trim() !== "" ? item.url.trim() : null;
    const rawPublication = typeof item.publication === "string" ? item.publication.trim() : "";
    // Prefer the operator-entered publication name; else derive a label from the URL.
    const label = rawPublication !== "" ? publicationLabel(rawPublication) : url !== null ? publicationLabel(url) : null;
    const publication = rawPublication !== "" ? rawPublication : label ?? (url ?? "(unnamed press item)");
    const mentionedOnPage = mentions(input.corpus, label);
    if (mentionedOnPage) corroborated++;
    claimedPress.push({
      publication,
      url,
      mentionedOnPage,
      note: mentionedOnPage
        ? "This publication is mentioned in the site's visible text — corroborated on-page."
        : "This publication is NOT mentioned in the site's visible text — flagged; it is not asserted as on-page authority until the site references it.",
    });
  }

  if (!input.pressSectionPresent && input.claimedPress.length > 0) {
    notes.push('No "As Featured In" / press surface was detected, though press items were supplied — building one would surface existing authority.');
  }

  return {
    status: "assessed",
    pressSectionPresent: input.pressSectionPresent,
    claimedPress,
    corroboratedCount: corroborated,
    claimedCount: input.claimedPress.length,
    notes,
  };
}
