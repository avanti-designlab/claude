/**
 * Cloudflare edge-worker target grammar — which operations the edge write
 * method supports, and the PLAN-TIME reversibility gate (doc 04 §1 method 2,
 * §2). Method value: `edge_worker`.
 *
 * A `ChangeTarget.locator` is method-specific (change-management treats it
 * opaquely); for the edge worker the grammar is:
 *
 *   edge:title                      edge:meta.description
 *   edge:canonical                  edge:jsonld/{scriptId}
 *   edge:img.alt/{base64url(src)}
 *
 * The page is `ChangeTarget.url`: its PATHNAME becomes the rule's exact-match
 * `path` (query strings and fragments are ignored by the worker; `/a` and
 * `/a/` are distinct pages). Rule identity is (operation, path,
 * discriminator) — derived deterministically into a manifest rule id — so a
 * write always addresses exactly one rule slot and two rules can never
 * overlap on the same slot: an upsert REPLACES its slot (the prior payload is
 * the captured before-state) and a removal restores whatever the before-state
 * says (a prior payload, or absence). Img srcs ride base64url-encoded in the
 * locator because raw URLs cannot be single grammar tokens.
 *
 * WHAT A VALUE IS ON THIS METHOD (the key difference from methods 1–3): a
 * target's value is the RULE'S state in the manifest, not any origin content —
 * this method never mutates origin content at all.
 *   - `null`  = no rule installed (the origin shows through untouched). Unlike
 *     WordPress/Webflow/Wix, null is a fully ROUND-TRIPPABLE state here:
 *     restoring it means removing the rule, byte-exact by construction.
 *   - a string (title text / meta content / canonical href / img alt) or a
 *     JSON object (JSON-LD) = a rule installing exactly that value.
 *
 * Deliberately NOT representable — rejected HERE at plan time, never
 * discovered at rollback time:
 *  - REGEX / string-replace rewrites. A patch applied to streamed origin HTML
 *    is not guaranteed idempotent (apply twice ≠ apply once) or invertible
 *    (the "before" depends on origin bytes this method never captures) — the
 *    manifest format itself has no such operation, so the class is
 *    structurally unwritable through any path.
 *  - Arbitrary CSS selectors. Each operation carries fixed selector semantics
 *    (see the manifest module); a free selector could straddle another rule's
 *    slot and break slot-exact restoration.
 *  - Replacing ORIGIN JSON-LD blocks. `jsonld/{scriptId}` addresses a block
 *    THIS worker injects (tagged with the rule id); origin blocks stay
 *    untouched — "which origin block is that" is not answerable reversibly.
 *  - noIndex/robots/redirect rules — indexing state machines whose downstream
 *    crawl effects a rule removal does not restore (same line Wix draws).
 *  - The `enabled:false` state: the adapter installs enabled rules or removes
 *    rules, nothing else. A rule found disabled (an ops kill-switch action
 *    outside the pipeline) is refused at read/write time — see
 *    {@link assertReversibleEdgeValue}'s adapter-side counterparts — because
 *    disabled-ness cannot ride in a `Json` diff value without ambiguity.
 */

import type { ChangeTarget } from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import {
  base64UrlDecode,
  base64UrlEncode,
  edgeRuleId,
  JSON_LD_SCRIPT_ID,
  type EdgeRule,
} from "../../../../workers/edge-autofix/src/manifest";
import { WriteMethodError } from "../shared/errors";

const METHOD = "edge_worker" as const;

/** A parsed, validated edge operation (the only rule slots this method writes). */
export type EdgeOperation =
  | { kind: "title" }
  | { kind: "meta_description" }
  | { kind: "canonical" }
  | { kind: "json_ld"; scriptId: string }
  | { kind: "img_alt"; src: string };

/** An operation resolved against its page: the rule slot a write addresses. */
export interface EdgeRuleAddress {
  op: EdgeOperation;
  /** Exact-match pathname from the target URL. */
  path: string;
  /** The manifest rule id this write upserts/removes — the slot. */
  ruleId: string;
}

const JSONLD_LOCATOR = /^edge:jsonld\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const IMG_ALT_LOCATOR = /^edge:img\.alt\/([A-Za-z0-9_-]{1,2048})$/;

const GRAMMAR_HINT =
  "expected edge:title, edge:meta.description, edge:canonical, edge:jsonld/{scriptId}, or edge:img.alt/{base64url-src} (regex/string-replace rewrites, free CSS selectors, origin-JSON-LD replacement, and robots/noIndex rules are not expressible — they cannot be rolled back byte-exact)";

/**
 * Parse a ChangeTarget into an edge rule address, or refuse with a typed
 * error. This is the plan-time gate: anything the method cannot write
 * reversibly never reaches an HTTP call. The page URL is screened for
 * embedded credentials and never echoed.
 */
export function parseEdgeTarget(target: ChangeTarget): EdgeRuleAddress {
  const path = pagePathOf(target);
  const locator = target.locator;
  if (!locator) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `edge_worker: the change target at ${target.url} has no locator — ${GRAMMAR_HINT}`,
    );
  }

  const op = parseLocator(locator);
  if (!op) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      `edge_worker: locator '${locator}' names no supported operation — ${GRAMMAR_HINT}`,
    );
  }
  return { op, path, ruleId: ruleIdFor(op, path) };
}

function parseLocator(locator: string): EdgeOperation | null {
  if (locator === "edge:title") return { kind: "title" };
  if (locator === "edge:meta.description") return { kind: "meta_description" };
  if (locator === "edge:canonical") return { kind: "canonical" };

  const jsonLd = JSONLD_LOCATOR.exec(locator);
  if (jsonLd) return { kind: "json_ld", scriptId: jsonLd[1] };

  const imgAlt = IMG_ALT_LOCATOR.exec(locator);
  if (imgAlt) {
    const src = base64UrlDecode(imgAlt[1]);
    // The decoded src must be a usable image address: non-empty, no control
    // characters, and — when absolute — free of userinfo (a URL is exactly
    // where a pasted credential lands; refused without echoing it).
    if (src === null || src.length === 0 || /[\u0000-\u001f\u007f]/.test(src)) {
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      try {
        const parsed = new URL(src);
        if (parsed.username || parsed.password) {
          throw new WriteMethodError(
            METHOD,
            "unsupported_operation",
            "edge_worker: the img.alt locator's image URL embeds credentials (userinfo) — credentials live in the secrets vault, never in a URL; refusing the operation before any request (the URL is not echoed)",
          );
        }
      } catch (err) {
        if (err instanceof WriteMethodError) throw err;
        return null;
      }
    }
    return { kind: "img_alt", src };
  }
  return null;
}

/** Derive the manifest rule id for an operation on a page (the slot). */
export function ruleIdFor(op: EdgeOperation, path: string): string {
  // The placeholder value never lands anywhere — ids derive from (op, path,
  // discriminator) only, and the discriminators live on `op`.
  return ruleFor(op, path, op.kind === "json_ld" ? {} : "").id;
}

/**
 * Build the manifest rule a non-null value installs (always enabled — the
 * adapter never writes the disabled state; see the header). Callers gate
 * `value` through {@link assertReversibleEdgeValue} first; the casts below
 * only re-state what that gate proved.
 */
export function ruleFor(op: EdgeOperation, path: string, value: Json): EdgeRule {
  switch (op.kind) {
    case "title": {
      const seed = {
        enabled: true,
        path,
        op: "set_title" as const,
        payload: { text: value as string },
      };
      return { ...seed, id: edgeRuleId(seed) };
    }
    case "meta_description": {
      const seed = {
        enabled: true,
        path,
        op: "set_meta_description" as const,
        payload: { content: value as string },
      };
      return { ...seed, id: edgeRuleId(seed) };
    }
    case "canonical": {
      const seed = {
        enabled: true,
        path,
        op: "set_canonical" as const,
        payload: { href: value as string },
      };
      return { ...seed, id: edgeRuleId(seed) };
    }
    case "json_ld": {
      const seed = {
        enabled: true,
        path,
        op: "upsert_json_ld" as const,
        payload: { scriptId: op.scriptId, json: value as { [k: string]: Json } },
      };
      return { ...seed, id: edgeRuleId(seed) };
    }
    case "img_alt": {
      const seed = {
        enabled: true,
        path,
        op: "set_img_alt" as const,
        payload: { src: op.src, alt: value as string },
      };
      return { ...seed, id: edgeRuleId(seed) };
    }
  }
}

/** Extract a stored rule's value — the Json a target reads back as. */
export function ruleValueOf(rule: EdgeRule): Json {
  switch (rule.op) {
    case "set_title":
      return rule.payload.text;
    case "set_meta_description":
      return rule.payload.content;
    case "set_canonical":
      return rule.payload.href;
    case "upsert_json_ld":
      return rule.payload.json;
    case "set_img_alt":
      return rule.payload.alt;
  }
}

/** Human-readable coordinates for interface-voice messages. */
export function describeEdgeOperation(address: EdgeRuleAddress): string {
  const op = address.op;
  switch (op.kind) {
    case "title":
      return `edge rule title @ ${address.path}`;
    case "meta_description":
      return `edge rule meta.description @ ${address.path}`;
    case "canonical":
      return `edge rule canonical @ ${address.path}`;
    case "json_ld":
      return `edge rule jsonld/${op.scriptId} @ ${address.path}`;
    case "img_alt":
      return `edge rule img.alt @ ${address.path}`;
  }
}

/**
 * The byte-exactness gate on VALUES (doc 04 §2), applied to BOTH sides of a
 * write. On this method `null` is legal on either side: it is the "no rule"
 * state, restorable byte-exact by removing the rule — the origin content
 * shows through untouched. Non-null values must be installable in the rule
 * payload grammar:
 *  - title / meta.description / img.alt → string;
 *  - canonical → string that parses as an absolute http(s) URL with no
 *    userinfo (a canonical pointing at a credential-bearing or relative URL
 *    is a misconfigured fix, refused before any write; the value is not
 *    echoed since malformed URLs are where credentials hide);
 *  - jsonld → a plain JSON object (the JSON-LD block). Arrays/primitives are
 *    refused: a schema block is one object; multiple schemas take multiple
 *    scriptId slots.
 * Manifest storage round-trips all of these byte-exact (verified on every
 * write), so no value-level normalization gate is needed beyond shape.
 */
export function assertReversibleEdgeValue(
  address: EdgeRuleAddress,
  value: Json,
  role: "before" | "after",
): void {
  if (value === null) return; // rule absent — always restorable on this method

  const op = address.op;
  if (op.kind === "json_ld") {
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `edge_worker: the ${role} state for ${describeEdgeOperation(address)} must be a JSON object (the JSON-LD block) or null (no rule) — got ${Array.isArray(value) ? "an array" : typeof value}; one scriptId slot carries one schema object`,
      );
    }
    return;
  }

  if (typeof value !== "string") {
    throw new WriteMethodError(
      METHOD,
      "invalid_value",
      `edge_worker: the ${role} state for ${describeEdgeOperation(address)} must be a string or null (no rule) — got ${typeof value}`,
    );
  }

  if (op.kind === "canonical") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `edge_worker: the ${role} state for ${describeEdgeOperation(address)} is not an absolute URL (the value is not echoed because malformed URLs can embed credentials) — a canonical must be the page's absolute http(s) address`,
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `edge_worker: the ${role} state for ${describeEdgeOperation(address)} must be an http(s) URL (the value is not echoed) — a canonical cannot use other schemes`,
      );
    }
    if (parsed.username || parsed.password) {
      throw new WriteMethodError(
        METHOD,
        "invalid_value",
        `edge_worker: the ${role} state for ${describeEdgeOperation(address)} embeds credentials (userinfo) — credentials live in the secrets vault, never in a URL; the value is not echoed`,
      );
    }
  }
}

/**
 * Plan-time validation for a whole write: the operation is supported AND both
 * directions are installable. GENERATE-side modules call this before
 * previewing so an irreversible change never even becomes a `site_changes`
 * row; the adapter re-runs the same checks internally (defense in depth).
 */
export function validateEdgeWrite(input: {
  target: ChangeTarget;
  before: Json;
  after: Json;
}): EdgeRuleAddress {
  const address = parseEdgeTarget(input.target);
  assertReversibleEdgeValue(address, input.before, "before");
  assertReversibleEdgeValue(address, input.after, "after");
  return address;
}

/**
 * The page URL is used for exactly one thing: its pathname names the rule's
 * page. It is parsed strictly (absolute http(s)) and screened for embedded
 * credentials — a userinfo-bearing or unparseable URL may itself carry a
 * secret, so it is refused and never echoed.
 */
function pagePathOf(target: ChangeTarget): string {
  let resolved: URL;
  try {
    resolved = new URL(target.url);
  } catch {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      "edge_worker: the change target's URL is not parseable — refused without being echoed (a malformed URL can embed credentials); the target must be the page's absolute http(s) address",
    );
  }
  if (resolved.username || resolved.password) {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      "edge_worker: the change target's URL embeds credentials (userinfo) — credentials live in the secrets vault (auth_ref), never in a URL; refusing the operation before any request",
    );
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    throw new WriteMethodError(
      METHOD,
      "unsupported_operation",
      "edge_worker: the change target's URL is not an http(s) page address (the value is not echoed) — the edge worker serves web pages only",
    );
  }
  return resolved.pathname;
}

/**
 * Locator builders — the GENERATE side composes locators through these, never
 * by string concatenation (typos become type errors or parse failures). The
 * img.alt builder base64url-encodes the src so it rides as one grammar token.
 */
export const edgeLocators = {
  title: () => "edge:title",
  metaDescription: () => "edge:meta.description",
  canonical: () => "edge:canonical",
  jsonLd: (scriptId: string) => `edge:jsonld/${scriptId}`,
  imgAlt: (src: string) => `edge:img.alt/${base64UrlEncode(src)}`,
} as const;

export { JSON_LD_SCRIPT_ID };
