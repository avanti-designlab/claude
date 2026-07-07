/**
 * F2 Recharts visual language — the only chart components feature UI may
 * use. Colors, axes, grids, and tooltips are encoded here once; a chart
 * never picks its own colors (doc 06 §8.3).
 */

export { AXIS_DEFAULTS, ChartTooltip, chartStroke } from "./chart-theme";
export {
  VisibilityTrend,
  type VisibilityTrendPoint,
  type VisibilityTrendProps,
} from "./visibility-trend";
export {
  ShareOfVoice,
  type ShareOfVoiceEntry,
  type ShareOfVoiceProps,
} from "./share-of-voice";
export {
  EngineCitations,
  type CitationStatus,
  type EngineCitation,
  type EngineCitationsProps,
} from "./engine-citations";
