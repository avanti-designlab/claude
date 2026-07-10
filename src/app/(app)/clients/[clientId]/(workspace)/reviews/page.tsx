import type { Metadata } from "next";
import { StarIcon } from "lucide-react";

import { readReviewSignalsForClient } from "@/lib/reviews/persist";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Reviews — Client workspace",
};

/**
 * Reviews tab — review monitoring + response drafting (M15). Reads
 * `readReviewSignalsForClient` (RLS-scoped, source='reviews'): sentiment and
 * velocity signals per capture. Unconnected platforms are excluded, never
 * counted as zero — the honesty rule the underlying signal already enforces.
 */

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

const TREND_TONE = {
  rising: "positive",
  flat: "muted",
  falling: "warm",
} as const;

export default async function ReviewsTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();
  const result = supabase
    ? await readReviewSignalsForClient(supabase, clientId)
    : ({ ok: false } as const);

  const latest =
    result.ok && result.entries.length > 0
      ? result.entries.find((e) => e.signal !== null) ?? null
      : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Reviews"
        description="Sentiment and velocity across Google, Yelp, and industry platforms — plus drafted responses that stay compliant for the vertical."
      />

      <PanelCard
        title="Review signals"
        description="The latest sentiment and velocity read for this client"
      >
        {!result.ok ? (
          <FailedState subject="review signals" />
        ) : !latest || !latest.signal ? (
          <PendingState
            icon={StarIcon}
            title="No review signals yet"
            measuring="Once review monitoring is connected, sentiment (positive / neutral / negative) and velocity land here — with unconnected platforms excluded, never counted as zero."
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Reviews read" value={latest.signal.totalIngested} />
              <Stat label="Positive" value={latest.signal.sentiment.positive} tone="positive" />
              <Stat label="Neutral" value={latest.signal.sentiment.neutral} />
              <Stat label="Negative" value={latest.signal.sentiment.negative} tone="negative" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-5 py-4">
              <div className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                  Velocity
                </span>
                <span className="text-sm text-ink">
                  {latest.signal.velocity.perDay.toFixed(1)} per day over{" "}
                  {latest.signal.windowDays} days
                </span>
              </div>
              <StatusPill tone={TREND_TONE[latest.signal.velocity.trend]}>
                {latest.signal.velocity.trend}
              </StatusPill>
            </div>
            <p className="text-xs leading-5 text-muted">
              Captured {medDate(latest.capturedAt)}
              {latest.signal.coveredPlatforms.length > 0
                ? ` · ${latest.signal.coveredPlatforms.join(", ")}`
                : ""}
              {latest.signal.excludedPlatforms.length > 0
                ? ` · excluded: ${latest.signal.excludedPlatforms.join(", ")}`
                : ""}
              .
            </p>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "positive" | "negative";
}) {
  const valueClass =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : "text-ink";
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised px-4 py-3">
      <span className={"font-display text-2xl font-bold tabular-nums " + valueClass}>
        {value}
      </span>
      <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
        {label}
      </span>
    </div>
  );
}
