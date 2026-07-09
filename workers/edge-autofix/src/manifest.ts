/**
 * edge-autofix rules manifest — THE wire format between the platform's
 * CloudflareEdgeAdapter (writer, `src/lib/write-methods/cloudflare/`) and the
 * per-client edge worker (reader, this package). One module defines it so the
 * two halves can never drift: the adapter imports these types/functions by
 * relative path, and this file deliberately imports NOTHING (it must be
 * bundleable into the worker without dragging app code along).
 *
 * Storage model (doc 04 §1 method 2, §5): each client domain gets its OWN
 * isolated worker and its OWN KV namespace; the namespace holds ONE value —
 * key {@link MANIFEST_KEY} — containing the entire versioned manifest as one
 * JSON document. One document = every rule change is a single atomic KV write
 * with a single monotonic version, which is what lets the adapter verify a
 * write byte-exact and detect concurrent writers loudly.
 *
 * The manifest format:
 *
 *   {
 *     "format": "edge-autofix/rules",   // never changes; foreign data fails parse
 *     "formatVersion": 1,               // bumped only on breaking format changes
 *     "version": 42,                    // monotonic; +1 per adapter write
 *     "updatedAt": "2026-07-09T...Z",   // adapter clock (injected, deterministic)
 *     "rules": [ EdgeRule, ... ]        // sorted by id (canonical serialization)
 *   }
 *
 * An EdgeRule is `{ id, enabled, path, op, payload }`:
 *  - `id` is DERIVED — always exactly {@link edgeRuleId}(rule). Rule identity
 *    is (operation, page path, discriminator), so two rules can never target
 *    the same slot: an upsert REPLACES its slot and a removal restores
 *    whatever the captured before-state says was there. Overlapping-selector
 *    ambiguity is structurally unrepresentable.
 *  - `path` is the page's URL pathname, matched EXACTLY by the worker
 *    (query strings and fragments are ignored; `/a` and `/a/` are distinct).
 *  - `enabled: false` rules are skipped by the worker (an ops kill-switch
 *    state — the adapter itself only ever installs enabled rules or removes
 *    rules, and refuses to operate through a disabled one).
 *  - `op`/`payload` name one idempotent SET-TO-VALUE rewrite. There is
 *    deliberately no regex-replace / string-patch operation in this grammar:
 *    a patch applied at the edge is not guaranteed idempotent or invertible,
 *    so the whole class is unrepresentable (doc 04 §2 reversibility).
 *
 * Parsing is STRICT and all-or-nothing ({@link parseManifest}): unknown ops,
 * malformed payloads, extra keys, duplicate ids, or an id that does not equal
 * its derivation make the WHOLE manifest invalid. The worker treats an invalid
 * manifest as "no manifest" and serves the origin untouched (fail OPEN); the
 * adapter treats it as foreign/corrupt storage and refuses to overwrite it
 * (fail LOUD). A manifest this module serialized always round-trips.
 */

/* ------------------------------------------------------------------ */
/* JSON (structural twin of the app's `Json`; no imports allowed here) */
/* ------------------------------------------------------------------ */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

/* ------------------------------------------------------------------ */
/* Format constants                                                    */
/* ------------------------------------------------------------------ */

/** The single KV key (per client namespace) the whole manifest lives under. */
export const MANIFEST_KEY = "manifest";

export const MANIFEST_FORMAT = "edge-autofix/rules";
export const MANIFEST_FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/**
 * The five operations, mapped to doc 04 §1's on-page fix list. Selector
 * semantics (what the worker matches on the streamed HTML):
 *  - `set_title`            → the `<title>` element (replaced; injected at
 *                             `</head>` if the page has none).
 *  - `set_meta_description` → `<meta name="description">`'s `content`
 *                             (name matched case-insensitively; injected at
 *                             `</head>` if the page has none).
 *  - `set_canonical`        → `<link rel="canonical">`'s `href` (rel matched
 *                             as a whitespace-separated token list; injected
 *                             at `</head>` if the page has none).
 *  - `upsert_json_ld`       → a JSON-LD `<script>` this worker INJECTS before
 *                             `</head>`, tagged `data-edge-autofix-rule` +
 *                             `data-edge-autofix-schema="{scriptId}"`. Origin
 *                             JSON-LD blocks are never touched — "replace"
 *                             means replacing this rule's own injected block
 *                             (the rule id is the slot).
 *  - `set_img_alt`          → the `alt` attribute of every `<img>` whose
 *                             `src` attribute equals `payload.src` byte-exact
 *                             (compared in the handler, not via a CSS
 *                             attribute selector, so no selector-escaping
 *                             ambiguity exists).
 */
export type EdgeRule =
  | EdgeRuleShape<"set_title", { text: string }>
  | EdgeRuleShape<"set_meta_description", { content: string }>
  | EdgeRuleShape<"set_canonical", { href: string }>
  | EdgeRuleShape<"upsert_json_ld", { scriptId: string; json: JsonObject }>
  | EdgeRuleShape<"set_img_alt", { src: string; alt: string }>;

export type EdgeRuleOp = EdgeRule["op"];

interface EdgeRuleShape<Op extends string, Payload> {
  /** Always exactly {@link edgeRuleId}(rule) — enforced at parse time. */
  id: string;
  enabled: boolean;
  /** Exact URL pathname this rule applies to. */
  path: string;
  op: Op;
  payload: Payload;
}

export interface EdgeRulesManifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  /** Monotonic write counter — +1 per adapter write, never reused. */
  version: number;
  /** ISO-8601 timestamp of the last adapter write. */
  updatedAt: string;
  rules: EdgeRule[];
}

/** JSON-LD script-slot ids: short opaque identifiers, grammar-pinned. */
export const JSON_LD_SCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Distributive Omit — keeps the op↔payload correlation of the union. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

/** An EdgeRule minus its derived id (what callers build; the id is minted). */
export type EdgeRuleSeed = DistributiveOmit<EdgeRule, "id">;

/** The identity coordinates an id derives from (op ↔ payload stay paired). */
export type EdgeRuleIdentity = DistributiveOmit<EdgeRule, "id" | "enabled">;

/**
 * Derive a rule's id from its identity coordinates. Deterministic and
 * collision-free by construction: the operation slug, the discriminator
 * (JSON-LD slot id / base64url-encoded img src — both `[A-Za-z0-9_-]`), and
 * the page path. Ids are what the adapter addresses writes by, and what the
 * worker reports in its verifiability header.
 */
export function edgeRuleId(rule: EdgeRuleIdentity): string {
  switch (rule.op) {
    case "set_title":
      return `title@${rule.path}`;
    case "set_meta_description":
      return `meta-description@${rule.path}`;
    case "set_canonical":
      return `canonical@${rule.path}`;
    case "upsert_json_ld":
      return `jsonld.${rule.payload.scriptId}@${rule.path}`;
    case "set_img_alt":
      return `img-alt.${base64UrlEncode(rule.payload.src)}@${rule.path}`;
  }
}

/* ------------------------------------------------------------------ */
/* base64url (UTF-8) — img srcs carry URL characters the id grammar    */
/* cannot; encoding keeps rule ids single-token and header-safe.       */
/* Dependency-free: works in workerd and Node alike.                   */
/* ------------------------------------------------------------------ */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64_ALPHABET[c & 0x3f];
  }
  return out;
}

/** Decode base64url back to the original string, or null if not valid. */
export function base64UrlDecode(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    const index = B64_ALPHABET.indexOf(char);
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Strict parse (all-or-nothing) + canonical serialization             */
/* ------------------------------------------------------------------ */

/**
 * Parse a stored manifest STRICTLY. Returns null on ANY deviation — not JSON,
 * wrong format/formatVersion, malformed rule, unknown op, extra keys,
 * duplicate ids, an id that isn't its own derivation. All-or-nothing: one bad
 * rule invalidates the whole document, because a partially-honored manifest
 * would make "which rules are live" unanswerable. The worker fails OPEN on
 * null; the adapter fails LOUD.
 */
export function parseManifest(text: string): EdgeRulesManifest | null {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  if (!hasExactKeys(value, ["format", "formatVersion", "version", "updatedAt", "rules"])) {
    return null;
  }
  if (value.format !== MANIFEST_FORMAT) return null;
  if (value.formatVersion !== MANIFEST_FORMAT_VERSION) return null;
  const version = value.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return null;
  }
  if (typeof value.updatedAt !== "string") return null;
  if (!Array.isArray(value.rules)) return null;

  const rules: EdgeRule[] = [];
  const ids = new Set<string>();
  for (const entry of value.rules) {
    const rule = parseRule(entry);
    if (!rule) return null;
    if (ids.has(rule.id)) return null;
    ids.add(rule.id);
    rules.push(rule);
  }

  return {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    updatedAt: value.updatedAt,
    rules,
  };
}

function parseRule(value: JsonValue): EdgeRule | null {
  if (!isJsonObject(value)) return null;
  if (!hasExactKeys(value, ["id", "enabled", "path", "op", "payload"])) {
    return null;
  }
  const { id, enabled, path, op, payload } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof enabled !== "boolean") return null;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (!isJsonObject(payload)) return null;

  let rule: EdgeRule;
  switch (op) {
    case "set_title":
      if (!hasExactKeys(payload, ["text"]) || typeof payload.text !== "string") {
        return null;
      }
      rule = { id, enabled, path, op, payload: { text: payload.text } };
      break;
    case "set_meta_description":
      if (
        !hasExactKeys(payload, ["content"]) ||
        typeof payload.content !== "string"
      ) {
        return null;
      }
      rule = { id, enabled, path, op, payload: { content: payload.content } };
      break;
    case "set_canonical":
      if (!hasExactKeys(payload, ["href"]) || typeof payload.href !== "string") {
        return null;
      }
      rule = { id, enabled, path, op, payload: { href: payload.href } };
      break;
    case "upsert_json_ld":
      if (
        !hasExactKeys(payload, ["scriptId", "json"]) ||
        typeof payload.scriptId !== "string" ||
        !JSON_LD_SCRIPT_ID.test(payload.scriptId) ||
        !isJsonObject(payload.json)
      ) {
        return null;
      }
      rule = {
        id,
        enabled,
        path,
        op,
        payload: { scriptId: payload.scriptId, json: payload.json },
      };
      break;
    case "set_img_alt":
      if (
        !hasExactKeys(payload, ["src", "alt"]) ||
        typeof payload.src !== "string" ||
        payload.src.length === 0 ||
        typeof payload.alt !== "string"
      ) {
        return null;
      }
      rule = {
        id,
        enabled,
        path,
        op,
        payload: { src: payload.src, alt: payload.alt },
      };
      break;
    default:
      return null;
  }

  // The id must be its own derivation — a hand-edited id (or a payload edited
  // out from under its id) invalidates the document.
  return edgeRuleId(rule) === rule.id ? rule : null;
}

/**
 * Canonical serialization: fixed key order, rules sorted by id, compact JSON.
 * The adapter writes ONLY this form and verifies its write by byte-comparing
 * the read-back value against it — canonicalization is what makes byte-exact
 * comparison meaningful.
 */
export function serializeManifest(manifest: EdgeRulesManifest): string {
  const rules = [...manifest.rules]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      path: rule.path,
      op: rule.op,
      payload: rule.payload,
    }));
  return JSON.stringify({
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    version: manifest.version,
    updatedAt: manifest.updatedAt,
    rules,
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}
