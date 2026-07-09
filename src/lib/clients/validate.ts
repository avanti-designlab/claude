/**
 * Runtime clamp for the onboarding client payload (carried ticket c,
 * BUILD-STATE real-data-slice gate record).
 *
 * TypeScript stops at the compiler: a server action is a public RPC endpoint,
 * and a hostile caller can POST any JSON shape it likes regardless of
 * `CreateClientInput`. This module is the runtime backstop at the write seam —
 * shape-check, trim, and length-cap every field BEFORE anything reaches
 * Postgres, and refuse non-conforming payloads with interface-voice errors
 * (doc 06 §6: what happened + what to do, never a raw Postgres string).
 *
 * Deliberately a small pure validator, not a schema library (proportionate to
 * one payload): zero dependencies, unit-tested in the default `npm test` run,
 * and the caps live next to the seam they guard. This layer only keeps junk
 * out of jsonb columns and error paths — RLS remains the isolation boundary
 * (doc 03 §4), and the DB's own CHECKs (migration 0003) still back it up.
 *
 * The validator RETURNS the sanitized value: fields trimmed, unknown keys on
 * location entries dropped. Callers must persist `value`, never the raw input.
 */

import type { ClientLocation, Json } from "@/lib/types/db";
import type { CreateClientInput } from "./actions";

/* ------------------------------------------------------------------ */
/* Caps (the clamp's single source of truth — tests import these)      */
/* ------------------------------------------------------------------ */

export const CLIENT_NAME_MAX_CHARS = 200;
export const CLIENT_VERTICAL_MAX_CHARS = 200;
export const CLIENT_LOCATIONS_MAX = 50;
export const LOCATION_NAME_MAX_CHARS = 200;
export const LOCATION_ADDRESS_MAX_CHARS = 500;
/** Cap on `geo` measured on its JSON serialization — bounds strings, arrays and objects alike. */
export const LOCATION_GEO_MAX_JSON_CHARS = 2000;
/** Nesting cap for `geo`; also terminates on cyclic structures (which JSON.stringify would throw on). */
const GEO_MAX_DEPTH = 6;

/* ------------------------------------------------------------------ */
/* UUID v4 (the idempotency-key shape — ticket a)                      */
/* ------------------------------------------------------------------ */

/** Strict v4: version nibble '4', variant nibble 8/9/a/b. Postgres compares uuids case-insensitively, so both cases pass. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/* ------------------------------------------------------------------ */
/* Validation result                                                   */
/* ------------------------------------------------------------------ */

/** The sanitized payload the write path may persist (and nothing else). */
export interface ValidClientInput {
  name: string;
  vertical: string;
  locations: ClientLocation[];
  idempotencyKey?: string;
}

export type ClientInputValidation =
  | { ok: true; value: ValidClientInput }
  | { ok: false; error: string };

function refuse(error: string): ClientInputValidation {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* The clamp                                                           */
/* ------------------------------------------------------------------ */

export function validateCreateClientInput(
  input: CreateClientInput
): ClientInputValidation {
  // Hostile JSON ignores the compile-time type — treat every field as unknown.
  const raw = input as unknown as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) {
    return refuse("Add a name for this client before saving.");
  }
  if (name.length > CLIENT_NAME_MAX_CHARS) {
    return refuse(
      `Client names are capped at ${CLIENT_NAME_MAX_CHARS} characters — shorten this one and try again.`
    );
  }

  const vertical = typeof raw.vertical === "string" ? raw.vertical.trim() : "";
  if (!vertical) {
    return refuse("Pick an industry for this client before saving.");
  }
  if (vertical.length > CLIENT_VERTICAL_MAX_CHARS) {
    return refuse(
      `Industry names are capped at ${CLIENT_VERTICAL_MAX_CHARS} characters — shorten this one and try again.`
    );
  }

  // Absent locations stay valid (older callers send none) — but if the key is
  // present it must actually be an array within the cap.
  const rawLocations = raw.locations ?? [];
  if (!Array.isArray(rawLocations)) {
    return refuse(
      "We couldn’t read this client’s locations. Remove and re-add them, then save again."
    );
  }
  if (rawLocations.length > CLIENT_LOCATIONS_MAX) {
    return refuse(
      `A client can have up to ${CLIENT_LOCATIONS_MAX} locations — remove some and try again.`
    );
  }
  const locations: ClientLocation[] = [];
  for (const entry of rawLocations) {
    const location = sanitizeLocation(entry);
    if (!location) {
      return refuse(
        "One of this client’s locations couldn’t be read. Remove and re-add it, then save again."
      );
    }
    locations.push(location);
  }

  if (raw.idempotencyKey !== undefined) {
    // Strict UUID-v4 or refusal — never pass junk to Postgres (ticket a). The
    // key is browser-minted (crypto.randomUUID()), so anything else is a
    // hostile or broken caller, not a user mistake.
    if (!isUuidV4(raw.idempotencyKey)) {
      return refuse(
        "That save request looked malformed, so we didn’t run it. Refresh the page and try again."
      );
    }
    return {
      ok: true,
      value: { name, vertical, locations, idempotencyKey: raw.idempotencyKey },
    };
  }

  return { ok: true, value: { name, vertical, locations } };
}

/**
 * One location entry → the exact `ClientLocation` shape ({name, address,
 * geo?}) or null. Rebuilt field-by-field so unknown keys never reach the
 * jsonb column.
 */
function sanitizeLocation(entry: unknown): ClientLocation | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.address !== "string") {
    return null;
  }
  const name = record.name.trim();
  const address = record.address.trim();
  if (
    name.length > LOCATION_NAME_MAX_CHARS ||
    address.length > LOCATION_ADDRESS_MAX_CHARS
  ) {
    return null;
  }
  if (record.geo === undefined) {
    return { name, address };
  }
  // geo is doc-silent (refined by M14 at 1.6) so any Json VALUE is accepted —
  // but it must genuinely be one: plain data, finite numbers, bounded depth
  // (which also rejects cycles before JSON.stringify could throw on them),
  // bounded serialized size.
  if (!isJsonValue(record.geo, GEO_MAX_DEPTH)) {
    return null;
  }
  if (JSON.stringify(record.geo).length > LOCATION_GEO_MAX_JSON_CHARS) {
    return null;
  }
  return { name, address, geo: record.geo };
}

/** True iff `value` is plain JSON data: no class instances, no functions, no NaN/Infinity, no depth abuse. */
function isJsonValue(value: unknown, depth: number): value is Json {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value as number);
  if (depth <= 0) return false;
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth - 1));
  }
  if (kind === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) =>
      isJsonValue(item, depth - 1)
    );
  }
  return false;
}
