/**
 * aeo-audit — inline test fixtures (used only by *.test.ts in this directory).
 * Fixture playbooks mirror doc 02's seed playbooks closely enough to exercise
 * the semi-local (real estate), national (e-commerce), and hyper-local
 * (restaurants) paths.
 */

import type { Playbook } from "@/lib/types/playbook";
import type { CheckContext, CrawledPage, CrawledSite } from "./types";

export const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
export const FRESH_DATE = "2026-06-20T00:00:00.000Z"; // 11 days before crawl
export const STALE_DATE = "2026-01-01T00:00:00.000Z"; // 181 days before crawl

export const realEstatePlaybook: Playbook = {
  vertical: "real-estate",
  local_intensity: "semi-local",
  prompt_library: [
    { prompt: "best dubai real estate advisor for expats", intents: ["entity"], priority: "high" },
    { prompt: "can foreigners get a mortgage in dubai", intents: ["research"], priority: "normal" },
  ],
  schema_profile: ["Person", "RealEstateAgent", "FAQPage", "Article", "VideoObject", "BreadcrumbList"],
  channel_weighting: {
    "On-site resource center (pillars + FAQ + video)": 30,
    "Entity leverage of existing PR (Person sameAs)": 25,
    "Evergreen refresh (60-90 day)": 15,
    "Reddit/Quora (investor/expat threads)": 12,
    "LinkedIn long-form (advisor's voice)": 10,
    "Podcast citations on FAQ pages": 8,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/real-estate",
  content_templates: ["pillar pages per topic", "FAQ page with direct answer + transcript + VideoObject"],
  entity_signals: ["Person sameAs aggregating press", "consistent naming", "author box on every page"],
  local_module_config: {
    enabled: true,
    gbp_priority: "medium",
    nap_directories: ["Google", "Yelp"],
    multi_location: false,
  },
  citation_sources: ["own resource pages", "Reddit", "Quora"],
  kpi_focus: ["entity recognition", "citation in buyer-journey prompts"],
  version: "1.0.0",
  status: "seed",
};

export const ecommercePlaybook: Playbook = {
  vertical: "ecommerce",
  local_intensity: "national",
  prompt_library: [
    { prompt: "best standing desk for small spaces", intents: ["transactional"], priority: "high" },
  ],
  schema_profile: ["Product", "Offer", "AggregateRating", "Organization", "FAQPage", "Article", "BreadcrumbList", "ItemList"],
  channel_weighting: {
    "Product + category schema/content": 30,
    "Buying guides + comparison content": 25,
    "Reviews (on-site + third-party)": 20,
    "Third-party 'best of' listicle presence": 15,
    "Social/UGC (visual, Instagram/TikTok)": 10,
    Local: 0,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/ecommerce",
  content_templates: ["product pages with full schema", "best-of buying guides (ItemList)"],
  entity_signals: ["Brand/Organization schema", "review aggregation"],
  local_module_config: {
    enabled: false,
    gbp_priority: "off",
    nap_directories: [],
    multi_location: false,
  },
  citation_sources: ["Reddit", "review sites", "best-of listicles"],
  kpi_focus: ["citation in 'best [category]' prompts"],
  version: "1.0.0",
  status: "seed",
};

export const restaurantPlaybook: Playbook = {
  vertical: "restaurants",
  local_intensity: "hyper-local",
  prompt_library: [
    { prompt: "best brunch in hillcrest", intents: ["transactional"], priority: "high" },
  ],
  schema_profile: ["Restaurant", "Menu", "FAQPage", "Review", "Organization"],
  channel_weighting: {
    "Google Business Profile + local": 35,
    "Reviews (Google/Yelp/TripAdvisor)": 25,
    "Menu schema + indexable menu pages": 15,
    "Local content (neighborhood/dish pages)": 10,
    "Social (Instagram - visual)": 10,
    "Reservation-platform presence": 5,
  },
  compliance_ruleset_ref: "skill://compliance-ruleset/restaurants",
  content_templates: ["menu pages with MenuItem schema", "neighborhood guides"],
  entity_signals: ["consistent NAP", "review velocity"],
  local_module_config: {
    enabled: true,
    gbp_priority: "critical",
    nap_directories: ["Google", "Yelp", "TripAdvisor"],
    multi_location: true,
  },
  citation_sources: ["Google", "Yelp", "TripAdvisor"],
  kpi_focus: ["local-pack ranking", "review velocity"],
  version: "1.0.0",
  status: "seed",
};

export const BASE_URL = "https://example.com";

/** A healthy page; override fields per test. */
export function makePage(overrides: Partial<CrawledPage> & { url: string }): CrawledPage {
  return {
    title: `Page title for ${overrides.url}`,
    metaDescription:
      `A useful, specific description of ${overrides.url} that lands within the recommended length band for snippets.`,
    h1s: ["A single clear H1"],
    visibleText:
      "Substantive visible text content about the topic, updated regularly, answering real questions with real information.",
    jsonLdBlocks: [],
    images: [{ src: "/img/a.jpg", alt: "Descriptive alt" }],
    internalLinks: [],
    hasVideo: false,
    hasTranscript: false,
    lastModified: FRESH_DATE,
    rendersWithoutJs: true,
    ...overrides,
  };
}

/** A healthy small site; override fields per test. */
export function makeSite(overrides: Partial<CrawledSite> = {}): CrawledSite {
  const home = makePage({
    url: `${BASE_URL}/`,
    internalLinks: [`${BASE_URL}/about`, `${BASE_URL}/faq`],
  });
  const about = makePage({
    url: `${BASE_URL}/about`,
    title: "About our advisory team",
    internalLinks: [`${BASE_URL}/`, `${BASE_URL}/faq`],
  });
  const faq = makePage({
    url: `${BASE_URL}/faq`,
    title: "Frequently asked questions",
    internalLinks: [`${BASE_URL}/`],
  });
  return {
    baseUrl: BASE_URL,
    crawledAt: CRAWLED_AT,
    pages: [home, about, faq],
    robotsTxt: "User-agent: *\nAllow: /",
    llmsTxt: "# Example\n\nKey pages:\n- [FAQ](https://example.com/faq)\n",
    ...overrides,
  };
}

export function jsonLd(value: unknown): string {
  return JSON.stringify(value);
}

/** Check context for direct per-check tests. */
export function ctx(
  site: CrawledSite,
  playbook: Playbook = realEstatePlaybook,
  refreshWindowDays = 90,
): CheckContext {
  return { site, playbook, options: { refreshWindowDays } };
}

/** Deep-clone helper so determinism tests can re-run on fresh objects. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
