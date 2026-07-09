/**
 * M3 query-set derivation suite (derive.ts).
 *
 * What must hold: derivation is deterministic; a `[token]` is substituted
 * ONLY from real client facts (name, locations); templates that would need
 * invented data are EXCLUDED and reported; "near me" prompts get a market or
 * get excluded; truncation is honest. A thin playbook yields a small set,
 * never a padded one.
 */

import { describe, expect, it } from "vitest";
import {
  cannabisPlaybook,
  ecommercePlaybook,
  realEstatePlaybook,
  restaurantsPlaybook,
} from "@/lib/playbooks";
import type { Playbook } from "@/lib/types/playbook";
import {
  deriveQuerySet,
  MAX_TRACKED_QUERIES,
  type TrackedClientFacts,
} from "./derive";

const GG: TrackedClientFacts = {
  name: "Gable & Grove Realty",
  locations: [
    { name: "Dubai", address: "1 Marina Walk, Dubai" },
    { name: "Abu Dhabi", address: "2 Corniche Rd, Abu Dhabi" },
  ],
};

function syntheticPlaybook(
  promptLibrary: Playbook["prompt_library"]
): Playbook {
  return {
    ...realEstatePlaybook,
    vertical: "synthetic",
    prompt_library: promptLibrary,
  };
}

describe("deriveQuerySet — honesty rules", () => {
  it("derives the real-estate set: resolvable templates only, per-location + entity", () => {
    const set = deriveQuerySet(realEstatePlaybook, GG);
    expect(set.vertical).toBe("real-estate");
    expect(set.playbookVersion).toBe(realEstatePlaybook.version);
    expect(set.queries.map((q) => q.prompt)).toEqual([
      "Dubai golden visa / residency real estate requirements",
      "Abu Dhabi golden visa / residency real estate requirements",
      "is Dubai real estate a good investment / a bubble",
      "is Abu Dhabi real estate a good investment / a bubble",
      "who is Gable & Grove Realty",
    ]);
    expect(set.dropped).toBe(0);
  });

  it("never leaves (or invents) a placeholder in a derived prompt", () => {
    for (const playbook of [realEstatePlaybook, cannabisPlaybook, restaurantsPlaybook, ecommercePlaybook]) {
      const set = deriveQuerySet(playbook, GG);
      for (const query of set.queries) {
        expect(query.prompt).not.toMatch(/\[[^\]]*\]/);
      }
    }
  });

  it("reports every excluded template with the tokens it could not fill", () => {
    const set = deriveQuerySet(realEstatePlaybook, GG);
    expect(set.excluded).toEqual([
      { template: "best [city] real estate advisor for [buyer type]", unresolved: ["buyer type"] },
      { template: "how do [nationality] buy property in [city]", unresolved: ["nationality"] },
      { template: "can [nationality] get a mortgage in [city]", unresolved: ["nationality"] },
      { template: "do [nationality] pay taxes on [city] property", unresolved: ["nationality"] },
      { template: "[podcast name]", unresolved: ["podcast name"] },
    ]);
  });

  it("is honest about a thin fit: ecommerce with no locations derives exactly one query", () => {
    const set = deriveQuerySet(ecommercePlaybook, {
      name: "Acme Gear",
      locations: [],
    });
    // Every other ecommerce template carries product/category/competitor
    // tokens we hold no values for — excluded, never guessed.
    expect(set.queries.map((q) => q.prompt)).toEqual([
      "is Acme Gear worth it / reviews",
    ]);
    expect(set.excluded).toHaveLength(6);
  });

  it("substitutes entity tokens with the client's recorded name", () => {
    const set = deriveQuerySet(cannabisPlaybook, {
      name: "Green Leaf",
      locations: [{ name: "San Diego, CA", address: "123 Main St" }],
    });
    expect(set.queries.map((q) => q.prompt)).toContain(
      "is Green Leaf legit / reviews"
    );
  });

  it("instantiates [city] and 'near me' templates once per location, with geo context", () => {
    const set = deriveQuerySet(cannabisPlaybook, {
      name: "Green Leaf",
      locations: [
        { name: "San Diego, CA", address: "123 Main St" },
        { name: "Phoenix, AZ", address: "9 Desert Rd" },
      ],
    });
    const nearMe = set.queries.filter((q) =>
      q.prompt.startsWith("best dispensary near me")
    );
    expect(nearMe.map((q) => q.location)).toEqual(["San Diego, CA", "Phoenix, AZ"]);
    expect(nearMe.map((q) => q.geo)).toEqual([
      { market: "San Diego, CA" },
      { market: "Phoenix, AZ" },
    ]);
    // Market-independent entity query carries no geo.
    const entity = set.queries.find((q) => q.prompt.includes("legit"));
    expect(entity?.location).toBeNull();
    expect(entity?.geo).toBeUndefined();
  });

  it("excludes location-dependent templates (including bare 'near me') when the client has no locations", () => {
    const set = deriveQuerySet(restaurantsPlaybook, {
      name: "Tratto",
      locations: [],
    });
    expect(set.queries.map((q) => q.prompt)).toEqual([
      "Tratto menu / hours / reservations",
      "Tratto reviews / is it good",
    ]);
    expect(set.excluded).toContainEqual({
      template: "restaurants open now near me",
      unresolved: ["near me"],
    });
    expect(set.excluded).toContainEqual({
      template: "romantic / group / kid-friendly restaurant [city]",
      unresolved: ["city"],
    });
  });

  it("treats entity tokens as unresolved when the client name is blank", () => {
    const set = deriveQuerySet(
      syntheticPlaybook([
        { prompt: "who is [advisor name]", intents: ["entity"], priority: "normal" },
      ]),
      { name: "   ", locations: [] }
    );
    expect(set.queries).toEqual([]);
    expect(set.excluded).toEqual([
      { template: "who is [advisor name]", unresolved: ["advisor name"] },
    ]);
  });
});

describe("deriveQuerySet — ordering, dedupe, truncation", () => {
  it("orders high-priority templates first, then playbook order, then location order", () => {
    const set = deriveQuerySet(
      syntheticPlaybook([
        { prompt: "normal [city] prompt", intents: ["research"], priority: "normal" },
        { prompt: "high [city] prompt", intents: ["transactional"], priority: "high" },
      ]),
      GG
    );
    expect(set.queries.map((q) => q.prompt)).toEqual([
      "high Dubai prompt",
      "high Abu Dhabi prompt",
      "normal Dubai prompt",
      "normal Abu Dhabi prompt",
    ]);
  });

  it("dedupes repeated locations and identical derived prompts", () => {
    const set = deriveQuerySet(
      syntheticPlaybook([
        { prompt: "buy in [city]", intents: ["transactional"], priority: "normal" },
        { prompt: "buy in [city]", intents: ["transactional"], priority: "normal" },
      ]),
      {
        name: "GG",
        locations: [
          { name: "Dubai", address: "a" },
          { name: "  dubai ", address: "b" },
          { name: "", address: "c" },
        ],
      }
    );
    expect(set.queries.map((q) => q.prompt)).toEqual(["buy in Dubai"]);
  });

  it("truncates past the cap honestly: lowest-priority tail dropped, count reported", () => {
    const manyLocations = Array.from({ length: 60 }, (_, i) => ({
      name: `City ${String(i).padStart(2, "0")}`,
      address: `${i} Main St`,
    }));
    const set = deriveQuerySet(
      syntheticPlaybook([
        { prompt: "normal [city] prompt", intents: ["research"], priority: "normal" },
        { prompt: "high [city] prompt", intents: ["transactional"], priority: "high" },
      ]),
      { name: "GG", locations: manyLocations }
    );
    expect(set.queries).toHaveLength(MAX_TRACKED_QUERIES);
    expect(set.dropped).toBe(120 - MAX_TRACKED_QUERIES);
    // Every high-priority variant survived; the drop came off the normal tail.
    expect(set.queries.filter((q) => q.priority === "high")).toHaveLength(60);
  });

  it("is deterministic: same inputs, byte-identical output", () => {
    const a = deriveQuerySet(realEstatePlaybook, GG);
    const b = deriveQuerySet(realEstatePlaybook, GG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("carries template trace-back and intents onto each query", () => {
    const set = deriveQuerySet(realEstatePlaybook, GG);
    const query = set.queries.find((q) => q.prompt === "who is Gable & Grove Realty");
    expect(query).toMatchObject({
      template: "who is [advisor name]",
      intents: ["entity"],
      priority: "normal",
      location: null,
    });
  });
});
