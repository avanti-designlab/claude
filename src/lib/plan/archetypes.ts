/**
 * Channel-archetype classification for the plan generator (M1, doc 02).
 *
 * Playbook `channel_weighting` keys are free-form human strings ("On-site
 * resource center (pillars + FAQ + video)", "Google Business Profile + local").
 * The generator classifies each channel into ONE archetype by ordered keyword
 * match — first match wins — which then decides the owning module, automation
 * level, and task shape. This is how `channel_weighting` drives the roadmap:
 * effort follows the channels where the vertical actually builds authority.
 */

import type { Playbook } from "@/lib/types/playbook";

export type ChannelArchetype =
  | "content" // on-site pillars / FAQ / product-category / menu content + schema
  | "entity" // Person sameAs / PR entity leverage / LinkedIn thought-leadership
  | "community" // Reddit / Quora / forums — genuine participation
  | "social" // Instagram / TikTok / UGC — brand + discovery
  | "podcast" // podcast citations on FAQ pages
  | "reviews" // review velocity + response programs (or review schema when national)
  | "local" // GBP + local listings + directories + reservation platforms
  | "offsite" // third-party "best of" listicle placement (outreach)
  | "freshness"; // evergreen refresh cadence

/**
 * Ordered classifier — first matching rule wins. Order matters: strong,
 * specific signals (GBP, reservation, review) are tested before the broad
 * "content" catch so e.g. "Local content (neighborhood/dish pages)" resolves to
 * content, while "Google Business Profile + local" resolves to local.
 */
export function classifyChannel(channel: string): ChannelArchetype {
  const c = channel.toLowerCase();

  if (/(gbp|google business)/.test(c)) return "local";
  if (/(reservation|opentable|resy)/.test(c)) return "local";
  if (/review/.test(c)) return "reviews";
  if (/(reddit|quora|forum|community)/.test(c)) return "community";
  if (/podcast/.test(c)) return "podcast";
  if (/linkedin/.test(c)) return "entity";
  if (/(entity|sameas|\bpr\b|press|person)/.test(c)) return "entity";
  if (/(listicle|best of|best-of|third-?party)/.test(c)) return "offsite";
  if (/(social|instagram|tiktok|ugc)/.test(c)) return "social";
  if (/(refresh|evergreen|freshness)/.test(c)) return "freshness";
  if (
    /(content|resource|pillar|faq|guide|education|menu|product|category|schema|indexable|pages)/.test(
      c,
    )
  ) {
    return "content";
  }
  if (/local/.test(c)) return "local";
  return "content";
}

/** A `channel_weighting` entry that carries weight (weight > 0, finite). */
export interface WeightedChannel {
  channel: string;
  weight: number;
  archetype: ChannelArchetype;
}

/**
 * All channels with real (finite, > 0) weight, each classified, sorted by
 * weight desc then name asc for deterministic iteration.
 */
export function weightedChannels(playbook: Playbook): WeightedChannel[] {
  const out: WeightedChannel[] = [];
  for (const [channel, weight] of Object.entries(playbook.channel_weighting)) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    out.push({ channel, weight, archetype: classifyChannel(channel) });
  }
  return out.sort((a, b) => b.weight - a.weight || (a.channel < b.channel ? -1 : 1));
}

/** Highest-weight channel overall (deterministic), or null when none carry weight. */
export function topChannel(playbook: Playbook): WeightedChannel | null {
  return weightedChannels(playbook)[0] ?? null;
}

/** Highest-weight channel of a given archetype, or null. */
export function topChannelOfArchetype(
  playbook: Playbook,
  archetype: ChannelArchetype,
): WeightedChannel | null {
  return weightedChannels(playbook).find((c) => c.archetype === archetype) ?? null;
}
