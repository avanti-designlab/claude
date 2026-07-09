/**
 * Webflow target grammar — which operations the Webflow write method supports,
 * and the PLAN-TIME reversibility gate (doc 04 §1 method 1 "build second", §2).
 *
 * A `ChangeTarget.locator` is method-specific (change-management treats it
 * opaquely); for Webflow the grammar is:
 *
 *   webflow:page/{pageId}/seo.title          webflow:page/{pageId}/og.title
 *   webflow:page/{pageId}/seo.description    webflow:page/{pageId}/og.description
 *   webflow:item/{collectionId}/{itemId}/field/{fieldSlug}
 *
 * Why exactly this set (the doc 04 §1 on-page fix list, mapped to what the
 * Webflow Data API v2 can write AND restore byte-exact):
 *  - `seo.title` / `seo.description` → the page's <title> tag and meta
 *    description (Pages API `seo` object) — the title + meta fixes.
 *  - `og.title` / `og.description`   → Open Graph fields (Pages API
 *    `openGraph` object). Round-trippable ONLY while the page's mirror flag
 *    (`titleCopied` / `descriptionCopied`) is OFF — a mirrored OG value is
 *    DERIVED from the SEO field, and the flag itself cannot be restored
 *    byte-exact alongside the value in a single-field write. The adapter
 *    verifies the flag pre-write and refuses mirrored pages.
 *  - `field/{fieldSlug}` → one CMS item field (Collections/Items API
 *    `fieldData`) — schema/FAQ-bearing rich-text and plain-text fields,
 *    H1-feeding `name` fields, canonical-bearing plain fields. Which field
 *    carries which fix is the GENERATE side's decision; transport is identical.
 *
 * Deliberately NOT representable — and therefore rejected HERE, at plan time,
 * never discovered at rollback time (doc 04 §2: every write reversible by
 * exactly one action):
 *  - PUBLISHING. Every write this method performs lands in Webflow's STAGED
 *    state; the LIVE site changes only when the site is published. A publish
 *    cannot round-trip byte-exact (rolling one back would have to restore both
 *    the prior content AND the prior publish state — which items/pages were
 *    live, `lastPublished`, ... — and the API cannot re-install a past publish
 *    state). So no locator can express a publish, the adapter never calls the
 *    publish or `/items/{id}/live` endpoints, and going live stays with the
 *    change-management pipeline's explicit publish flow.
 *  - Page `title` (the designer-facing page name) and page `slug` — the name
 *    is not the SEO surface (the <title> fix is `seo.title`), and the slug is
 *    URL-changing.
 *  - The item `slug` field — URL-changing AND server-normalized (Webflow
 *    lowercases/hyphenates what you send), so the value written is not the
 *    value stored: a byte-exact round-trip is structurally impossible.
 *    Explicitly refused even though `field/{fieldSlug}` would match it.
 *  - Locale variants. The grammar has no locale slot: reads and writes both
 *    use the un-parameterized endpoints, so both sides of every round-trip hit
 *    the same (primary) locale. A secondary-locale fix is not expressible —
 *    supporting it safely needs a locale-pinned grammar + per-locale
 *    verification, a deliberate later extension, not an accidental write.
 *  - `isDraft` / `isArchived` flips — state transitions, not fieldData; they
 *    also change what the next publish does. Unreachable by the grammar.
 *
 * Same for VALUES the API cannot restore byte-exact — see
 * {@link assertReversibleWebflowValue}.
 *
 * The grammar is strict by construction: ids are exactly 24 lowercase hex
 * characters (Webflow's object-id format — uppercase is refused rather than
 * silently aliasing the same id twice), field slugs are Webflow's own
 * lowercase `[a-z0-9-]` shape — a locator can never smuggle path segments
 * into the request URL.
 */

import type { ChangeTarget } from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import { WriteMethodError } from "../shared/errors";

const METHOD = "webflow" as const;

/** A parsed, validated Webflow operation (the only writes this method performs). */
export type WebflowOperation =
  | {
      kind: "page";
      pageId: string;
      group: "seo" | "og";
      attr: "title" | "description";
    }
  | { kind: "item"; collectionId: string; itemId: string; fieldSlug: string };

/**
 * The full locator grammar in one pattern. Groups 1–3 match the page form,
 * groups 4–6 the item form; exactly one form matches.
 */
const LOCATOR_GRAMMAR =
  /^webflow:(?:page\/([0-9a-f]{24})\/(seo|og)\.(title|description)|item\/([0-9a-f]{24})\/([0-9a-f]{24})\/field\/([a-z0-9][a-z0-9-]{0,63}))$/;

const GRAMMAR_HINT =
  "expected webflow:page/{pageId}/seo.title|seo.description|og.title|og.description or webflow:item/{collectionId}/{itemId}/field/{fieldSlug} (ids are 24 lowercase hex characters)";

/**
 * Parse a ChangeTarget's locator into a Webflow operation, or refuse with a
 * typed `unsupported_operation`. This is the plan-time gate: anything the
 * method cannot write reversibly never reaches an HTTP call.
 */
export function parseWebflowTarget(target: ChangeTarget): WebflowOperation {
  const locator = target.locator;
  if (!locator) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `webflow: the change target at ${target.url} has no locator — ${GRAMMAR_HINT}`,
    );
  }
  const match = LOCATOR_GRAMMAR.exec(locator);
  if (!match) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `webflow: locator '${locator}' names no supported operation — ${GRAMMAR_HINT}; publishing, page name/slug, locale variants, and draft/archive flips are refused at plan time because they cannot be rolled back byte-exact`,
    );
  }

  if (match[1]) {
    return {
      kind: "page",
      pageId: match[1],
      group: match[2] as "seo" | "og",
      attr: match[3] as "title" | "description",
    };
  }

  const fieldSlug = match[6];
  if (fieldSlug === "slug") {
    // The one grammar-shaped field that can never round-trip: Webflow
    // server-normalizes slugs (lowercase/hyphenate), so the stored value is
    // not the written value — and it is URL-changing besides.
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `webflow: locator '${locator}' targets the item's slug field — slugs are URL-changing AND server-normalized by Webflow, so a byte-exact round-trip is impossible; refused at plan time`,
    );
  }
  return { kind: "item", collectionId: match[4], itemId: match[5], fieldSlug };
}

/** Human-readable coordinates for interface-voice messages. */
export function describeWebflowOperation(op: WebflowOperation): string {
  return op.kind === "page"
    ? `page ${op.pageId} ${op.group}.${op.attr}`
    : `item ${op.collectionId}/${op.itemId} field['${op.fieldSlug}']`;
}

/** Data API v2 route for an operation, relative to the `/v2` API root. */
export function webflowRouteFor(op: WebflowOperation): string {
  return op.kind === "page"
    ? `pages/${op.pageId}`
    : `collections/${op.collectionId}/items/${op.itemId}`;
}

/**
 * The byte-exactness gate on VALUES (doc 04 §2: if an operation cannot be
 * reversed byte-exact it is rejected at plan time, not discovered at rollback
 * time). Applied to BOTH sides of a write — an `after` we cannot install is
 * as fatal as a `before` we could not restore:
 *  - page SEO/OG fields are strings on the API surface. null/absence ("the
 *    page has no meta description yet") is NOT installable: the PATCH schema
 *    takes strings only, so a rollback could never restore the true 'unset'
 *    state — and unset vs empty-string are DISTINCT observable states (an
 *    unset seo.title falls back to the page name; an empty one does not).
 *    Adding a first-ever SEO field therefore is not a supported operation of
 *    this method; it stays a manual/Designer fix.
 *  - item fields accept any JSON value EXCEPT null: Webflow omits unset
 *    optional fields from `fieldData` entirely, so "no value" cannot be
 *    written back verifiably — clearing a field does not round-trip. (Numbers,
 *    booleans, rich-text HTML strings, reference ids, and multi-reference
 *    arrays all echo byte-exact and are verified against the write's echo.)
 */
export function assertReversibleWebflowValue(
  op: WebflowOperation,
  value: Json,
  role: "before" | "after" | "live",
): void {
  if (op.kind === "page") {
    if (typeof value !== "string") {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `webflow: the ${role} state for ${describeWebflowOperation(op)} must be a string (got ${value === null ? "null — the field is unset" : typeof value}) — Webflow's page-metadata PATCH installs strings only, so an unset field cannot be restored byte-exact (unset and empty are distinct states Webflow renders differently); this change is refused before any write`,
      );
    }
    return;
  }
  if (value === null) {
    throw new WriteMethodError(
      METHOD,
      "invalid_value",
      `webflow: the ${role} state for ${describeWebflowOperation(op)} is null/unset — the Items API cannot clear a field back to 'no value' verifiably (unset fields are omitted from fieldData entirely), so this change does not round-trip byte-exact and is refused before any write`,
    );
  }
}

/**
 * Plan-time validation for a whole write: the operation is supported AND both
 * directions are installable. GENERATE-side modules call this before
 * previewing so an irreversible change never even becomes a `site_changes`
 * row; the adapter re-runs the same checks internally (defense in depth).
 */
export function validateWebflowWrite(input: {
  target: ChangeTarget;
  before: Json;
  after: Json;
}): WebflowOperation {
  const op = parseWebflowTarget(input.target);
  assertReversibleWebflowValue(op, input.before, "before");
  assertReversibleWebflowValue(op, input.after, "after");
  return op;
}

/**
 * Locator builders — the GENERATE side composes locators through these, never
 * by string concatenation (typos become type errors or parse failures).
 */
export const webflowLocators = {
  pageSeoTitle: (pageId: string) => `webflow:page/${pageId}/seo.title`,
  pageSeoDescription: (pageId: string) =>
    `webflow:page/${pageId}/seo.description`,
  pageOgTitle: (pageId: string) => `webflow:page/${pageId}/og.title`,
  pageOgDescription: (pageId: string) =>
    `webflow:page/${pageId}/og.description`,
  itemField: (collectionId: string, itemId: string, fieldSlug: string) =>
    `webflow:item/${collectionId}/${itemId}/field/${fieldSlug}`,
} as const;
