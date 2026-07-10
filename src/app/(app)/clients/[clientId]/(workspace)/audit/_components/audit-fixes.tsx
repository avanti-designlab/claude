import { CheckCircle2Icon } from "lucide-react";

import type { ImpactLevel } from "@/lib/skills/aeo-audit";
import type { AuditFixView } from "@/lib/intelligence/audit/rows";
import type { AuditFixesRead } from "@/lib/intelligence/audit/persist";
import {
  EmptyState,
  FailedState,
  StatusPill,
} from "../../../../../_components/surface";

/**
 * Audit fix list — the latest audit's PRIORITIZED recommendations, rendered from
 * the `audits.fixes` payload (doc 05 M2: "the fix list IS the product"). Server
 * component, deliberately UTILITARIAN (doc 06 §4/§5): no glow, no motion, and —
 * critically — NO fix buttons / auto-fix affordance. These are recommendations;
 * applying one runs through the change-management layer (review + approval +
 * reversible change log), which is a later wiring. Everything shown is the
 * engine's own copy (title / detail / impactEstimate) and its real impact scale;
 * nothing is invented and no internal code (checkId, module, priorityScore) is
 * rendered. Long lists collapse behind a native <details> (no JS).
 */

/** How many fixes render before the rest collapse behind "Show more". */
const VISIBLE_FIXES = 8;
/** How many target URLs render inline per fix before an honest "+N more". */
const VISIBLE_TARGETS = 4;

type PillTone = "muted" | "accent" | "positive" | "warm" | "negative";

/** The engine's real impact scale → label + tone (descending visual weight). */
const IMPACT_META: Record<ImpactLevel, { label: string; tone: PillTone }> = {
  critical: { label: "Critical", tone: "negative" },
  high: { label: "High", tone: "warm" },
  medium: { label: "Medium", tone: "accent" },
  low: { label: "Low", tone: "muted" },
};

export function AuditFixes({ read }: { read: AuditFixesRead }) {
  if (!read.ok) return <FailedState subject="the fix list" />;

  const { rawCount, fixes } = read;

  if (fixes.length === 0) {
    // rawCount 0 = a genuinely clean audit; rawCount > 0 = the stored fixes
    // couldn't be parsed (drift/corruption) — both honest, neither invents work.
    return rawCount === 0 ? (
      <EmptyState
        icon={CheckCircle2Icon}
        title="No fixes to prioritize"
        description="This audit didn't flag anything to fix — the site passed every applicable check for its playbook. New issues show up here after the next audit."
      />
    ) : (
      <EmptyState
        icon={CheckCircle2Icon}
        title="Fixes couldn't be displayed"
        description={`This audit recorded ${rawCount} ${rawCount === 1 ? "fix" : "fixes"}, but they couldn't be read back. Run the audit again to refresh the list.`}
      />
    );
  }

  const visible = fixes.slice(0, VISIBLE_FIXES);
  const overflow = fixes.slice(VISIBLE_FIXES);
  const dropped = rawCount - fixes.length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-5 text-muted">
        Prioritized highest-impact first. These are recommendations — nothing
        here changes the site; applying a fix runs through review and approval
        with a reversible change log, wired up in a later step.
      </p>

      {dropped > 0 ? (
        <p className="text-xs leading-5 text-muted">
          Showing {fixes.length} of {rawCount} — {dropped}{" "}
          {dropped === 1 ? "fix" : "fixes"} couldn&apos;t be displayed.
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {visible.map((fix) => (
          <FixCard key={fix.id} fix={fix} />
        ))}
      </ul>

      {overflow.length > 0 ? (
        <details className="group">
          <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-sm font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60">
            <span className="group-open:hidden">
              Show {overflow.length} more{" "}
              {overflow.length === 1 ? "fix" : "fixes"}
            </span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {overflow.map((fix) => (
              <FixCard key={fix.id} fix={fix} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function FixCard({ fix }: { fix: AuditFixView }) {
  const impact = fix.impact ? IMPACT_META[fix.impact] : null;
  const shownTargets = fix.targetUrls.slice(0, VISIBLE_TARGETS);
  const moreTargets = fix.targetUrls.length - shownTargets.length;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {impact ? <StatusPill tone={impact.tone}>{impact.label}</StatusPill> : null}
        <span className="text-sm font-medium text-ink">{fix.title}</span>
      </div>

      {fix.detail ? (
        <p className="text-[13px] leading-5 text-muted">{fix.detail}</p>
      ) : null}

      {fix.targetUrls.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted uppercase">
            Where
          </span>
          {shownTargets.map((url) => (
            <span
              key={url}
              className="max-w-full truncate font-mono text-muted"
              title={url}
            >
              {url}
            </span>
          ))}
          {moreTargets > 0 ? (
            <span className="text-muted">
              +{moreTargets} more {moreTargets === 1 ? "page" : "pages"}
            </span>
          ) : null}
        </div>
      ) : null}

      {fix.impactEstimate ? (
        <p className="text-xs leading-5 text-muted">{fix.impactEstimate}</p>
      ) : null}
    </li>
  );
}
