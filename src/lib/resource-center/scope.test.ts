/**
 * M18 — playbook scoping is what makes an answer VERTICAL-AWARE, not generic.
 * The scope carries only what the playbook actually holds (no invented sources),
 * bracket tokens are stripped from topic anchors, and it is deterministic.
 */

import { describe, expect, it } from "vitest";
import { getPlaybook } from "@/lib/playbooks";
import { buildResearchScope } from "./scope";
import type { Playbook } from "@/lib/types/playbook";

const realEstate = getPlaybook("real-estate") as Playbook;

describe("buildResearchScope (playbook-scoped)", () => {
  it("carries the vertical, version, citation sources, and compliance ref from the playbook", () => {
    const scope = buildResearchScope(realEstate);
    expect(scope.vertical).toBe("real-estate");
    expect(scope.playbookVersion).toBe(realEstate.version);
    expect(scope.complianceRef).toBe(realEstate.compliance_ruleset_ref);
    expect(scope.citationSources.length).toBeGreaterThan(0);
    // Sources are the playbook's own — never invented.
    for (const s of scope.citationSources) expect(realEstate.citation_sources).toContain(s);
  });

  it("strips bracket tokens from prompt-library templates into human topic anchors", () => {
    const scope = buildResearchScope(realEstate);
    expect(scope.topicAnchors.length).toBeGreaterThan(0);
    for (const anchor of scope.topicAnchors) {
      expect(anchor).not.toMatch(/[[\]]/); // no leftover brackets
      expect(anchor.trim()).toBe(anchor);
    }
  });

  it("is deterministic and dedupes (same playbook → identical scope)", () => {
    expect(buildResearchScope(realEstate)).toEqual(buildResearchScope(realEstate));
  });

  it("a thin playbook yields a thin scope — never padded", () => {
    const thin: Playbook = {
      ...realEstate,
      prompt_library: [{ prompt: "[city]", intents: ["research"], priority: "high" }],
      citation_sources: [],
      entity_signals: [],
    };
    const scope = buildResearchScope(thin);
    // "[city]" is nothing but a token → empty anchor dropped.
    expect(scope.topicAnchors).toEqual([]);
    expect(scope.citationSources).toEqual([]);
    expect(scope.entitySignals).toEqual([]);
  });
});
