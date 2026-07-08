/**
 * playbookChannelTasks — channel starter-task generation (M1, doc 02).
 *
 * Focus: task titles. An archetype's templates can instantiate for more than
 * one carrying channel (real estate carries TWO entity channels; restaurants
 * carries two content and two local channels), so titles fold the channel's
 * plain-language subject. A shared title would break React keying in the
 * onboarding plan reveal (it keys rows by title) and reads machine-made to
 * clients — both are regressions these tests pin.
 */

import { describe, expect, it } from "vitest";
import { playbookChannelTasks } from "./channel-tasks";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";

function duplicates(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

describe("playbookChannelTasks — per-plan title uniqueness (all seed playbooks)", () => {
  for (const [vertical, playbook] of Object.entries(SEED_PLAYBOOKS)) {
    it(`${vertical}: no two starter tasks share a title`, () => {
      const titles = playbookChannelTasks(playbook).map((t) => t.title);
      expect(titles.length).toBeGreaterThan(0);
      expect(duplicates(titles)).toEqual([]);
    });
  }
});

describe("playbookChannelTasks — channel-aware titles read naturally", () => {
  it("real estate: the two entity channels get distinct, channel-specific titles", () => {
    const tasks = playbookChannelTasks(SEED_PLAYBOOKS["real-estate"]);
    const titleFor = (channel: string) =>
      tasks.find((t) => t.channel === channel && t.module === "M12")?.title;

    expect(titleFor("Entity leverage of existing PR (Person sameAs)")).toBe(
      "Consolidate your identity signals across your existing press",
    );
    expect(titleFor("LinkedIn long-form (advisor voice)")).toBe(
      "Consolidate your identity signals on LinkedIn",
    );
  });

  it("restaurants: the two content channels name their own pages", () => {
    const titles = playbookChannelTasks(SEED_PLAYBOOKS.restaurants).map((t) => t.title);
    expect(titles).toContain("Publish menu pages that answer real buyer questions directly");
    expect(titles).toContain(
      "Publish neighborhood and dish pages that answer real buyer questions directly",
    );
    expect(titles).toContain("Add structured data to your menu pages");
    expect(titles).toContain("Add structured data to your neighborhood and dish pages");
  });

  it("restaurants: GBP and reservation-platform local work get their own titles", () => {
    const titles = playbookChannelTasks(SEED_PLAYBOOKS.restaurants).map((t) => t.title);
    expect(titles).toContain("Complete every field on your Google Business Profile");
    expect(titles).toContain("Complete every field on your reservation-platform profiles");
    expect(titles).toContain("Match name, address, and phone everywhere they appear");
    expect(titles).toContain("Match your name, address, and phone across reservation platforms");
  });

  it("never leaks raw channel keys into titles (no parenthetical qualifiers)", () => {
    for (const playbook of Object.values(SEED_PLAYBOOKS)) {
      for (const task of playbookChannelTasks(playbook)) {
        expect(task.title).not.toContain("(");
        expect(task.title).not.toContain(task.channel);
      }
    }
  });
});
