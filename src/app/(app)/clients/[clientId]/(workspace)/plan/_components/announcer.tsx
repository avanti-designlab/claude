"use client";

/**
 * The plan tab's persistent polite live region. The Generate-plan control and
 * the per-row status controls announce their successes here; the plan page
 * renders <PlanAnnouncer /> at a stable position outside the task list, so the
 * region outlives the announcing control's unmount across router.refresh().
 *
 * The implementation lives in the shared factory (src/components/announcer.tsx
 * — Design Review m3 / Code Review minor 2, 2026-07-10, which documents the
 * survive-the-refresh and clear-then-set mechanics). This module holds the plan
 * tab's OWN listener set, isolated from the dashboard's and the queue's.
 */

import { makeAnnouncer } from "@/components/announcer";

const plan = makeAnnouncer();

/** Politely announce `message` through every mounted PlanAnnouncer. */
export const announcePlan = plan.announce;

/** The plan tab's persistent live region — rendered once, outside the task list. */
export const PlanAnnouncer = plan.Announcer;
