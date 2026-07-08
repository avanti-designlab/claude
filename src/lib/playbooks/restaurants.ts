/**
 * Restaurants / food / cafes seed playbook (doc 02 §2.3) — the most local vertical.
 *
 * Google Business Profile, reviews, menus, and local schema dominate. GBP is
 * CRITICAL; multi-location is first-class (groups/franchises). From doc 02.
 */

import type { Playbook } from "@/lib/types/playbook";

export const restaurantsPlaybook: Playbook = {
  vertical: "restaurants",
  local_intensity: "hyper-local",
  prompt_library: [
    {
      prompt: "best [cuisine] restaurant near me / in [city]",
      intents: ["transactional"],
      priority: "high",
    },
    {
      prompt: "best brunch / coffee / [dish] in [neighborhood]",
      intents: ["transactional"],
      priority: "normal",
    },
    {
      prompt: "[restaurant name] menu / hours / reservations",
      intents: ["navigational"],
      priority: "normal",
    },
    { prompt: "restaurants open now near me", intents: ["transactional"], priority: "normal" },
    {
      prompt: "best [dietary: vegan/gluten-free] restaurant [city]",
      intents: ["research"],
      priority: "normal",
    },
    {
      prompt: "[restaurant name] reviews / is it good",
      intents: ["reputation"],
      priority: "normal",
    },
    {
      prompt: "romantic / group / kid-friendly restaurant [city]",
      intents: ["research"],
      priority: "normal",
    },
  ],
  schema_profile: [
    "Restaurant",
    "Menu",
    "MenuItem",
    "LocalBusiness",
    "FAQPage",
    "Review",
    "AggregateRating",
    "Event",
    "Organization",
  ],
  channel_weighting: {
    "Google Business Profile + local": 35,
    "Reviews (Google/Yelp/TripAdvisor)": 25,
    "Menu schema + indexable menu pages": 15,
    "Local content (neighborhood/dish pages)": 10,
    "Social (Instagram — visual)": 10,
    "Reservation-platform presence": 5,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/restaurants",
  content_templates: [
    "Menu page with MenuItem schema",
    "'Best [dish] in [city]' local page",
    "Dietary-option FAQ",
    "Neighborhood guide",
    "Hours/reservation FAQ",
  ],
  entity_signals: [
    "Consistent NAP across Google/Yelp/TripAdvisor/Apple Maps",
    "Menu consistency",
    "Review velocity",
    "Local media mentions",
  ],
  local_module_config: {
    enabled: true,
    gbp_priority: "critical",
    nap_directories: ["Google", "Yelp", "TripAdvisor", "Apple Maps", "OpenTable", "Resy"],
    multi_location: true,
  },
  citation_sources: [
    "Google",
    "Yelp",
    "TripAdvisor",
    "Reddit (city/food subs)",
    "Local food blogs",
  ],
  kpi_focus: [
    "Local-pack ranking",
    "'Near me' AI answer inclusion",
    "Review velocity",
    "Menu indexation",
    "Per-location visibility",
  ],
  version: "1.0.0",
  status: "seed",
};
