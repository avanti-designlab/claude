/**
 * E-commerce seed playbook (doc 02 §2.5) — national, product-driven.
 *
 * The local module is OFF (local_intensity national, GBP off). Authority
 * through product schema, category content, reviews, and comparison / "best of"
 * citation capture. Stress-tests the local-intensity range at the "off" end.
 */

import type { Playbook } from "@/lib/types/playbook";

export const ecommercePlaybook: Playbook = {
  vertical: "ecommerce",
  local_intensity: "national",
  prompt_library: [
    {
      prompt: "best [product category] for [use case]",
      intents: ["transactional"],
      priority: "high",
    },
    { prompt: "[brand] vs [competitor]", intents: ["comparison"], priority: "normal" },
    {
      prompt: "is [brand/product] worth it / reviews",
      intents: ["reputation"],
      priority: "normal",
    },
    { prompt: "best [product] under [price]", intents: ["transactional"], priority: "normal" },
    { prompt: "where to buy [product]", intents: ["navigational"], priority: "normal" },
    { prompt: "[product] alternatives", intents: ["comparison"], priority: "normal" },
    { prompt: "how to choose [product category]", intents: ["research"], priority: "normal" },
  ],
  schema_profile: [
    "Product",
    "Offer",
    "AggregateRating",
    "Review",
    "Organization",
    "Brand",
    "FAQPage",
    "Article",
    "BreadcrumbList",
    "ItemList",
  ],
  channel_weighting: {
    "Product + category schema/content": 30,
    "Buying guides + comparison content": 25,
    "Reviews (on-site + third-party)": 20,
    "Third-party 'best of' listicle presence": 15,
    "Social/UGC (Instagram/TikTok)": 10,
    Local: 0,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/ecommerce",
  content_templates: [
    "Product page with full schema",
    "'Best [category]' buying guide (ItemList)",
    "Comparison page",
    "Use-case FAQ",
    "Category pillar",
  ],
  entity_signals: [
    "Brand/Organization schema",
    "Consistent product data across channels",
    "Review aggregation",
    "Presence in third-party best-of lists",
  ],
  local_module_config: {
    enabled: false,
    gbp_priority: "off",
    nap_directories: [],
    multi_location: false,
  },
  citation_sources: [
    "Reddit",
    "Review sites",
    "'Best of' listicles",
    "YouTube reviews",
    "Comparison sites",
  ],
  kpi_focus: [
    "Citation in 'best [category]' prompts",
    "Comparison-prompt inclusion",
    "Product-page indexation",
    "Review aggregation",
    "Third-party listicle presence",
  ],
  version: "1.0.0",
  status: "seed",
};
