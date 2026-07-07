"use client";

/**
 * VisibilityTrend — the client's AI-visibility score over time (doc 06 §5,
 * operator dashboard + white-label client dashboard).
 *
 * Single series: an accent line over a fading accent wash. One series means
 * no legend (the title names it); the hover layer is a crosshair + the
 * shared tooltip panel.
 */

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/theme/utils";
import { AXIS_DEFAULTS, ChartTooltip, chartStroke } from "./chart-theme";

export interface VisibilityTrendPoint {
  /** Label for the x axis (date or tracker-run label). */
  date: string;
  /** Visibility score, 0–100. */
  score: number;
}

export interface VisibilityTrendProps {
  data: VisibilityTrendPoint[];
  height?: number;
  className?: string;
}

export function VisibilityTrend({ data, height = 240, className }: VisibilityTrendProps) {
  // Unique gradient id so multiple charts on one page don't collide.
  const gradientId = `visibility-wash-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={chartStroke.grid} />
          <XAxis dataKey="date" {...AXIS_DEFAULTS} minTickGap={24} dy={4} />
          <YAxis domain={[0, 100]} width={34} {...AXIS_DEFAULTS} />
          <Tooltip
            cursor={{ stroke: chartStroke.cursor, strokeWidth: 1 }}
            content={<ChartTooltip />}
          />
          <Area
            type="monotone"
            dataKey="score"
            name="Visibility score"
            stroke="var(--accent)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{
              r: 4,
              fill: "var(--accent)",
              stroke: "var(--surface)",
              strokeWidth: 2,
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
