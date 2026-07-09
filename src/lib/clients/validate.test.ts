/**
 * Runtime-clamp suite for the onboarding payload (carried ticket c). Pure —
 * no mocks. Pins the review-gated properties:
 *  - the validator returns SANITIZED values (trimmed, unknown keys dropped) —
 *    callers persist `value`, never the raw input;
 *  - every cap refuses (interface voice), never silently truncates;
 *  - hostile non-string / non-array / non-Json shapes are refused, never
 *    thrown on (a cyclic geo must not crash the action);
 *  - the idempotency key is strict UUID v4 or refusal — junk never reaches
 *    Postgres (ticket a).
 */

import { describe, expect, it } from "vitest";
import type { CreateClientInput } from "./actions";
import {
  CLIENT_LOCATIONS_MAX,
  CLIENT_NAME_MAX_CHARS,
  CLIENT_VERTICAL_MAX_CHARS,
  isUuidV4,
  LOCATION_ADDRESS_MAX_CHARS,
  LOCATION_GEO_MAX_JSON_CHARS,
  LOCATION_NAME_MAX_CHARS,
  validateCreateClientInput,
} from "./validate";

const VALID_KEY = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const BASE: CreateClientInput = {
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  locations: [{ name: "North Park", address: "3814 Ray St, San Diego" }],
};

/** Build a hostile payload without fighting the compile-time type. */
function hostile(overrides: Record<string, unknown>): CreateClientInput {
  return { ...BASE, ...overrides } as unknown as CreateClientInput;
}

function expectRefusal(input: CreateClientInput, fragment: string) {
  const result = validateCreateClientInput(input);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(fragment);
}

function okValue(input: CreateClientInput) {
  const result = validateCreateClientInput(input);
  if (!result.ok) throw new Error(`expected ok:true, got: ${result.error}`);
  return result.value;
}

/* ------------------------------------------------------------------ */
/* happy path + sanitization                                           */
/* ------------------------------------------------------------------ */

describe("validateCreateClientInput — sanitization", () => {
  it("passes a well-formed payload through, trimmed", () => {
    const value = okValue(
      hostile({
        name: "  Gable & Grove Realty  ",
        vertical: " real-estate ",
        locations: [{ name: " North Park ", address: " Ray St " }],
      })
    );
    expect(value).toEqual({
      name: "Gable & Grove Realty",
      vertical: "real-estate",
      locations: [{ name: "North Park", address: "Ray St" }],
    });
    // No idempotencyKey in → no idempotencyKey out (older-caller behavior).
    expect("idempotencyKey" in value).toBe(false);
  });

  it("rebuilds location entries: unknown keys are dropped, never persisted", () => {
    const value = okValue(
      hostile({
        locations: [
          {
            name: "North Park",
            address: "Ray St",
            tenant_id: "tenant-evil",
            role: "agency_admin",
          },
        ],
      })
    );
    expect(value.locations[0]).toEqual({ name: "North Park", address: "Ray St" });
  });

  it("treats missing locations as an empty array (older callers)", () => {
    const value = okValue(hostile({ locations: undefined }));
    expect(value.locations).toEqual([]);
  });

  it("keeps a valid geo verbatim (any plain Json value, incl. null)", () => {
    const geo = { lat: 32.7484, lng: -117.1294, tags: ["hq", null], ok: true };
    const value = okValue(
      hostile({ locations: [{ name: "N", address: "A", geo }] })
    );
    expect(value.locations[0].geo).toEqual(geo);

    const nullGeo = okValue(
      hostile({ locations: [{ name: "N", address: "A", geo: null }] })
    );
    expect(nullGeo.locations[0].geo).toBeNull();
  });

  it("omits geo from the sanitized entry when absent", () => {
    const value = okValue(hostile({ locations: [{ name: "N", address: "A" }] }));
    expect("geo" in value.locations[0]).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* name / vertical caps                                                */
/* ------------------------------------------------------------------ */

describe("validateCreateClientInput — name and vertical", () => {
  it("keeps the frozen blank-field error copy", () => {
    expectRefusal(hostile({ name: "   " }), "Add a name for this client");
    expectRefusal(hostile({ vertical: " " }), "Pick an industry");
  });

  it("refuses non-string name/vertical with the blank-field copy (no throw)", () => {
    expectRefusal(hostile({ name: 42 }), "Add a name for this client");
    expectRefusal(hostile({ name: { evil: true } }), "Add a name");
    expectRefusal(hostile({ vertical: ["real-estate"] }), "Pick an industry");
  });

  it("accepts exactly the cap and refuses one past it", () => {
    expect(
      validateCreateClientInput(hostile({ name: "n".repeat(CLIENT_NAME_MAX_CHARS) }))
        .ok
    ).toBe(true);
    expectRefusal(
      hostile({ name: "n".repeat(CLIENT_NAME_MAX_CHARS + 1) }),
      `capped at ${CLIENT_NAME_MAX_CHARS} characters`
    );
    expect(
      validateCreateClientInput(
        hostile({ vertical: "v".repeat(CLIENT_VERTICAL_MAX_CHARS) })
      ).ok
    ).toBe(true);
    expectRefusal(
      hostile({ vertical: "v".repeat(CLIENT_VERTICAL_MAX_CHARS + 1) }),
      `capped at ${CLIENT_VERTICAL_MAX_CHARS} characters`
    );
  });
});

/* ------------------------------------------------------------------ */
/* locations array + entry shape                                       */
/* ------------------------------------------------------------------ */

describe("validateCreateClientInput — locations clamp", () => {
  const entry = { name: "N", address: "A" };

  it("refuses a non-array locations payload", () => {
    expectRefusal(hostile({ locations: { 0: entry } }), "locations");
    expectRefusal(hostile({ locations: "North Park" }), "locations");
  });

  it("accepts the location cap and refuses one past it", () => {
    expect(
      validateCreateClientInput(
        hostile({ locations: Array(CLIENT_LOCATIONS_MAX).fill(entry) })
      ).ok
    ).toBe(true);
    expectRefusal(
      hostile({ locations: Array(CLIENT_LOCATIONS_MAX + 1).fill(entry) }),
      `up to ${CLIENT_LOCATIONS_MAX} locations`
    );
  });

  it("refuses malformed entries: non-objects, arrays, missing/non-string fields", () => {
    for (const bad of [
      "North Park",
      42,
      null,
      [entry],
      { name: "N" },
      { address: "A" },
      { name: 7, address: "A" },
      { name: "N", address: { street: "A" } },
    ]) {
      expectRefusal(hostile({ locations: [bad] }), "locations couldn’t be read");
    }
  });

  it("caps per-location field lengths", () => {
    expect(
      validateCreateClientInput(
        hostile({
          locations: [
            {
              name: "n".repeat(LOCATION_NAME_MAX_CHARS),
              address: "a".repeat(LOCATION_ADDRESS_MAX_CHARS),
            },
          ],
        })
      ).ok
    ).toBe(true);
    expectRefusal(
      hostile({
        locations: [{ name: "n".repeat(LOCATION_NAME_MAX_CHARS + 1), address: "A" }],
      }),
      "couldn’t be read"
    );
    expectRefusal(
      hostile({
        locations: [
          { name: "N", address: "a".repeat(LOCATION_ADDRESS_MAX_CHARS + 1) },
        ],
      }),
      "couldn’t be read"
    );
  });

  it("refuses non-Json geo: functions, NaN/Infinity, class instances, deep nesting, cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic; // JSON.stringify would throw — must refuse, not crash

    let deep: unknown = "leaf";
    for (let i = 0; i < 7; i += 1) deep = { next: deep };

    for (const geo of [
      () => "evil",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      deep,
      cyclic,
    ]) {
      expectRefusal(
        hostile({ locations: [{ name: "N", address: "A", geo }] }),
        "couldn’t be read"
      );
    }
  });

  it("caps geo's serialized size", () => {
    const fits = { blob: "g".repeat(LOCATION_GEO_MAX_JSON_CHARS - 20) };
    expect(
      validateCreateClientInput(
        hostile({ locations: [{ name: "N", address: "A", geo: fits }] })
      ).ok
    ).toBe(true);
    const oversize = { blob: "g".repeat(LOCATION_GEO_MAX_JSON_CHARS) };
    expectRefusal(
      hostile({ locations: [{ name: "N", address: "A", geo: oversize }] }),
      "couldn’t be read"
    );
  });
});

/* ------------------------------------------------------------------ */
/* idempotency key (ticket a)                                          */
/* ------------------------------------------------------------------ */

describe("validateCreateClientInput — idempotency key", () => {
  it("accepts a strict UUID v4 (either case) and carries it through", () => {
    expect(okValue(hostile({ idempotencyKey: VALID_KEY })).idempotencyKey).toBe(
      VALID_KEY
    );
    const upper = VALID_KEY.toUpperCase();
    expect(okValue(hostile({ idempotencyKey: upper })).idempotencyKey).toBe(upper);
  });

  it("refuses anything that is not a UUID v4 — junk never reaches Postgres", () => {
    for (const bad of [
      "not-a-uuid",
      "",
      "9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d", // v1 version nibble
      "9b1deb4d-3b7d-4bad-7bdd-2b0d7b3dcb6d", // bad variant nibble
      "9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d", // no dashes
      `${VALID_KEY}'; drop table clients;--`,
      42,
      { key: VALID_KEY },
      null,
    ]) {
      expectRefusal(hostile({ idempotencyKey: bad }), "looked malformed");
    }
  });
});

describe("isUuidV4", () => {
  it("matches only the v4 shape", () => {
    expect(isUuidV4(VALID_KEY)).toBe(true);
    expect(isUuidV4(VALID_KEY.toUpperCase())).toBe(true);
    expect(isUuidV4("9b1deb4d-3b7d-1bad-9bdd-2b0d7b3dcb6d")).toBe(false);
    expect(isUuidV4("zb1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
    expect(isUuidV4(42)).toBe(false);
  });
});
