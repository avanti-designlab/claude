/**
 * DESIGN PREVIEW — the content pipeline as a compact stepper (doc 06 §5:
 * "draft → humanize → review → publish"). Sequential numbering is appropriate
 * HERE because the stages are a real ordered sequence (doc 06 §2: structure
 * encodes meaning). Completed stages wear the accent; the current stage gets
 * an accent ring; pending stages stay muted. Token-driven throughout.
 */

import { cn } from "@/lib/theme/utils";

export interface PipelineStage {
  label: string;
  /** Items currently at this stage. */
  count: number;
  state: "done" | "current" | "pending";
}

export interface PipelineMiniProps {
  stages: PipelineStage[];
  className?: string;
}

export function PipelineMini({ stages, className }: PipelineMiniProps) {
  return (
    <ol className={cn("flex items-start", className)}>
      {stages.map((stage, index) => (
        <li key={stage.label} className="relative flex flex-1 flex-col items-center gap-2">
          {/* Connector to the previous node */}
          {index > 0 ? (
            <span
              aria-hidden
              className={cn(
                "absolute top-4 right-1/2 left-[-50%] h-px",
                stage.state === "pending" ? "bg-border" : "bg-accent"
              )}
            />
          ) : null}

          <span
            className={cn(
              "relative z-10 flex size-8 items-center justify-center rounded-full font-mono text-xs tabular-nums",
              stage.state === "done" && "bg-accent text-accent-foreground",
              stage.state === "current" &&
                "bg-surface text-accent ring-2 ring-accent",
              stage.state === "pending" && "bg-surface text-muted ring-1 ring-border"
            )}
          >
            {stage.count}
          </span>
          <span
            className={cn(
              "text-center text-xs",
              stage.state === "pending" ? "text-muted" : "text-ink"
            )}
          >
            {stage.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
