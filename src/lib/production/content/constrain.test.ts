/**
 * buildGenerationSpec — the seam where the LOCKED voice + the PLAYBOOK + the
 * COMPLIANCE ruleset become generation constraints. Uses the REAL seed playbooks
 * and the REAL compliance skill (public surface only).
 */

import { describe, expect, it } from "vitest";
import { cannabisPlaybook, realEstatePlaybook } from "@/lib/playbooks";
import type { VoiceProfile } from "@/lib/types/brand";
import {
  buildGenerationSpec,
  deriveComplianceGuardrails,
  pickTargetPrompt,
  toComplianceContentType,
} from "./constrain";

const VOICE: VoiceProfile = {
  descriptors: ["confident", "precise"],
  samples: ["We advise, we don’t sell."],
  do: ["cite sources"],
  dont: ["hype"],
};

describe("toComplianceContentType", () => {
  it("maps blog/faq straight across and pillar → page", () => {
    expect(toComplianceContentType("blog")).toBe("blog");
    expect(toComplianceContentType("faq")).toBe("faq");
    expect(toComplianceContentType("pillar")).toBe("page");
  });
});

describe("pickTargetPrompt", () => {
  it("prefers the first high-priority prompt", () => {
    // Real-estate's first library entry is priority 'high'.
    expect(pickTargetPrompt(realEstatePlaybook.prompt_library)).toBe(
      realEstatePlaybook.prompt_library.find((e) => e.priority === "high")!.prompt,
    );
  });
  it("falls back to the first prompt, then null", () => {
    expect(pickTargetPrompt([{ prompt: "only", intents: ["research"], priority: "normal" }])).toBe("only");
    expect(pickTargetPrompt([])).toBeNull();
  });
});

describe("deriveComplianceGuardrails", () => {
  it("renders the vertical's BLOCK rules into avoid-guidance", () => {
    const guardrails = deriveComplianceGuardrails("cannabis");
    expect(guardrails.length).toBeGreaterThan(0);
    // The health-claims block rule's description is present as guidance.
    expect(guardrails.some((g) => g.toLowerCase().includes("health"))).toBe(true);
  });

  it("returns [] for an unknown vertical (generation isn't blocked here; the pre-screen + gate are)", () => {
    expect(deriveComplianceGuardrails("underwater-basket-weaving")).toEqual([]);
  });
});

describe("buildGenerationSpec", () => {
  it("carries the locked voice, the playbook mapping, and compliance guardrails into the spec", () => {
    const s = buildGenerationSpec({
      request: { contentType: "pillar", topic: "golden visa requirements", groundingFacts: ["Program launched 2019."] },
      playbook: realEstatePlaybook,
      voice: VOICE,
    });

    expect(s.contentType).toBe("pillar");
    expect(s.topic).toBe("golden visa requirements");
    expect(s.groundingFacts).toEqual(["Program launched 2019."]);
    expect(s.voice.descriptors).toEqual(["confident", "precise"]);
    expect(s.playbook.vertical).toBe("real-estate");
    expect(s.playbook.templates).toEqual(realEstatePlaybook.content_templates);
    expect(s.playbook.schemaProfile).toEqual(realEstatePlaybook.schema_profile);
    expect(s.playbook.targetPrompt).toBe(pickTargetPrompt(realEstatePlaybook.prompt_library));
    // Real-estate has block rules → non-empty guardrails.
    expect(s.complianceGuardrails.length).toBeGreaterThan(0);
  });

  it("defensively copies arrays (mutating the spec never touches the source voice/playbook)", () => {
    const voice: VoiceProfile = { descriptors: ["a"], samples: [], do: [], dont: [] };
    const s = buildGenerationSpec({
      request: { contentType: "blog", topic: "t", groundingFacts: ["f"] },
      playbook: cannabisPlaybook,
      voice,
    });
    s.voice.descriptors.push("mutated");
    s.groundingFacts.push("mutated");
    expect(voice.descriptors).toEqual(["a"]);
  });
});
