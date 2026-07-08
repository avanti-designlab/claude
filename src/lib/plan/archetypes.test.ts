/**
 * Channel-archetype classifier tests (M1 plan generator · Phase 1.1).
 *
 * `classifyChannel` is how free-form playbook channel_weighting keys become
 * roadmap anchors, so every real seed-playbook channel key is pinned to its
 * expected archetype. If a rule reorder ever re-buckets a live channel (e.g.
 * "Local content" flipping from content to local), a test fails here before
 * the roadmap silently shifts effort.
 */

import { describe, expect, it } from "vitest";
import {
  classifyChannel,
  topChannel,
  topChannelOfArchetype,
  weightedChannels,
  type ChannelArchetype,
} from "./archetypes";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { Playbook } from "@/lib/types/playbook";

function playbookWith(channel_weighting: Record<string, number>): Playbook {
  return { ...SEED_PLAYBOOKS["real-estate"], channel_weighting };
}

describe("classifyChannel — every live seed-playbook channel key", () => {
  // [channel key exactly as it appears in a seed playbook, expected archetype]
  const CASES: Array<[string, ChannelArchetype]> = [
    // cannabis (§2.1)
    ["Google Business Profile + local", "local"],
    ["Reddit (r/cannabis, city + strain subs)", "community"],
    ["Reviews (Google/Weedmaps/Leafly)", "reviews"],
    ["On-site education (strains, effects, terpenes)", "content"],
    ["Menu-platform + off-menu indexable pages", "content"],
    // real-estate (§2.2)
    ["On-site resource center (pillars + FAQ + video)", "content"],
    ["Entity leverage of existing PR (Person sameAs)", "entity"],
    ["Evergreen refresh (60–90 day)", "freshness"],
    ["Reddit/Quora (investor/expat threads)", "community"],
    ["LinkedIn long-form (advisor voice)", "entity"],
    ["Podcast citations on FAQ pages", "podcast"],
    // restaurants (§2.3)
    ["Reviews (Google/Yelp/TripAdvisor)", "reviews"],
    ["Menu schema + indexable menu pages", "content"],
    ["Local content (neighborhood/dish pages)", "content"],
    ["Social (Instagram — visual)", "social"],
    ["Reservation-platform presence", "local"],
    // health-life-insurance (§2.4)
    ["On-site educational content (E-E-A-T)", "content"],
    ["Licensed-agent entity signals", "entity"],
    ["Reviews (Google/Trustpilot/BBB)", "reviews"],
    ["Local + GBP (agency)", "local"],
    ["Comparison/education pillars", "content"],
    ["Reddit/Quora (personal-finance threads)", "community"],
    // ecommerce (§2.5)
    ["Product + category schema/content", "content"],
    ["Buying guides + comparison content", "content"],
    ["Reviews (on-site + third-party)", "reviews"],
    ["Third-party 'best of' listicle presence", "offsite"],
    ["Social/UGC (Instagram/TikTok)", "social"],
    ["Local", "local"],
  ];

  it.each(CASES)("%j → %s", (channel, archetype) => {
    expect(classifyChannel(channel)).toBe(archetype);
  });

  it("buckets an unrecognized channel into the content default (harmless for 0-weight rows)", () => {
    // "Meta ads" (cannabis, weight 0) matches no rule; weightedChannels drops it
    // before it could ever anchor a task, so the default bucket is inert.
    expect(classifyChannel("Meta ads")).toBe("content");
  });
});

describe("classifyChannel — rule precedence (first match wins)", () => {
  it("resolves GBP before the broad local/content catches", () => {
    expect(classifyChannel("Google Business Profile + local")).toBe("local");
  });

  it("resolves local CONTENT pages to content, not local", () => {
    expect(classifyChannel("Local content (neighborhood/dish pages)")).toBe("content");
  });

  it("resolves podcast-on-FAQ to podcast, not content, despite the FAQ keyword", () => {
    expect(classifyChannel("Podcast citations on FAQ pages")).toBe("podcast");
  });

  it("resolves third-party reviews to reviews, not offsite", () => {
    expect(classifyChannel("Reviews (on-site + third-party)")).toBe("reviews");
  });
});

describe("weightedChannels", () => {
  it("drops zero-weight channels (cannabis Meta ads, ecommerce Local)", () => {
    const cannabis = weightedChannels(SEED_PLAYBOOKS.cannabis).map((c) => c.channel);
    expect(cannabis).not.toContain("Meta ads");

    const ecommerce = weightedChannels(SEED_PLAYBOOKS.ecommerce).map((c) => c.channel);
    expect(ecommerce).not.toContain("Local");
  });

  it("drops non-finite and negative weights", () => {
    const channels = weightedChannels(
      playbookWith({ "Broken NaN": NaN, "Broken Inf": Infinity, Negative: -5, "Real pillar": 10 }),
    );
    expect(channels).toEqual([
      { channel: "Real pillar", weight: 10, archetype: "content" },
    ]);
  });

  it("sorts by weight desc with a deterministic alphabetical tiebreak (restaurants)", () => {
    expect(weightedChannels(SEED_PLAYBOOKS.restaurants).map((c) => c.channel)).toEqual([
      "Google Business Profile + local", // 35
      "Reviews (Google/Yelp/TripAdvisor)", // 25
      "Menu schema + indexable menu pages", // 15
      "Local content (neighborhood/dish pages)", // 10 — ties broken by name asc
      "Social (Instagram — visual)", // 10
      "Reservation-platform presence", // 5
    ]);
  });

  it("breaks the cannabis 20/20 tie alphabetically (Reddit before Reviews)", () => {
    const twenties = weightedChannels(SEED_PLAYBOOKS.cannabis)
      .filter((c) => c.weight === 20)
      .map((c) => c.channel);
    expect(twenties).toEqual([
      "Reddit (r/cannabis, city + strain subs)",
      "Reviews (Google/Weedmaps/Leafly)",
    ]);
  });
});

describe("topChannel / topChannelOfArchetype", () => {
  it("topChannel returns the single heaviest channel", () => {
    expect(topChannel(SEED_PLAYBOOKS.restaurants)).toEqual({
      channel: "Google Business Profile + local",
      weight: 35,
      archetype: "local",
    });
  });

  it("topChannel returns null when no channel carries weight", () => {
    expect(topChannel(playbookWith({ "Meta ads": 0 }))).toBeNull();
  });

  it("topChannelOfArchetype picks the heaviest channel of that archetype only", () => {
    // real-estate has two entity channels: PR leverage (25) beats LinkedIn (10).
    expect(topChannelOfArchetype(SEED_PLAYBOOKS["real-estate"], "entity")?.channel).toBe(
      "Entity leverage of existing PR (Person sameAs)",
    );
  });

  it("topChannelOfArchetype returns null when the archetype only exists at zero weight", () => {
    // ecommerce "Local" is weight 0 → the local archetype has no weighted channel.
    expect(topChannelOfArchetype(SEED_PLAYBOOKS.ecommerce, "local")).toBeNull();
  });
});
