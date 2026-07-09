/**
 * Wix target grammar — which operations the Wix write method supports, and
 * the PLAN-TIME reversibility gate (doc 04 §1 method 1 "build third", §2).
 *
 * A `ChangeTarget.locator` is method-specific (change-management treats it
 * opaquely); for Wix the grammar is:
 *
 *   wix:page/{pageId}/seo.title          wix:page/{pageId}/seo.description
 *   wix:data/{collectionId}/{itemId}/field/{fieldKey}
 *
 * Why exactly this set (the doc 04 §1 on-page fix list, mapped to what the
 * Wix REST surface can write AND restore byte-exact — doc 04 calls Wix "the
 * most walled-garden of the four", and this grammar takes that at its word):
 *  - `seo.title` / `seo.description` → the page's <title> tag and meta
 *    description (the page's SEO settings object) — the title + meta fixes.
 *    Round-trippable ONLY while the field is explicitly SET: an unset field
 *    INHERITS the site-level SEO pattern ({Page name} | {Site name}), so its
 *    value is DERIVED — writing a first-ever explicit value could never be
 *    rolled back to "inherit". The adapter refuses unset fields pre-write.
 *  - `field/{fieldKey}` → one field of a Wix Data (CMS) collection item —
 *    schema/FAQ-bearing rich-text, JSON-LD objects, plain-text and numeric
 *    fields. Which field carries which fix is the GENERATE side's decision;
 *    transport is identical.
 *
 * Deliberately NOT representable — and therefore rejected HERE, at plan time,
 * never discovered at rollback time (doc 04 §2: every write reversible by
 * exactly one action):
 *  - SYSTEM FIELDS. Wix Data items carry server-managed fields (`_id`,
 *    `_owner`, `_createdDate`, `_updatedDate`, and anything else Wix adds to
 *    the underscore namespace). None round-trips (`_updatedDate` changes on
 *    every write by definition), so the field-key grammar structurally cannot
 *    start with an underscore — the whole class is unwritable, forever,
 *    including system fields that do not exist yet.
 *  - APP COLLECTIONS. Wix-app collections are namespaced with a slash
 *    (`Stores/Products`, `Members/PrivateMembersData`); their fields are
 *    app-managed and server-normalized (price formats, membership state, ...).
 *    The collection-id grammar has no slash, so an app collection is not
 *    expressible — CMS fixes stay inside client-owned collections.
 *  - Page URI/slug/rename — URL-changing; not an SEO-field fix.
 *  - `noIndex` / robots directives / redirects — indexing state machines
 *    whose downstream effects (crawl state) cannot be restored by re-writing
 *    a flag; a deliberate later extension, not an accidental write.
 *  - The page's structured-data / advanced-SEO TAG LIST — Wix models these as
 *    an ordered, server-deduplicated list, not a single field; a single-field
 *    round-trip is not defined on it. Schema/JSON-LD travels through Wix Data
 *    fields instead (or stays a manual fix).
 *  - Item creation/deletion and collection operations — a create has no
 *    before-state to restore; a delete cannot be un-deleted byte-exact.
 *  - There is NO publish operation to exclude: the Wix surfaces this method
 *    writes have no staged layer at all — every apply is LIVE the moment the
 *    API accepts it. See the adapter header for what that means for safety.
 *
 * Same for VALUES the API cannot restore byte-exact — see
 * {@link assertReversibleWixValue}.
 *
 * The grammar is strict by construction: page ids are Wix's short opaque
 * tokens (`[A-Za-z0-9][A-Za-z0-9_-]`), collection ids are slash-free
 * identifiers, item ids cover Wix's GUID default plus safe custom ids, and
 * field keys are identifier-shaped with no underscore start — a locator can
 * never smuggle path segments (or a system field) into a request.
 */

import type { ChangeTarget } from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import { WriteMethodError } from "../shared/errors";

const METHOD = "wix" as const;

/** A parsed, validated Wix operation (the only writes this method performs). */
export type WixOperation =
  | { kind: "page"; pageId: string; attr: "title" | "description" }
  | { kind: "data"; collectionId: string; itemId: string; fieldKey: string };

/**
 * The full locator grammar in one pattern. Groups 1–2 match the page form,
 * groups 3–5 the data-item form; exactly one form matches. Field keys cannot
 * start with `_` — that single character class is what makes the entire
 * system-field family (`_id`, `_owner`, `_updatedDate`, ...) unwritable.
 */
const LOCATOR_GRAMMAR =
  /^wix:(?:page\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/seo\.(title|description)|data\/([A-Za-z][A-Za-z0-9_-]{0,127})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/field\/([A-Za-z][A-Za-z0-9_]{0,63}))$/;

const GRAMMAR_HINT =
  "expected wix:page/{pageId}/seo.title|seo.description or wix:data/{collectionId}/{itemId}/field/{fieldKey} (collection ids are slash-free — app collections are not writable; field keys cannot start with '_' — system fields are not writable)";

/**
 * Parse a ChangeTarget's locator into a Wix operation, or refuse with a
 * typed `unsupported_operation`. This is the plan-time gate: anything the
 * method cannot write reversibly never reaches an HTTP call.
 */
export function parseWixTarget(target: ChangeTarget): WixOperation {
  const locator = target.locator;
  if (!locator) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `wix: the change target at ${target.url} has no locator — ${GRAMMAR_HINT}`,
    );
  }
  const match = LOCATOR_GRAMMAR.exec(locator);
  if (!match) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `wix: locator '${locator}' names no supported operation — ${GRAMMAR_HINT}; page uri/rename, noIndex/robots flags, the structured-data tag list, system fields, and app collections are refused at plan time because they cannot be rolled back byte-exact`,
    );
  }

  if (match[1]) {
    return {
      kind: "page",
      pageId: match[1],
      attr: match[2] as "title" | "description",
    };
  }
  return {
    kind: "data",
    collectionId: match[3],
    itemId: match[4],
    fieldKey: match[5],
  };
}

/** Human-readable coordinates for interface-voice messages. */
export function describeWixOperation(op: WixOperation): string {
  return op.kind === "page"
    ? `page ${op.pageId} seo.${op.attr}`
    : `item ${op.collectionId}/${op.itemId} field['${op.fieldKey}']`;
}

/**
 * The byte-exactness gate on VALUES (doc 04 §2: if an operation cannot be
 * reversed byte-exact it is rejected at plan time, not discovered at rollback
 * time). Applied to BOTH sides of a write — an `after` we cannot install is
 * as fatal as a `before` we could not restore:
 *  - page SEO fields are strings on the API surface. null/absence ("the page
 *    has no explicit title yet") is NOT installable: an unset field INHERITS
 *    the site-level SEO pattern, so unset and empty-string are DISTINCT
 *    observable states and a rollback could never restore the true "inherit"
 *    state. Adding a first-ever explicit SEO field therefore is not a
 *    supported operation of this method; it stays a manual/Editor fix.
 *  - data fields accept any JSON value EXCEPT null: Wix Data distinguishes an
 *    explicitly-null field from an absent one, but our persisted diff payload
 *    (Json) cannot — `null` in `diff.before` would be ambiguous between the
 *    two, so neither state can be restored VERIFIABLY. The unset-vs-empty
 *    ambiguity is closed by refusing both sides at plan time. (Strings,
 *    numbers, booleans, JSON-LD objects, and arrays all echo byte-exact and
 *    are verified against the write's echo.)
 */
export function assertReversibleWixValue(
  op: WixOperation,
  value: Json,
  role: "before" | "after" | "live",
): void {
  if (op.kind === "page") {
    if (typeof value !== "string") {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `wix: the ${role} state for ${describeWixOperation(op)} must be a string (got ${value === null ? "null — the field is unset and inherits the site's SEO pattern" : typeof value}) — an unset field's value is derived from the site-level pattern and cannot be restored byte-exact (unset and empty are distinct states Wix renders differently); this change is refused before any write`,
      );
    }
    return;
  }
  if (value === null) {
    throw new WriteMethodError(
      METHOD,
      "invalid_value",
      `wix: the ${role} state for ${describeWixOperation(op)} is null — Wix Data distinguishes an explicitly-null field from an absent one, and the persisted diff cannot, so a null state can never be restored verifiably; this change does not round-trip byte-exact and is refused before any write`,
    );
  }
}

/**
 * Plan-time validation for a whole write: the operation is supported AND both
 * directions are installable. GENERATE-side modules call this before
 * previewing so an irreversible change never even becomes a `site_changes`
 * row; the adapter re-runs the same checks internally (defense in depth).
 */
export function validateWixWrite(input: {
  target: ChangeTarget;
  before: Json;
  after: Json;
}): WixOperation {
  const op = parseWixTarget(input.target);
  assertReversibleWixValue(op, input.before, "before");
  assertReversibleWixValue(op, input.after, "after");
  return op;
}

/**
 * Locator builders — the GENERATE side composes locators through these, never
 * by string concatenation (typos become type errors or parse failures).
 */
export const wixLocators = {
  pageSeoTitle: (pageId: string) => `wix:page/${pageId}/seo.title`,
  pageSeoDescription: (pageId: string) => `wix:page/${pageId}/seo.description`,
  dataField: (collectionId: string, itemId: string, fieldKey: string) =>
    `wix:data/${collectionId}/${itemId}/field/${fieldKey}`,
} as const;
