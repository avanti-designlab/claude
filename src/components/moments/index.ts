/**
 * The 5 animated moments (doc 06 §4) — the ONLY places high-impact motion
 * exists in the product. Everything else (tables, forms, settings, review
 * queues, bulk-change previews) stays quiet. Every moment renders its final
 * state instantly under reduced motion via the shared gate in
 * ./reduced-motion.
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
