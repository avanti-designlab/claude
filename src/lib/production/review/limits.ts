/**
 * Review-lifecycle input caps — a PURE constants module (no "use server", no
 * server imports, no logic) so the landed actions AND the review UI import ONE
 * source of truth instead of mirroring literals (Code Review c2, 2026-07-10).
 * Safe to import from client components; changing a cap here changes both the
 * server clamp and the UI affordance together.
 */

/** Max chars for a send-back reason (recorded as the failing verdict's note). */
export const REASON_MAX = 2000;

/** Max chars for an optional reviewer note on a recorded verdict. */
export const NOTE_MAX = 2000;
