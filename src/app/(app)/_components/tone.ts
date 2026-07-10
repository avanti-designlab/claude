/**
 * Re-export of the shared tone module — the single source now lives at
 * src/components/tone.ts (see its header for the recipes + the "app-utility
 * layer over F2 tokens, not frozen F2" governance note). This path stays so
 * app-layer imports (and the review-queue re-export chain) keep working.
 */
export {
  WARM_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
  NEGATIVE_TEXT_CLASS,
} from "@/components/tone";
