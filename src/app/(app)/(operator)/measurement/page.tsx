import type { Metadata } from "next";
import { LineChartIcon } from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  PageContainer,
  PageHeader,
  StudioPlaceholder,
} from "../../_components/surface";

export const metadata: Metadata = {
  title: "Measurement — AEO/GEO + Brand Production OS",
  description:
    "Roll up visibility, rankings, and ROI across the whole book of clients.",
};

/**
 * Measurement (global) — the cross-client rollup of the ROI / attribution layer
 * (M16). Per-client ROI already reads on each client's workspace; the
 * book-wide rollup UI (which needs analytics connected — GA4 / Search Console /
 * call tracking) lands in a later wave. Attribution is reported honestly as
 * correlation, never causation.
 */
export default function MeasurementPage() {
  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Operations"
          title="Measurement"
          description="Tie AI visibility and rankings to real outcomes — sessions, calls, clicks, conversions, and attributed value — across every client."
        />
      </Entrance>
      <Entrance step={1}>
        <StudioPlaceholder
          icon={LineChartIcon}
          title="The measurement rollup is being built"
          lead="Per-client results already read on each client's workspace. The book-wide rollup — outcomes and attributed value across every client — arrives once analytics sources are connected."
          capabilities={[
            "Sessions, engaged sessions, and conversions from GA4",
            "Search clicks and impressions from Search Console",
            "Calls and form fills from call tracking and forms",
            "Attributed value reported as correlation, never causation",
          ]}
          note="No projected or sampled numbers — a metric appears only once its source is connected."
        />
      </Entrance>
    </PageContainer>
  );
}
