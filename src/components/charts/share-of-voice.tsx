"use client";

/**
 * ShareOfVoice — the client vs named competitors (doc 06 §5).
 *
 * Identity through the accent: the client's bar wears the tenant accent;
 * competitors recede into a neutral ink wash. Color follows the entity —
 * filtering competitors never repaints the client. Values are direct-labeled
 * in text tokens (mono numerals), so no legend is needed.
 */

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/theme/utils";
import { AXIS_DEFAULTS, ChartTooltip, chartStroke } from "./chart-theme";

export interface ShareOfVoiceEntry {
  name: string;
  /** Share of voice, 0–100 (%). */
  share: number;
  /** True for the tenant's client — the entity the accent follows. */
  isClient?: boolean;
}

export interface ShareOfVoiceProps {
  data: ShareOfVoiceEntry[];
  height?: number;
  className?: string;
}

const formatPercent = (value: number) => `${value}%`;

export function ShareOfVoice({ data, height = 240, className }: ShareOfVoiceProps) {
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 44, bottom: 0, left: 8 }}
          barCategoryGap="28%"
        >
          <XAxis type="number" domain={[0, "dataMax"]} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={128}
            {...AXIS_DEFAULTS}
            tick={{ ...AXIS_DEFAULTS.tick, fill: "var(--ink)", fontFamily: "var(--font-body)", fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: "color-mix(in oklab, var(--ink) 5%, transparent)" }}
            content={<ChartTooltip format={formatPercent} />}
          />
          <Bar dataKey="share" name="Share of voice" barSize={14} radius={[0, 4, 4, 0]}>
            {data.map((entry) => (
              <Cell
                key={entry.name}
                fill={entry.isClient ? "var(--accent)" : chartStroke.neutralSeries}
              />
            ))}
            <LabelList
              dataKey="share"
              position="right"
              formatter={(value) => formatPercent(Number(value))}
              style={{
                fill: "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
