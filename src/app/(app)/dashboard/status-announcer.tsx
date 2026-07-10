"use client";

/**
 * The dashboard's persistent polite live region (design review, 2026-07-09,
 * Minor 9): the Generate-plan control's errors carry role="alert", but its
 * success unmounts the control (the refresh swaps it for the plan's version
 * row), so the success announcement must land in a region that OUTLIVES the
 * row — the dashboard page renders <StatusAnnouncer /> at a stable position
 * outside the card grid.
 *
 * The implementation now lives in the shared factory
 * (src/components/announcer.tsx — Design Review m3 / Code Review minor 2,
 * 2026-07-10, which also documents the survive-the-refresh and clear-then-set
 * mechanics). This module keeps the dashboard's OWN listener set and its
 * exported names, so its surface is unchanged.
 */

import { makeAnnouncer } from "@/components/announcer";

const dashboard = makeAnnouncer();

/** Politely announce `message` through every mounted StatusAnnouncer. */
export const announceStatus = dashboard.announce;

/** The dashboard's persistent live region — rendered once, outside the card grid. */
export const StatusAnnouncer = dashboard.Announcer;
