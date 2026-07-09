/**
 * M12 fix builders — module "M12", honest fixes only (publish what matches,
 * add on-page facts a rejected schema needs, surface real press).
 */

import { describe, expect, it } from "vitest";
import { personFixes, pressFixes } from "./fixes";
import { produceEntitySchema, type EntitySchemaOutcome } from "./entity-schema";
import type { PersonEntityAssessment, PressSurfaceAssessment } from "./types";

const PAGE = "Daniel Reyes is the founder of GG Realty. As featured in Forbes.";

function person(over: Partial<PersonEntityAssessment> = {}): PersonEntityAssessment {
  return {
    status: "assessed",
    keyPersonName: "Daniel Reyes",
    namePresentOnPage: true,
    personSchemaPresent: false,
    sameAsPresentInSchema: false,
    notes: [],
    ...over,
  };
}

const readyPersonSchema: EntitySchemaOutcome = produceEntitySchema({
  entity: { entityType: "Person", person: { name: "Daniel Reyes", sameAsSources: { pressArticles: ["https://forbes.com/x"] } } },
  visible: PAGE,
});

describe("personFixes", () => {
  it("all fixes carry module 'M12'", () => {
    const fixes = personFixes(person(), readyPersonSchema);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.module === "M12")).toBe(true);
  });

  it("name not on page → raises the surface-person fix ONLY (schema blocked upstream)", () => {
    const fixes = personFixes(person({ namePresentOnPage: false }), null);
    expect(fixes.map((f) => f.id)).toEqual(["pr/person-onpage-name"]);
  });

  it("ready schema + no existing Person schema → publish-Person fix", () => {
    const fixes = personFixes(person(), readyPersonSchema);
    expect(fixes.some((f) => f.id === "pr/person-schema-publish")).toBe(true);
  });

  it("rejected schema → add-on-page-facts fix (never publishes overclaim)", () => {
    const rejected = produceEntitySchema({ entity: { entityType: "Person", person: { name: "Ghost Person" } }, visible: PAGE });
    const fixes = personFixes(person({ namePresentOnPage: true }), rejected);
    expect(fixes.some((f) => f.id === "pr/person-schema-blocked")).toBe(true);
  });

  it("existing Person schema without sameAs + sameAs available → add-sameAs fix", () => {
    const fixes = personFixes(person({ personSchemaPresent: true, sameAsPresentInSchema: false }), readyPersonSchema);
    expect(fixes.some((f) => f.id === "pr/person-sameas")).toBe(true);
  });

  it("not assessable / no key person → no fixes", () => {
    expect(personFixes(person({ status: "not_assessable" }), null)).toEqual([]);
    expect(personFixes(person({ status: "no_key_person" }), null)).toEqual([]);
  });
});

function press(over: Partial<PressSurfaceAssessment> = {}): PressSurfaceAssessment {
  return {
    status: "assessed",
    pressSectionPresent: false,
    claimedPress: [
      { publication: "Forbes", url: "https://forbes.com/x", mentionedOnPage: true, note: "" },
      { publication: "Inman", url: "https://inman.com/y", mentionedOnPage: false, note: "" },
    ],
    corroboratedCount: 1,
    claimedCount: 2,
    notes: [],
    ...over,
  };
}

describe("pressFixes", () => {
  it("corroborated press but no surface → build 'As Featured In' fix", () => {
    const fixes = pressFixes(press());
    expect(fixes.some((f) => f.id === "pr/press-section")).toBe(true);
    expect(fixes.every((f) => f.module === "M12")).toBe(true);
  });

  it("uncorroborated claimed press → reference-on-site fix naming only the uncorroborated ones", () => {
    const fixes = pressFixes(press());
    const corr = fixes.find((f) => f.id === "pr/press-corroborate")!;
    expect(corr.detail).toContain("Inman");
    expect(corr.detail).not.toContain("Forbes");
  });

  it("all corroborated + surface present → no press fixes", () => {
    const fixes = pressFixes(
      press({
        pressSectionPresent: true,
        claimedPress: [{ publication: "Forbes", url: null, mentionedOnPage: true, note: "" }],
        corroboratedCount: 1,
        claimedCount: 1,
      }),
    );
    expect(fixes).toEqual([]);
  });

  it("uncrawlable (not_assessable) → no fixes", () => {
    expect(pressFixes(press({ status: "not_assessable" }))).toEqual([]);
  });
});
