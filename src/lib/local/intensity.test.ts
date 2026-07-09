import { describe, expect, it } from "vitest";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

/** Seed playbooks are always present — unwrap getPlaybook's null for tests. */
const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
import type { Playbook } from "@/lib/types/playbook";
import { impactForIntensity, isLocalOff, localIntensity, type LocalIntensityLevel } from "./intensity";

/** Minimal playbook stub for the mapping table (only the local fields matter). */
function stub(
  local_intensity: Playbook["local_intensity"],
  overrides: Partial<Playbook["local_module_config"]> = {},
): Playbook {
  return {
    vertical: "test",
    local_intensity,
    prompt_library: [],
    schema_profile: [],
    channel_weighting: {},
    compliance_ruleset_ref: "skill://compliance-ruleset/test",
    content_templates: [],
    entity_signals: [],
    local_module_config: {
      enabled: true,
      gbp_priority: "medium",
      nap_directories: [],
      multi_location: false,
      ...overrides,
    },
    citation_sources: [],
    kpi_focus: [],
    version: "1.0.0",
    status: "seed",
  };
}

describe("localIntensity — playbook-driven mapping (never invented)", () => {
  it("national → off", () => {
    expect(localIntensity(stub("national", { enabled: false, gbp_priority: "off" }))).toBe("off");
  });

  it("semi-local → medium", () => {
    expect(localIntensity(stub("semi-local", { gbp_priority: "medium" }))).toBe("medium");
  });

  it("hyper-local + gbp_priority critical → critical", () => {
    expect(localIntensity(stub("hyper-local", { gbp_priority: "critical" }))).toBe("critical");
  });

  it("hyper-local + gbp_priority high → high", () => {
    expect(localIntensity(stub("hyper-local", { gbp_priority: "high" }))).toBe("high");
  });

  it("a disabled local module is off regardless of intensity", () => {
    expect(localIntensity(stub("hyper-local", { enabled: false, gbp_priority: "critical" }))).toBe("off");
  });
});

describe("localIntensity — the seed playbooks map as doc 05 M14 describes", () => {
  const cases: Array<[Parameters<typeof getPlaybook>[0], LocalIntensityLevel]> = [
    ["restaurants", "critical"], // gbp_priority critical
    ["cannabis", "high"], //        hyper-local + gbp_priority high
    ["real-estate", "medium"],
    ["health-life-insurance", "medium"],
    ["ecommerce", "off"], //        national
  ];
  it.each(cases)("%s → %s", (vertical, expected) => {
    expect(localIntensity(getPlaybook(vertical))).toBe(expected);
    expect(isLocalOff(getPlaybook(vertical))).toBe(expected === "off");
  });
});

describe("impactForIntensity", () => {
  it("grades impact by intensity (never harder than the vertical's local importance)", () => {
    expect(impactForIntensity("critical")).toBe("critical");
    expect(impactForIntensity("high")).toBe("high");
    expect(impactForIntensity("medium")).toBe("medium");
    expect(impactForIntensity("off")).toBe("low");
  });
});
