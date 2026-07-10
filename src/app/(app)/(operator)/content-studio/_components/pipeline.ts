/**
 * Content Studio — pure, server-safe presentation constants shared by the page
 * (server) and its client islands (the brief form + the draft-advance button).
 * NO server-only imports and NO client hooks, so both layers can import it. Only
 * TYPE imports from the data layer (erased at build), plus the M8 GENERATABLE
 * set so the brief form's type options can never drift from the engine contract.
 *
 * Deliberately QUIET (doc 06 §4/§5 — operator module UIs are utilitarian). NO
 * internal module codes ever reach a rendered label (doc 06 §6).
 */

import type { ContentItemStatus, ContentItemType } from "@/lib/types/db";
import type { GeneratableContentType } from "@/lib/production/content/types";

/**
 * Plain-language copy for the three types M8 GENERATES (blog | faq | pillar).
 * Keyed off `GeneratableContentType`, so if the engine's generatable set ever
 * changes the type checker forces this map to keep up. Captions are the social
 * pipeline's (M11) and schema copy is assembled markup — neither is offered here.
 */
export const CONTENT_TYPE_META: Record<
  GeneratableContentType,
  { label: string; blurb: string }
> = {
  blog: {
    label: "Blog post",
    blurb: "An article structured for AI answers, in the client's brand voice.",
  },
  faq: {
    label: "FAQ page",
    blurb: "Common questions rewritten as direct, citable answers.",
  },
  pillar: {
    label: "Pillar page",
    blurb: "A long-form, evergreen resource that anchors a topic.",
  },
};

/**
 * Card noun for ANY content type — defensive across the full `content_items.type`
 * column so a caption / schema_copy row from another module never renders a raw
 * DB token if one turns up in a client's pipeline.
 */
export const TYPE_NOUN: Record<ContentItemType, string> = {
  blog: "Blog post",
  faq: "FAQ",
  caption: "Social caption",
  pillar: "Pillar page",
  schema_copy: "Schema copy",
};

export type PillTone = "muted" | "accent" | "positive" | "warm" | "negative";

export const STATUS_LABEL: Record<ContentItemStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  needs_revision: "In revision",
  approved: "Approved",
  published: "Published",
};

export const STATUS_TONE: Record<ContentItemStatus, PillTone> = {
  draft: "muted",
  in_review: "accent",
  needs_revision: "warm",
  approved: "positive",
  published: "positive",
};

/** A datetime, or an honest em-dash when the stamp isn't parseable — never faked.
 *  Fixed "en-US" locale so the server-rendered card text is deterministic. */
const DATE_TIME_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export function medDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_TIME_MED.format(t) : "—";
}

/** Where every deferred-vendor honest state points. */
export const CONNECTIONS_HREF = "/connections";
