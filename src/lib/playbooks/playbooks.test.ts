/**
 * Seed-playbook fidelity vs docs/02-industry-playbooks.md (Phase 1.1 · Gate: Code Review).
 *
 * The five seed playbooks are transcriptions of doc 02 §§2.1–2.5. They drive
 * everything downstream — tracker prompts (M3), schema generation, the
 * channel-weighted roadmap (M1), compliance gates, and local-module intensity
 * (M14/M15) — so these tests pin the load-bearing values from doc 02's tables.
 * An accidental edit to a weight, intent, or local toggle fails loudly here
 * instead of silently reshaping every generated plan.
 */

import { describe, expect, it } from "vitest";
import { ACTIVE_VERTICALS, SEED_PLAYBOOKS, getPlaybook } from "./index";
import {
  SEED_VERTICALS,
  type Playbook,
  type PromptIntent,
  type SeedVertical,
} from "@/lib/types/playbook";

const VERTICALS = Object.keys(SEED_PLAYBOOKS) as SeedVertical[];

function sumWeights(p: Playbook): number {
  return Object.values(p.channel_weighting).reduce((a, b) => a + b, 0);
}

function intentsOf(p: Playbook): Set<PromptIntent> {
  return new Set(p.prompt_library.flatMap((entry) => entry.intents));
}

function highPrompts(p: Playbook): string[] {
  return p.prompt_library.filter((entry) => entry.priority === "high").map((entry) => entry.prompt);
}

function promptMatching(p: Playbook, needle: string) {
  const match = p.prompt_library.find((entry) => entry.prompt.includes(needle));
  expect(match, `expected a prompt containing "${needle}"`).toBeDefined();
  return match!;
}

describe("seed playbook registry (doc 02 + Gate 1a rollout)", () => {
  it("loads exactly the five seed verticals, each keyed by its own vertical id", () => {
    expect([...VERTICALS].sort()).toEqual([...SEED_VERTICALS].sort());
    for (const v of VERTICALS) {
      expect(SEED_PLAYBOOKS[v].vertical).toBe(v);
    }
  });

  it("getPlaybook resolves each seed vertical to its playbook", () => {
    for (const v of VERTICALS) {
      expect(getPlaybook(v)).toBe(SEED_PLAYBOOKS[v]);
    }
  });

  it("getPlaybook returns null for an unknown vertical (generated playbooks are M1b's job)", () => {
    expect(getPlaybook("med-spas" as unknown as SeedVertical)).toBeNull();
  });

  it("only real estate is switched into active client use (Gate 1a validation-first rollout)", () => {
    expect(ACTIVE_VERTICALS).toEqual(["real-estate"]);
  });
});

describe.each(VERTICALS)("shared playbook-schema invariants — %s (doc 02 schema)", (v) => {
  const p = SEED_PLAYBOOKS[v];

  it('is a trusted hand-authored seed: status "seed", version "1.0.0"', () => {
    expect(p.status).toBe("seed");
    expect(p.version).toBe("1.0.0");
  });

  it("references its own vertical's compliance ruleset (non-negotiable gate)", () => {
    expect(p.compliance_ruleset_ref).toBe(`skill://compliance-ruleset/${v}`);
  });

  it("has a non-empty, well-formed prompt library for the tracker (M3)", () => {
    expect(p.prompt_library.length).toBeGreaterThanOrEqual(5);
    for (const entry of p.prompt_library) {
      expect(entry.prompt.trim().length).toBeGreaterThan(0);
      expect(entry.intents.length).toBeGreaterThan(0);
      expect(["high", "normal"]).toContain(entry.priority);
    }
  });

  it("has integer channel weights within 0–100, with at least one weighted channel", () => {
    const weights = Object.values(p.channel_weighting);
    expect(weights.length).toBeGreaterThan(0);
    for (const w of weights) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...weights)).toBeGreaterThan(0);
  });

  it("has a non-empty schema profile without duplicates", () => {
    expect(p.schema_profile.length).toBeGreaterThan(0);
    expect(new Set(p.schema_profile).size).toBe(p.schema_profile.length);
  });

  it("fills every doc 02 list section", () => {
    expect(p.content_templates.length).toBeGreaterThan(0);
    expect(p.entity_signals.length).toBeGreaterThan(0);
    expect(p.citation_sources.length).toBeGreaterThan(0);
    expect(p.kpi_focus.length).toBeGreaterThan(0);
  });

  it("keeps local_module_config consistent with local_intensity (doc 02 cross-playbook note)", () => {
    const local = p.local_module_config;
    if (p.local_intensity === "national") {
      // national → module OFF: disabled, GBP off, nothing to sync.
      expect(local.enabled).toBe(false);
      expect(local.gbp_priority).toBe("off");
      expect(local.nap_directories).toEqual([]);
    } else if (p.local_intensity === "hyper-local") {
      expect(local.enabled).toBe(true);
      expect(["critical", "high"]).toContain(local.gbp_priority);
      expect(local.nap_directories.length).toBeGreaterThan(0);
    } else {
      // semi-local → MEDIUM.
      expect(local.enabled).toBe(true);
      expect(local.gbp_priority).toBe("medium");
      expect(local.nap_directories.length).toBeGreaterThan(0);
    }
  });
});

describe("cannabis (doc 02 §2.1)", () => {
  const p = SEED_PLAYBOOKS.cannabis;

  it("is hyper-local", () => {
    expect(p.local_intensity).toBe("hyper-local");
  });

  it("weights channels per the doc 02 table — Meta ads are compliance-blocked at 0", () => {
    expect(p.channel_weighting["Google Business Profile + local"]).toBe(30);
    expect(p.channel_weighting["Reddit (r/cannabis, city + strain subs)"]).toBe(20);
    expect(p.channel_weighting["Reviews (Google/Weedmaps/Leafly)"]).toBe(20);
    expect(p.channel_weighting["On-site education (strains, effects, terpenes)"]).toBe(15);
    expect(p.channel_weighting["Menu-platform + off-menu indexable pages"]).toBe(10);
    expect(p.channel_weighting["Meta ads"]).toBe(0);
    // Doc 02 §2.1's table itself sums to 95 — transcription is faithful, not "fixed".
    expect(sumWeights(p)).toBe(95);
  });

  it("carries the doc 02 prompt library (7 prompts, transactional-led)", () => {
    expect(p.prompt_library).toHaveLength(7);
    expect(highPrompts(p)).toEqual(["best dispensary near me / best dispensary in [city]"]);
    const intents = intentsOf(p);
    for (const intent of ["transactional", "research", "reputation", "educational"] as const) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(promptMatching(p, "cannabinoid/terpene").intents).toContain("educational");
  });

  it("leads the schema profile with LocalBusiness (Store) + Product per doc 02 priority order", () => {
    expect(p.schema_profile.slice(0, 3)).toEqual(["LocalBusiness", "Store", "Product"]);
  });

  it("runs the local module HIGH with cannabis directories and multi-location chains", () => {
    expect(p.local_module_config.enabled).toBe(true);
    expect(p.local_module_config.gbp_priority).toBe("high");
    expect(p.local_module_config.multi_location).toBe(true);
    expect(p.local_module_config.nap_directories).toContain("Weedmaps");
    expect(p.local_module_config.nap_directories).toContain("Leafly");
  });
});

describe("real-estate (doc 02 §2.2 — Gate 1a client-zero vertical)", () => {
  const p = SEED_PLAYBOOKS["real-estate"];

  it("is semi-local", () => {
    expect(p.local_intensity).toBe("semi-local");
  });

  it("weights channels per the doc 02 table — resource center 30, PR entity leverage 25", () => {
    expect(p.channel_weighting["On-site resource center (pillars + FAQ + video)"]).toBe(30);
    expect(p.channel_weighting["Entity leverage of existing PR (Person sameAs)"]).toBe(25);
    expect(p.channel_weighting["Evergreen refresh (60–90 day)"]).toBe(15);
    expect(p.channel_weighting["Reddit/Quora (investor/expat threads)"]).toBe(12);
    expect(sumWeights(p)).toBe(100);
  });

  it("carries the doc 02 prompt library (8 prompts, entity-led)", () => {
    expect(p.prompt_library).toHaveLength(8);
    expect(highPrompts(p)).toEqual(["best [city] real estate advisor for [buyer type]"]);
    const intents = intentsOf(p);
    for (const intent of ["entity", "research", "transactional", "regulatory"] as const) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(promptMatching(p, "golden visa").intents).toEqual(["research", "regulatory"]);
    expect(promptMatching(p, "who is [advisor name]").intents).toEqual(["entity"]);
  });

  it("leads the schema profile with Person (sameAs — highest value) per doc 02 priority order", () => {
    expect(p.schema_profile.slice(0, 3)).toEqual(["Person", "RealEstateAgent", "Organization"]);
  });

  it("runs the local module MEDIUM (semi-local), single-location", () => {
    expect(p.local_module_config.gbp_priority).toBe("medium");
    expect(p.local_module_config.multi_location).toBe(false);
  });
});

describe("restaurants (doc 02 §2.3 — the most local vertical)", () => {
  const p = SEED_PLAYBOOKS.restaurants;

  it("is hyper-local", () => {
    expect(p.local_intensity).toBe("hyper-local");
  });

  it("weights channels per the doc 02 table — GBP dominates at 35", () => {
    expect(p.channel_weighting["Google Business Profile + local"]).toBe(35);
    expect(p.channel_weighting["Reviews (Google/Yelp/TripAdvisor)"]).toBe(25);
    expect(p.channel_weighting["Menu schema + indexable menu pages"]).toBe(15);
    expect(p.channel_weighting["Reservation-platform presence"]).toBe(5);
    expect(sumWeights(p)).toBe(100);
  });

  it("carries the doc 02 prompt library (7 prompts, incl. navigational menu/hours)", () => {
    expect(p.prompt_library).toHaveLength(7);
    expect(highPrompts(p)).toEqual(["best [cuisine] restaurant near me / in [city]"]);
    const intents = intentsOf(p);
    for (const intent of ["transactional", "navigational", "research", "reputation"] as const) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(promptMatching(p, "menu / hours").intents).toContain("navigational");
  });

  it("leads the schema profile with Restaurant + Menu + MenuItem per doc 02 priority order", () => {
    expect(p.schema_profile.slice(0, 3)).toEqual(["Restaurant", "Menu", "MenuItem"]);
  });

  it("runs the local module CRITICAL with reservation directories and multi-location", () => {
    expect(p.local_module_config.gbp_priority).toBe("critical");
    expect(p.local_module_config.multi_location).toBe(true);
    expect(p.local_module_config.nap_directories).toContain("OpenTable");
    expect(p.local_module_config.nap_directories).toContain("Resy");
  });
});

describe("health-life-insurance (doc 02 §2.4)", () => {
  const p = SEED_PLAYBOOKS["health-life-insurance"];

  it("is semi-local", () => {
    expect(p.local_intensity).toBe("semi-local");
  });

  it("weights channels per the doc 02 table — E-E-A-T education leads at 30", () => {
    expect(p.channel_weighting["On-site educational content (E-E-A-T)"]).toBe(30);
    expect(p.channel_weighting["Licensed-agent entity signals"]).toBe(20);
    expect(p.channel_weighting["Reviews (Google/Trustpilot/BBB)"]).toBe(20);
    expect(p.channel_weighting["Local + GBP (agency)"]).toBe(15);
    expect(sumWeights(p)).toBe(100);
  });

  it("carries the doc 02 prompt library (8 prompts; doc 02 marks none high priority)", () => {
    expect(p.prompt_library).toHaveLength(8);
    expect(highPrompts(p)).toEqual([]);
    const intents = intentsOf(p);
    for (const intent of ["transactional", "research", "reputation", "educational"] as const) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(promptMatching(p, "difference between").intents).toContain("educational");
  });

  it("leads the schema profile with Organization/InsuranceAgency + Person per doc 02 priority order", () => {
    expect(p.schema_profile.slice(0, 3)).toEqual(["Organization", "InsuranceAgency", "Person"]);
  });

  it("runs the local module MEDIUM across agency offices/states", () => {
    expect(p.local_module_config.gbp_priority).toBe("medium");
    expect(p.local_module_config.multi_location).toBe(true);
  });
});

describe("ecommerce (doc 02 §2.5 — the local-OFF stress test)", () => {
  const p = SEED_PLAYBOOKS.ecommerce;

  it("is national", () => {
    expect(p.local_intensity).toBe("national");
  });

  it("weights channels per the doc 02 table — Local is 0 (module off)", () => {
    expect(p.channel_weighting["Product + category schema/content"]).toBe(30);
    expect(p.channel_weighting["Buying guides + comparison content"]).toBe(25);
    expect(p.channel_weighting["Third-party 'best of' listicle presence"]).toBe(15);
    expect(p.channel_weighting["Local"]).toBe(0);
    expect(sumWeights(p)).toBe(100);
  });

  it("carries the doc 02 prompt library (7 prompts, incl. comparison intents)", () => {
    expect(p.prompt_library).toHaveLength(7);
    expect(highPrompts(p)).toEqual(["best [product category] for [use case]"]);
    const intents = intentsOf(p);
    for (const intent of [
      "transactional",
      "comparison",
      "reputation",
      "navigational",
      "research",
    ] as const) {
      expect(intents.has(intent)).toBe(true);
    }
    expect(promptMatching(p, "[brand] vs [competitor]").intents).toEqual(["comparison"]);
  });

  it("leads the schema profile with Product + Offer + AggregateRating per doc 02 priority order", () => {
    expect(p.schema_profile.slice(0, 3)).toEqual(["Product", "Offer", "AggregateRating"]);
  });

  it("switches the local module fully OFF (disabled, GBP off, no directories)", () => {
    expect(p.local_module_config).toEqual({
      enabled: false,
      gbp_priority: "off",
      nap_directories: [],
      multi_location: false,
    });
  });
});
