"use client";

/**
 * The Review & Approvals persistent polite live region. A decision (approve /
 * verdict / send-back / resubmit) succeeds, the page router-refreshes to show
 * the new status, and the outcome is announced through THIS region — which the
 * detail page renders at a STABLE position outside the decision panel, because
 * the controls that triggered the action re-render or disappear on success and
 * a region inside them could be torn out of the accessibility tree with its
 * announcement unspoken.
 *
 * The implementation now lives in the shared factory
 * (src/components/announcer.tsx — Design Review m3 / Code Review minor 2,
 * 2026-07-10, which also documents the survive-the-refresh and clear-then-set
 * mechanics). This module keeps the queue's OWN listener set and its exported
 * names, so its surface is unchanged.
 */

import { makeAnnouncer } from "@/components/announcer";

const reviewQueue = makeAnnouncer();

/** Politely announce `message` through every mounted ReviewStatusAnnouncer. */
export const announceReview = reviewQueue.announce;

/** The queue's persistent live region — rendered once, outside the decision panel. */
export const ReviewStatusAnnouncer = reviewQueue.Announcer;
