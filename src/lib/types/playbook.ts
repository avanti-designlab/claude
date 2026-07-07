/**
 * The playbook schema every vertical fills in (doc 02).
 *
 * Playbooks drive everything downstream: which prompts the tracker tests,
 * which schema to generate, where authority is built, what compliance rules
 * gate output, and how hard the local module runs. Generated playbooks (M1b)
 * follow this exact same schema — no special-casing.
 */

export type LocalIntensity = "hyper-local" | "semi-local" | "national";

export const SEED_VERTICALS = [
  "cannabis",
  "real-estate",
  "restaurants",
  "health-life-insurance",
  "ecommerce",
] as const;

export type SeedVertical = (typeof SEED_VERTICALS)[number];

/** Generated playbooks (M1b) introduce arbitrary new verticals. */
export type Vertical = SeedVertical | (string & {});

export type PromptIntent =
  | "transactional"
  | "research"
  | "educational"
  | "reputation"
  | "navigational"
  | "comparison"
  | "entity"
  | "regulatory";

export interface PromptLibraryEntry {
  prompt: string;
  /** Doc 02 marks some prompts with multiple intents (e.g. research + transactional). */
  intents: PromptIntent[];
  priority: "high" | "normal";
}

/** Schema types used across the playbooks (doc 02 schema profiles + doc 01 §6). */
export type SchemaTypeName =
  | "LocalBusiness"
  | "Store"
  | "Product"
  | "Offer"
  | "FAQPage"
  | "Organization"
  | "InsuranceAgency"
  | "Review"
  | "AggregateRating"
  | "Article"
  | "Person"
  | "RealEstateAgent"
  | "VideoObject"
  | "PodcastSeries"
  | "PodcastEpisode"
  | "BreadcrumbList"
  | "Restaurant"
  | "Menu"
  | "MenuItem"
  | "Event"
  | "Service"
  | "ItemList"
  | "Brand";

export type GbpPriority = "critical" | "high" | "medium" | "off";

export interface LocalModuleConfig {
  enabled: boolean;
  gbp_priority: GbpPriority;
  nap_directories: string[];
  multi_location: boolean;
}

/**
 * Seed playbooks are hand-authored and trusted; generated playbooks (M1b) are
 * drafts until human + Compliance approval (doc 02 §2.6).
 */
export type PlaybookStatus = "seed" | "generated_draft" | "approved";

export interface Playbook {
  vertical: Vertical;
  local_intensity: LocalIntensity;
  /** What the visibility tracker tests (M3); a living list, expanded per client. */
  prompt_library: PromptLibraryEntry[];
  /** Schema types that matter for the vertical, in priority order. */
  schema_profile: SchemaTypeName[];
  /** Channel → weight 0–100. Drives roadmap effort allocation — never even distribution. */
  channel_weighting: Record<string, number>;
  /** `skill://compliance-ruleset/<vertical>` — non-negotiable gate reference. */
  compliance_ruleset_ref: string;
  content_templates: string[];
  /** What makes the entity resolvable to AI engines. */
  entity_signals: string[];
  local_module_config: LocalModuleConfig;
  /** Third-party sources AI engines pull from in this niche. */
  citation_sources: string[];
  /** The metrics that matter most for this vertical. */
  kpi_focus: string[];
  /** Playbooks are versioned (doc 02) — compounding operator knowledge is the moat. */
  version: string;
  status: PlaybookStatus;
}
