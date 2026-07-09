/**
 * M18 — the two downstream FEED shapes (prompt-volume → M3, content-research →
 * M8). Proves the shapes, the volume aggregation, and the honesty rule: an
 * ungrounded answer yields NO grounding facts (M18 never hands M8 something to
 * assert that it could not itself ground).
 */

import { describe, expect, it } from "vitest";
import {
  aggregatePromptVolume,
  toContentResearch,
  toPromptVolumeSignal,
} from "./feeds";
import type { GradedAnswer, ResearchScope } from "./types";

const SCOPE: ResearchScope = {
  vertical: "real-estate",
  playbookVersion: "1.0.0",
  citationSources: ["zillow.com"],
  topicAnchors: ["buying process", "escrow basics"],
  entitySignals: [],
  complianceRef: "skill://compliance-ruleset/real-estate",
};

const GROUNDED: GradedAnswer = {
  answer: "Escrow holds funds.",
  answered: true,
  grounded: true,
  confidence: "high",
  sources: [{ title: "NAR", url: "https://nar.realtor/g", snippet: "Escrow holds funds until closing." }],
  unattributedCitations: [],
  webSearchAvailable: true,
  disclaimer: "d",
};

describe("toPromptVolumeSignal (→ M3)", () => {
  it("normalizes the question into a candidate prompt with a dedup key + provenance", () => {
    const sig = toPromptVolumeSignal("  What   is Escrow?  ", SCOPE);
    expect(sig).toEqual({
      vertical: "real-estate",
      prompt: "What is Escrow?",
      key: "what is escrow?",
      source: "resource_center",
    });
  });

  it("returns null for an empty question", () => {
    expect(toPromptVolumeSignal("   ", SCOPE)).toBeNull();
  });
});

describe("aggregatePromptVolume (→ M3)", () => {
  it("counts distinct normalized prompts, highest volume first", () => {
    const signals = [
      toPromptVolumeSignal("what is escrow", SCOPE)!,
      toPromptVolumeSignal("What is escrow", SCOPE)!, // same key → +1
      toPromptVolumeSignal("closing costs", SCOPE)!,
    ];
    const agg = aggregatePromptVolume(signals);
    expect(agg[0]).toMatchObject({ prompt: "what is escrow", count: 2, vertical: "real-estate" });
    expect(agg.map((e) => e.count)).toEqual([2, 1]);
  });
});

describe("toContentResearch (→ M8)", () => {
  it("shapes topic + niche angles + GROUNDED facts + source urls from a grounded answer", () => {
    const brief = toContentResearch("what is escrow", GROUNDED, SCOPE);
    expect(brief.vertical).toBe("real-estate");
    expect(brief.topic).toBe("what is escrow");
    expect(brief.angles).toEqual(["buying process", "escrow basics"]);
    expect(brief.groundingFacts).toEqual(["Escrow holds funds until closing."]);
    expect(brief.sourceUrls).toEqual(["https://nar.realtor/g"]);
    expect(brief.grounded).toBe(true);
  });

  it("an UNGROUNDED answer yields NO grounding facts + NO source urls (honest, thin brief)", () => {
    const ungrounded: GradedAnswer = { ...GROUNDED, grounded: false };
    const brief = toContentResearch("q", ungrounded, SCOPE);
    expect(brief.groundingFacts).toEqual([]);
    expect(brief.sourceUrls).toEqual([]);
    expect(brief.grounded).toBe(false);
    // Angles come from the playbook, so they survive even without grounding.
    expect(brief.angles.length).toBeGreaterThan(0);
  });
});
