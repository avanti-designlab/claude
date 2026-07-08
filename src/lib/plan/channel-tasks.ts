/**
 * Per-archetype playbook task generation (M1, doc 02 / doc 07 §1.1).
 *
 * archetypes.ts classifies each carrying `channel_weighting` key into an
 * archetype; this module turns each classified channel into that archetype's
 * starter tasks. Every task's priority is channel weight × impact factor
 * (scoring.ts), so effort follows where the vertical builds authority — never
 * an even split (doc 02).
 *
 * Automation levels follow doc 03 §6: anything that publishes is
 * `ai_draft_human_approve` (never "auto"); authenticity work (community
 * participation, review asks, outreach) is `human_only`. Playbook starters use
 * only high/medium impact — "critical" is reserved for gaps the audit actually
 * found, so merged audit fixes lead the roadmap.
 *
 * Task text is Content-Quality-gated plan copy: specific, actionable, sentence
 * case, no module codes in titles.
 */

import type { Playbook } from "@/lib/types/playbook";
import type { AutomationLevel } from "@/lib/types/db";
import type { ImpactLevel, ModuleRef, RoadmapTask } from "@/lib/types/roadmap";
import { priorityScore } from "./scoring";
import { localOff } from "./audit-merge";
import {
  weightedChannels,
  type ChannelArchetype,
  type WeightedChannel,
} from "./archetypes";

/** Inputs a template's description can draw on. */
interface TemplateContext {
  channel: WeightedChannel;
  playbook: Playbook;
}

interface ChannelTaskTemplate {
  /** Stable id fragment — task id = `playbook/<channel-slug>/<slug>`. */
  slug: string;
  module: ModuleRef;
  impact: ImpactLevel;
  /** Relative effort 1–5. */
  effortWeight: number;
  /** doc 03 §6 — publishing → ai_draft_human_approve; authenticity → human_only. */
  automationLevel: AutomationLevel;
  title: string;
  describe: (ctx: TemplateContext) => string;
}

/**
 * A channel key without its parenthetical qualifier, for use in prose —
 * "Local content (neighborhood/dish pages)" → "Local content".
 */
export function channelFocus(channel: string): string {
  const stripped = channel
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : channel;
}

/** Deterministic id fragment from a channel key. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "channel";
}

/** First `max` non-blank items joined for prose; "" when none. */
function shortList(items: string[], max: number, separator = ", "): string {
  return items
    .filter((item) => item.trim().length > 0)
    .slice(0, max)
    .join(separator);
}

const ARCHETYPE_TEMPLATES: Record<ChannelArchetype, ChannelTaskTemplate[]> = {
  content: [
    {
      slug: "direct-answer-pages",
      module: "M8",
      impact: "high",
      effortWeight: 3,
      automationLevel: "ai_draft_human_approve",
      title: "Publish pages that answer real buyer questions directly",
      describe: ({ channel, playbook }) =>
        `For ${channelFocus(channel.channel)}, publish pages that open with a direct answer to one question buyers actually ask. Start from the playbook's templates: ${
          shortList(playbook.content_templates, 2, "; ") ||
          "the questions this vertical's buyers ask most"
        }.`,
    },
    {
      slug: "structured-data",
      module: "M10",
      impact: "medium",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Add structured data to the pages in this channel",
      describe: ({ channel, playbook }) =>
        `Mark up the ${channelFocus(channel.channel)} pages with the schema types AI engines read first for this vertical: ${
          shortList(playbook.schema_profile, 3) || "the playbook's schema profile"
        }. Every block is validated before it ships.`,
    },
  ],
  entity: [
    {
      slug: "entity-signals",
      module: "M12",
      impact: "high",
      effortWeight: 3,
      automationLevel: "ai_draft_human_approve",
      title: "Make the business easy for AI engines to identify",
      describe: ({ channel, playbook }) =>
        `Use ${channelFocus(channel.channel)} to tie everything to one consistent identity. The signals that matter here: ${
          shortList(playbook.entity_signals, 2, "; ") ||
          "consistent naming and linked profiles across the web"
        }.`,
    },
  ],
  community: [
    {
      slug: "community-participation",
      module: "M11",
      impact: "medium",
      effortWeight: 3,
      automationLevel: "human_only",
      title: "Take part in the communities where buyers ask for advice",
      describe: ({ channel }) =>
        `Join the real conversations on ${channelFocus(channel.channel)}: answer questions with substance, say who you are, and link only when it genuinely helps. This work stays human — no automated posting.`,
    },
  ],
  social: [
    {
      slug: "social-cadence",
      module: "M11",
      impact: "medium",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Keep a steady posting rhythm on social",
      describe: ({ channel }) =>
        `Plan a weekly cadence for ${channelFocus(channel.channel)} built on real work and real customers — this is where engines pick up how people actually talk about the brand.`,
    },
  ],
  podcast: [
    {
      slug: "podcast-citations",
      module: "M12",
      impact: "medium",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Pair each podcast episode with the page it answers",
      describe: ({ channel }) =>
        `For ${channelFocus(channel.channel)}, place every relevant episode on the FAQ or resource page it speaks to, with a transcript and episode markup so engines can cite the audio.`,
    },
  ],
  reviews: [
    {
      slug: "review-velocity",
      module: "M15",
      impact: "high",
      effortWeight: 2,
      automationLevel: "human_only",
      title: "Ask every happy customer for a review",
      describe: ({ channel }) =>
        `Keep a steady, genuine flow of reviews on ${channelFocus(channel.channel)}. Build the ask into the service moment itself — no incentives, no gating, no scripts.`,
    },
    {
      slug: "review-responses",
      module: "M15",
      impact: "medium",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Respond to every new review within a few days",
      describe: ({ channel }) =>
        `Reply on ${channelFocus(channel.channel)} in the brand's voice — engines read the responses as part of the business's public record.`,
    },
  ],
  local: [
    {
      slug: "business-profiles",
      module: "M14",
      impact: "high",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Complete every field on each business profile",
      describe: ({ channel }) =>
        `For ${channelFocus(channel.channel)}, fill in categories, hours, photos, attributes, and services for every location — and keep them current as things change.`,
    },
    {
      slug: "nap-consistency",
      module: "M14",
      impact: "high",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Match name, address, and phone everywhere they appear",
      describe: ({ playbook }) =>
        `Keep listings identical across ${
          shortList(playbook.local_module_config.nap_directories, 4) ||
          "every directory that lists the business"
        }. Mismatched details cost trust with both engines and customers.`,
    },
  ],
  offsite: [
    {
      slug: "earned-listicles",
      module: "M12",
      impact: "high",
      effortWeight: 3,
      automationLevel: "human_only",
      title: "Earn places on the third-party lists engines cite",
      describe: ({ channel, playbook }) =>
        `For ${channelFocus(channel.channel)}, find the roundups and comparison lists AI engines actually cite in this niche — ${
          shortList(playbook.citation_sources, 3) || "the sources engines already trust"
        } — and pitch genuine inclusion. Earned placement only; no paid links.`,
    },
  ],
  freshness: [
    {
      slug: "evergreen-refresh",
      module: "M6",
      impact: "medium",
      effortWeight: 2,
      automationLevel: "ai_draft_human_approve",
      title: "Refresh evergreen pages on a fixed cycle",
      describe: ({ channel }) =>
        `For ${channelFocus(channel.channel)}, re-verify facts, figures, and examples on schedule. The modified date changes only where a real edit was made — never as a cosmetic bump.`,
    },
  ],
};

/**
 * When the local module is off (national vertical or disabled config), review
 * work shifts from velocity/response programs to on-site review markup —
 * mirroring the archetype note in archetypes.ts ("review schema when national").
 */
const NATIONAL_REVIEWS_TEMPLATES: ChannelTaskTemplate[] = [
  {
    slug: "review-markup",
    module: "M10",
    impact: "high",
    effortWeight: 2,
    automationLevel: "ai_draft_human_approve",
    title: "Mark up reviews so engines can read them",
    describe: ({ channel }) =>
      `For ${channelFocus(channel.channel)}, publish review and aggregate-rating markup on the pages where reviews live, and keep third-party review profiles complete and current.`,
  },
];

function templatesFor(
  archetype: ChannelArchetype,
  localIsOff: boolean,
): ChannelTaskTemplate[] {
  if (localIsOff) {
    // Mirrors auditTasks' M14/M15 gate: no local work-streams for local-off playbooks.
    if (archetype === "local") return [];
    if (archetype === "reviews") return NATIONAL_REVIEWS_TEMPLATES;
  }
  return ARCHETYPE_TEMPLATES[archetype];
}

/**
 * Generate the playbook's channel starter tasks: every carrying channel yields
 * its archetype's templates, scored by channel weight × impact. Pure and
 * deterministic — channel order comes from weightedChannels (weight desc,
 * name asc).
 */
export function playbookChannelTasks(playbook: Playbook): RoadmapTask[] {
  const localIsOff = localOff(playbook);
  const tasks: RoadmapTask[] = [];
  const usedIds = new Set<string>();

  for (const channel of weightedChannels(playbook)) {
    const channelSlug = slugify(channel.channel);
    for (const template of templatesFor(channel.archetype, localIsOff)) {
      // Distinct channel keys almost always slugify distinctly; on the rare
      // collision, suffix deterministically rather than drop or duplicate.
      let id = `playbook/${channelSlug}/${template.slug}`;
      for (let n = 2; usedIds.has(id); n++) {
        id = `playbook/${channelSlug}-${n}/${template.slug}`;
      }
      usedIds.add(id);

      tasks.push({
        id,
        title: template.title,
        description: template.describe({ channel, playbook }),
        module: template.module,
        channel: channel.channel,
        source: "playbook",
        impact: template.impact,
        priorityScore: priorityScore(channel.weight, template.impact),
        effortWeight: template.effortWeight,
        automationLevel: template.automationLevel,
      });
    }
  }
  return tasks;
}
