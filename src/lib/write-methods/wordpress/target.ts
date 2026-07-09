/**
 * WordPress target grammar — which operations the WordPress write method
 * supports, and the PLAN-TIME reversibility gate (doc 04 §1 method 1, §2).
 *
 * A `ChangeTarget.locator` is method-specific (change-management treats it
 * opaquely); for WordPress the grammar is:
 *
 *   wp:post/{id}/title            wp:page/{id}/title
 *   wp:post/{id}/content          wp:page/{id}/content
 *   wp:post/{id}/meta/{key}       wp:page/{id}/meta/{key}
 *   wp:media/{id}/alt_text
 *
 * Why exactly this set (the doc 04 §1 on-page fix list, mapped to what the
 * wp/v2 REST surface can write AND restore byte-exact):
 *  - `title`    → the post/page title (standard themes render it as both the
 *                 <title> and the H1, so this carries the h1 + title fixes).
 *  - `content`  → post/page body (content fixes + in-body H1/heading rewrites).
 *  - `meta/{k}` → registered post-meta exposed via REST: meta descriptions,
 *                 canonicals, and schema JSON-LD all travel as meta keys owned
 *                 by the purpose-built AEO plugin or the site's SEO plugin
 *                 (e.g. `_yoast_wpseo_metadesc`) — which key is the GENERATE
 *                 side's decision, transport is identical.
 *  - `alt_text` → media-library alt text (the `alt` fix at the attachment).
 *
 * Deliberately NOT representable — and therefore rejected HERE, at plan time,
 * never discovered at rollback time (doc 04 §2: every write reversible by
 * exactly one action): slugs (URL-changing), status transitions, taxonomy,
 * post creation/deletion (a delete round-trips through trash with a new
 * state; a create has no before-state to restore). Same for VALUES that the
 * REST surface cannot restore byte-exact — see {@link assertReversibleValue}.
 *
 * The grammar is strict by construction: ids are digits, fields come from a
 * closed set, meta keys are `[A-Za-z0-9_-]` — a locator can never smuggle
 * path segments into the request URL.
 */

import type { ChangeTarget } from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import { WriteMethodError } from "../shared/errors";

const METHOD = "wordpress" as const;

/** A parsed, validated WordPress operation (the only writes this method performs). */
export type WordPressOperation =
  | { resource: "post" | "page"; id: number; field: "title" | "content" }
  | { resource: "post" | "page"; id: number; field: "meta"; metaKey: string }
  | { resource: "media"; id: number; field: "alt_text" };

/**
 * The full locator grammar in one pattern. Group 4 (meta key) only matches
 * when group 3 starts with `meta/`.
 */
const LOCATOR_GRAMMAR =
  /^wp:(post|page|media)\/([1-9]\d{0,9})\/(title|content|alt_text|meta\/([A-Za-z0-9_][A-Za-z0-9_-]{0,127}))$/;

const GRAMMAR_HINT =
  "expected wp:post|page/{id}/title|content|meta/{key} or wp:media/{id}/alt_text";

/**
 * Parse a ChangeTarget's locator into a WordPress operation, or refuse with a
 * typed `unsupported_operation`. This is the plan-time gate: anything the
 * method cannot write reversibly never reaches an HTTP call.
 */
export function parseWordPressTarget(target: ChangeTarget): WordPressOperation {
  const locator = target.locator;
  if (!locator) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `wordpress: the change target at ${target.url} has no locator — ${GRAMMAR_HINT}`,
    );
  }
  const match = LOCATOR_GRAMMAR.exec(locator);
  if (!match) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `wordpress: locator '${locator}' names no supported operation — ${GRAMMAR_HINT}; unsupported fields (slug, status, taxonomy, ...) are refused at plan time because they cannot be rolled back byte-exact`,
    );
  }

  const resource = match[1] as "post" | "page" | "media";
  const id = Number(match[2]);
  const field = match[3];

  if (resource === "media") {
    if (field !== "alt_text") {
      throw new WriteMethodError(
        METHOD,
        "unsupported_operation",
        `wordpress: locator '${locator}' — media items support only alt_text`,
      );
    }
    return { resource, id, field: "alt_text" };
  }

  if (field === "alt_text") {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `wordpress: locator '${locator}' — alt_text lives on media items (wp:media/{id}/alt_text), not on a ${resource}`,
    );
  }
  if (field === "title" || field === "content") {
    return { resource, id, field };
  }
  // Only the meta/{key} alternative remains; the key was captured by group 4.
  return { resource, id, field: "meta", metaKey: match[4] };
}

/** Human-readable coordinates for interface-voice messages ("post 42 title"). */
export function describeOperation(op: WordPressOperation): string {
  return op.field === "meta"
    ? `${op.resource} ${op.id} meta['${op.metaKey}']`
    : `${op.resource} ${op.id} ${op.field}`;
}

/** wp/v2 route for an operation, relative to the REST root. */
export function restRouteFor(op: WordPressOperation): string {
  const collection =
    op.resource === "post" ? "posts" : op.resource === "page" ? "pages" : "media";
  return `${collection}/${op.id}`;
}

/**
 * The byte-exactness gate on VALUES (doc 04 §2: if an operation cannot be
 * reversed byte-exact it is rejected at plan time, not discovered at rollback
 * time). Applied to BOTH sides of a write — an `after` we cannot install is
 * as fatal as a `before` we could not restore:
 *  - title/content/alt_text are strings on the REST surface; null (absence)
 *    is not installable — WordPress has no "no title" state to restore.
 *  - meta accepts any JSON value EXCEPT null: writing null deletes the key,
 *    and a deleted registered key reads back as its default (not null), so a
 *    null round-trip is not byte-exact.
 */
export function assertReversibleValue(
  op: WordPressOperation,
  value: Json,
  role: "before" | "after" | "live",
): void {
  if (op.field === "meta") {
    if (value === null) {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `wordpress: the ${role} state for ${describeOperation(op)} is null — deleting/absent meta does not round-trip byte-exact through the REST API, so this change is refused before any write`,
      );
    }
    return;
  }
  if (typeof value !== "string") {
    throw new WriteMethodError(
      METHOD,
      "invalid_value",
      `wordpress: the ${role} state for ${describeOperation(op)} must be a string (got ${value === null ? "null" : typeof value}) — a non-text value cannot be installed or restored byte-exact, so this change is refused before any write`,
    );
  }
}

/**
 * Plan-time validation for a whole write: the operation is supported AND both
 * directions are installable. GENERATE-side modules call this before
 * previewing so an irreversible change never even becomes a `site_changes`
 * row; the adapter re-runs the same checks internally (defense in depth).
 */
export function validateWordPressWrite(input: {
  target: ChangeTarget;
  before: Json;
  after: Json;
}): WordPressOperation {
  const op = parseWordPressTarget(input.target);
  assertReversibleValue(op, input.before, "before");
  assertReversibleValue(op, input.after, "after");
  return op;
}

/**
 * Locator builders — the GENERATE side composes locators through these, never
 * by string concatenation (typos become type errors or parse failures).
 */
export const wordpressLocators = {
  postTitle: (id: number) => `wp:post/${id}/title`,
  postContent: (id: number) => `wp:post/${id}/content`,
  postMeta: (id: number, key: string) => `wp:post/${id}/meta/${key}`,
  pageTitle: (id: number) => `wp:page/${id}/title`,
  pageContent: (id: number) => `wp:page/${id}/content`,
  pageMeta: (id: number, key: string) => `wp:page/${id}/meta/${key}`,
  mediaAltText: (id: number) => `wp:media/${id}/alt_text`,
} as const;
