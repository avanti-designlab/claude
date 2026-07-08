/**
 * Health & life insurance seed playbook (doc 02 §2.4) — regulated, semi-local.
 *
 * Trust-heavy and compliance-sensitive (TCPA, Special Ad Category). Authority
 * through E-E-A-T, licensed-agent entity signals, and educational content.
 * Transcribed faithfully from doc 02.
 */

import type { Playbook } from "@/lib/types/playbook";

export const healthLifeInsurancePlaybook: Playbook = {
  vertical: "health-life-insurance",
  local_intensity: "semi-local",
  prompt_library: [
    {
      prompt: "best [type] insurance for [demographic] (e.g. final expense for seniors)",
      intents: ["transactional"],
      priority: "normal",
    },
    { prompt: "how much does [type] insurance cost", intents: ["research"], priority: "normal" },
    {
      prompt: "[type] insurance with no medical exam",
      intents: ["research"],
      priority: "normal",
    },
    { prompt: "is [type] insurance worth it", intents: ["research"], priority: "normal" },
    { prompt: "best life insurance for [situation]", intents: ["research"], priority: "normal" },
    { prompt: "[agency name] reviews / legit", intents: ["reputation"], priority: "normal" },
    {
      prompt: "how to get [type] insurance in [state]",
      intents: ["transactional"],
      priority: "normal",
    },
    {
      prompt: "difference between [product A] and [product B]",
      intents: ["educational"],
      priority: "normal",
    },
  ],
  schema_profile: [
    "Organization",
    "InsuranceAgency",
    "Person",
    "FAQPage",
    "Article",
    "Review",
    "AggregateRating",
    "Service",
  ],
  channel_weighting: {
    "On-site educational content (E-E-A-T)": 30,
    "Licensed-agent entity signals": 20,
    "Reviews (Google/Trustpilot/BBB)": 20,
    "Local + GBP (agency)": 15,
    "Comparison/education pillars": 10,
    "Reddit/Quora (personal-finance threads)": 5,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/health-life-insurance",
  content_templates: [
    "Product explainer pillar",
    "Cost/eligibility FAQ",
    "Comparison page",
    "'Insurance in [state]' page",
    "Agent bio page with credentials",
  ],
  entity_signals: [
    "Licensed-agent Person schema with sameAs to NPN/state-license lookups",
    "Agency credentials",
    "Review profile",
    "Consistent NAP",
  ],
  local_module_config: {
    enabled: true,
    gbp_priority: "medium",
    nap_directories: ["Google", "Trustpilot", "BBB", "Apple Maps"],
    multi_location: true,
  },
  citation_sources: [
    "Insurance-education sites",
    "Reddit personal-finance",
    "Trustpilot/BBB",
    "Gov/regulatory pages",
  ],
  kpi_focus: [
    "Citation in cost/comparison prompts",
    "Entity/credential recognition",
    "Lead-form conversions (attribution)",
    "Review velocity",
  ],
  version: "1.0.0",
  status: "seed",
};
