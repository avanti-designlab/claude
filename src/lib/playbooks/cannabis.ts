/**
 * Cannabis seed playbook (doc 02 §2.1) — hyper-local, highest-compliance vertical.
 *
 * Authority is won locally and through non-ad channels; paid social is
 * compliance-blocked (Meta ads weight 0). Transcribed faithfully from doc 02.
 */

import type { Playbook } from "@/lib/types/playbook";

export const cannabisPlaybook: Playbook = {
  vertical: "cannabis",
  local_intensity: "hyper-local",
  prompt_library: [
    {
      prompt: "best dispensary near me / best dispensary in [city]",
      intents: ["transactional"],
      priority: "high",
    },
    {
      prompt: "where to buy [product type] in [city]",
      intents: ["transactional"],
      priority: "normal",
    },
    {
      prompt: "strongest [category] strains / best [strain] for [effect]",
      intents: ["research"],
      priority: "normal",
    },
    { prompt: "is [dispensary] legit / reviews", intents: ["reputation"], priority: "normal" },
    {
      prompt: "[city] dispensary deals / first-time discount",
      intents: ["transactional"],
      priority: "normal",
    },
    {
      prompt: "what is [cannabinoid/terpene] good for",
      intents: ["educational"],
      priority: "normal",
    },
    { prompt: "cannabis delivery [city]", intents: ["transactional"], priority: "normal" },
  ],
  schema_profile: [
    "LocalBusiness",
    "Store",
    "Product",
    "Offer",
    "FAQPage",
    "Organization",
    "Review",
    "AggregateRating",
    "Article",
  ],
  channel_weighting: {
    "Google Business Profile + local": 30,
    "Reddit (r/cannabis, city + strain subs)": 20,
    "Reviews (Google/Weedmaps/Leafly)": 20,
    "On-site education (strains, effects, terpenes)": 15,
    "Menu-platform + off-menu indexable pages": 10,
    "Meta ads": 0,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/cannabis",
  content_templates: [
    "Strain/product education page (effect + terpene + use case, direct-answer format)",
    "Dispensary in [city] local page",
    "First-time-customer FAQ",
    "Cannabinoid explainer pillar",
  ],
  entity_signals: [
    "Consistent NAP across Weedmaps/Leafly/Google",
    "Licensed-operator profiles",
    "Brand mentions in city cannabis media",
    "Review velocity",
  ],
  local_module_config: {
    enabled: true,
    gbp_priority: "high",
    nap_directories: ["Google", "Weedmaps", "Leafly", "Apple Maps", "Yelp"],
    multi_location: true,
  },
  citation_sources: [
    "Reddit",
    "Leafly",
    "Weedmaps",
    "Local news",
    "Cannabis-education sites",
  ],
  kpi_focus: [
    "Local-pack ranking",
    "Citation in 'near me' AI answers",
    "Review velocity",
    "Menu-page indexation",
  ],
  version: "1.0.0",
  status: "seed",
};
