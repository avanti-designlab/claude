/**
 * DESIGN PREVIEW components — the operator's Spendex-craft dashboard target
 * (a visual reference the real M19 module will match, doc 07 §1.10). These are
 * NOT frozen component-library primitives; they compose the frozen tokens,
 * charts, and reduced-motion gate to show the target aesthetic in the operator
 * brand. Every color is a token — the preview re-skins per tenant like the app.
 */

export {
  ArrowButton,
  type ArrowButtonProps,
  type ArrowButtonSize,
  type ArrowButtonTone,
} from "./arrow-button";
export { CountUpValue, useCountUp, type CountUpValueProps } from "./count-up";
export { Delta, type DeltaProps } from "./delta";
export { WashPill, type WashPillProps, type WashPillTone } from "./wash-pill";
export { StatCard, type StatCardProps, type StatTone } from "./stat-card";
export {
  VisibilityGauge,
  type VisibilityGaugeProps,
  type GaugeTone,
  type GaugeSize,
} from "./visibility-gauge";
export { PillBars, type PillBarEntry, type PillBarsProps } from "./pill-bars";
export { AlertsList, type AlertItem, type AlertsListProps, type AlertTone } from "./alerts-list";
export { PipelineMini, type PipelineMiniProps, type PipelineStage } from "./pipeline-mini";
