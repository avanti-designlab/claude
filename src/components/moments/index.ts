/**
 * The 5 animated moments (doc 06 §4) — the ONLY places high-impact motion
 * exists in the product — plus the route-entry entrance choreography
 * (./entrance, operator direction 2026-07-08; filed under moment #5 "key
 * state transitions"). Everything else (tables, forms, settings, review
 * queues, bulk-change previews) stays quiet. Every moment renders its final
 * state instantly under reduced motion via the shared gate in
 * ./reduced-motion (the entrance uses the same policy in CSS).
 */

export {
  REDUCED_MOTION_QUERY,
  ReducedMotionProvider,
  reducedMotionSnapshot,
  resolveReducedMotion,
  subscribeToMediaQuery,
  useReducedMotion,
  type MediaQueryLike,
  type ReducedMotionProviderProps,
} from "./reduced-motion";

export {
  OnboardingPlanReveal,
  type OnboardingPlanRevealProps,
  type PlanRevealTask,
} from "./onboarding-plan-reveal";

export {
  VisibilityScoreResolve,
  type EngineDot,
  type VisibilityScoreResolveProps,
} from "./visibility-score-resolve";

export {
  TrackerResultsSettle,
  type TrackerResult,
  type TrackerResultsSettleProps,
} from "./tracker-results-settle";

export {
  InvitingEmptyState,
  type InvitingEmptyStateProps,
} from "./inviting-empty-state";

export { StateTransition, type StateTransitionProps } from "./state-transition";

export {
  Entrance,
  counterDelayMs,
  entranceDelayMs,
  ENTRANCE_BLOOM_DELAY_MS,
  ENTRANCE_DURATION_MS,
  ENTRANCE_EASE,
  ENTRANCE_SETTLE_MS,
  ENTRANCE_STAGGER_MS,
  type EntranceProps,
} from "./entrance";
