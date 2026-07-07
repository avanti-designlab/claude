"use client";

/**
 * Moment 2 of 5 — the SIGNATURE (doc 06 §2, §4.2): the Visibility Score
 * resolves out of noise on dashboard load / each new tracker run, and the
 * per-engine citation dots settle into place.
 *
 * Discipline:
 * - The score box and dot row have RESERVED dimensions — zero layout shift
 *   (doc 06 §7). Digits sit in fixed 1ch slots; dots animate transform and
 *   opacity only.
 * - Reduced motion (or SSR): the final state renders immediately.
 * - Status dots always carry an engine label — color is never the only
 *   signal.
 */

import * as React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/theme/utils";
import type { CitationStatus } from "@/components/charts/engine-citations";
import { useReducedMotion } from "./reduced-motion";

export interface EngineDot {
  engine: string;
  status: CitationStatus;
}

export interface VisibilityScoreResolveProps {
  /** The resolved visibility score, 0–100. */
  score: number;
  engines?: EngineDot[];
  label?: string;
  /** Secondary line under the score, e.g. "+6 since last run". */
  caption?: string;
  className?: string;
}

const NOISE_TICK_MS = 55;
const NOISE_HOLD_MS = 650;
const DIGIT_LOCK_STEP_MS = 160;

const DOT_CLASS: Record<CitationStatus, string> = {
  cited: "bg-positive",
  lost: "bg-negative",
  missing: "bg-muted",
};

const STATUS_LABEL: Record<CitationStatus, string> = {
  cited: "cited",
  lost: "lost",
  missing: "not cited",
};

/**
 * Digit state for one resolve pass. The caller remounts this hook's owner
 * (via key) whenever the score changes, so all state updates happen in async
 * timer callbacks — never synchronously inside the effect. Under reduced
 * motion the animated state is ignored entirely (final state is derived).
 */
function useDigitResolve(finalDigits: string[], reduced: boolean) {
  // Deterministic pseudo-noise for the first paint (SSR-safe).
  const [display, setDisplay] = React.useState<string[]>(() =>
    finalDigits.map((_, index) => String((index * 7 + 3) % 10))
  );
  const [lockedCount, setLockedCount] = React.useState(0);
  const lockedRef = React.useRef(0);

  React.useEffect(() => {
    if (reduced) return; // final state is derived; nothing to animate

    const noise = setInterval(() => {
      setDisplay(
        finalDigits.map((digit, index) =>
          index < lockedRef.current ? digit : String(Math.floor(Math.random() * 10))
        )
      );
    }, NOISE_TICK_MS);

    const locks = finalDigits.map((_, index) =>
      setTimeout(() => {
        lockedRef.current = index + 1;
        setLockedCount(index + 1);
      }, NOISE_HOLD_MS + (index + 1) * DIGIT_LOCK_STEP_MS)
    );
    const settle = setTimeout(
      () => {
        clearInterval(noise);
        setDisplay(finalDigits);
      },
      NOISE_HOLD_MS + (finalDigits.length + 1) * DIGIT_LOCK_STEP_MS
    );

    return () => {
      clearInterval(noise);
      clearTimeout(settle);
      for (const lock of locks) clearTimeout(lock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the owner remounts (key) when the digits change
  }, [reduced]);

  const settled = reduced || lockedCount >= finalDigits.length;
  return {
    display: settled ? finalDigits : display,
    lockedCount: settled ? finalDigits.length : lockedCount,
    settled,
  };
}

export function VisibilityScoreResolve({ score, ...rest }: VisibilityScoreResolveProps) {
  const rounded = Math.round(Math.min(100, Math.max(0, score)));
  // Keyed by the value: a new score remounts the resolve pass cleanly.
  return <ScoreResolvePass key={rounded} score={rounded} {...rest} />;
}

function ScoreResolvePass({
  score,
  engines = [],
  label = "Visibility score",
  caption,
  className,
}: VisibilityScoreResolveProps) {
  const reduced = useReducedMotion();
  const finalDigits = React.useMemo(() => String(score).split(""), [score]);
  const { display, lockedCount, settled } = useDigitResolve(finalDigits, reduced);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <p className="font-mono text-xs tracking-[0.18em] text-muted uppercase">{label}</p>

      {/* Reserved box: width = digit count, height = one line of the score step. */}
      <div
        aria-label={`${label}: ${Math.round(score)}`}
        className="flex items-baseline gap-1"
      >
        <span
          className="font-display text-score text-ink"
          style={{ width: `${finalDigits.length}ch` }}
        >
          {display.map((digit, index) => (
            <span
              key={index}
              aria-hidden
              className={cn(
                "inline-block w-[1ch] text-center transition-opacity duration-150",
                index < lockedCount || settled || reduced
                  ? "opacity-100"
                  : "opacity-40"
              )}
            >
              {digit}
            </span>
          ))}
        </span>
        <span className="font-mono text-lg text-muted">/100</span>
      </div>

      {/* Per-engine citation dots — reserved row height; transform/opacity only. */}
      {engines.length > 0 ? (
        <ul className="flex flex-wrap items-start gap-x-5 gap-y-2">
          {engines.map(({ engine, status }, index) => {
            const dot = (
              <span
                aria-hidden
                className={cn("size-2.5 rounded-full", DOT_CLASS[status])}
              />
            );
            return (
              <li
                key={engine}
                className="flex h-10 flex-col items-center gap-1.5"
                title={`${engine}: ${STATUS_LABEL[status]}`}
              >
                {reduced ? (
                  dot
                ) : (
                  <motion.span
                    initial={{ opacity: 0, y: index % 2 === 0 ? -10 : 10, scale: 0.4 }}
                    animate={settled ? { opacity: 1, y: 0, scale: 1 } : {}}
                    transition={{
                      type: "spring",
                      stiffness: 420,
                      damping: 24,
                      delay: index * 0.07,
                    }}
                    className="inline-flex"
                  >
                    {dot}
                  </motion.span>
                )}
                <span className="font-mono text-[10px] leading-none text-muted">
                  {engine}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Caption space is always reserved; only opacity changes. */}
      <p
        className={cn(
          "min-h-5 text-sm text-muted transition-opacity duration-300",
          caption && (settled || reduced) ? "opacity-100" : "opacity-0"
        )}
      >
        {caption ?? ""}
      </p>
    </div>
  );
}
