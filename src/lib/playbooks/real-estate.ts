/**
 * Real-estate seed playbook (doc 02 §2.2) — luxury / investor-focused, semi-local.
 *
 * Client-zero vertical for the Gate 1a validation pass (GG). Authority is built
 * through entity recognition (Person sameAs over existing PR), long-form
 * evergreen resources, and podcast/thought-leadership. Transcribed from doc 02.
 */

import type { Playbook } from "@/lib/types/playbook";

export const realEstatePlaybook: Playbook = {
  vertical: "real-estate",
  local_intensity: "semi-local",
  prompt_library: [
    {
      prompt: "best [city] real estate advisor for [buyer type]",
      intents: ["entity"],
      priority: "high",
    },
    {
      prompt: "how do [nationality] buy property in [city]",
      intents: ["research", "transactional"],
      priority: "normal",
    },
    {
      prompt: "can [nationality] get a mortgage in [city]",
      intents: ["research"],
      priority: "normal",
    },
    {
      prompt: "[city] golden visa / residency real estate requirements",
      intents: ["research", "regulatory"],
      priority: "normal",
    },
    {
      prompt: "is [city] real estate a good investment / a bubble",
      intents: ["research"],
      priority: "normal",
    },
    {
      prompt: "do [nationality] pay taxes on [city] property",
      intents: ["research"],
      priority: "normal",
    },
    { prompt: "who is [advisor name]", intents: ["entity"], priority: "normal" },
    { prompt: "[podcast name]", intents: ["entity"], priority: "normal" },
  ],
  schema_profile: [
    "Person",
    "RealEstateAgent",
    "Organization",
    "FAQPage",
    "Article",
    "VideoObject",
    "PodcastSeries",
    "BreadcrumbList",
  ],
  channel_weighting: {
    "On-site resource center (pillars + FAQ + video)": 30,
    "Entity leverage of existing PR (Person sameAs)": 25,
    "Evergreen refresh (60–90 day)": 15,
    "Reddit/Quora (investor/expat threads)": 12,
    "LinkedIn long-form (advisor voice)": 10,
    "Podcast citations on FAQ pages": 8,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/real-estate",
  content_templates: [
    "Pillar page per topic (buying process, mortgages, visa, taxes, investment)",
    "FAQ as its own indexable text page (direct-answer opening + full transcript + VideoObject schema)",
    "'As featured in' press section",
  ],
  entity_signals: [
    "Person sameAs aggregating press/bylines/LinkedIn/YouTube/podcast/credentials (RERA/NAR/CIPS)",
    "Consistent naming across the web",
    "Author box on every page",
  ],
  local_module_config: {
    enabled: true,
    gbp_priority: "medium",
    nap_directories: ["Google Business Profile", "Apple Maps", "Bing Places"],
    multi_location: false,
  },
  citation_sources: [
    "The advisor's own resource pages",
    "Reddit",
    "Quora",
    "Financial/property publications",
    "The podcast",
  ],
  kpi_focus: [
    "Entity recognition ('who is X' answered correctly)",
    "Citation in buyer-journey prompts",
    "Video-FAQ indexation",
    "Press-to-entity linkage",
  ],
  version: "1.0.0",
  status: "seed",
};
