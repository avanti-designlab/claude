"use client";

/**
 * The white-label proof (doc 06 §3): shows what the theming engine decided
 * for the selected tenant — applied / corrected / refused — with the full
 * contrast report. This is the "auto-correction report surfacing" surface
 * the F2 review requires.
 */

import { CheckIcon, ShieldAlertIcon, WandSparklesIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DemoTenant } from "@/lib/theme/demo-themes";
import type { TenantThemeResolution } from "@/lib/theme/engine";
import { Section, SpecimenPanel } from "./section";

function Swatch({ value }: { value: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 rounded-xs border align-[-2px]"
      style={{ backgroundColor: value }}
    />
  );
}

export function ThemingSection({
  tenant,
  resolution,
}: {
  tenant: DemoTenant;
  resolution: TenantThemeResolution | null;
}) {
  return (
    <Section
      id="theming"
      overline="02 · White-label theming"
      title="One pipeline, every tenant"
      description="The switcher above re-skins this entire page — components, charts, moments — by overriding the same custom properties through resolveTenantTheme(). No component changed. Every palette passes the same contrast gate; what the gate did is reported below."
    >
      <SpecimenPanel label={`Engine decision — ${tenant.name}`}>
        {resolution === null ? (
          <p className="text-sm text-muted">
            The Signal default theme is the baked-in output of the same token
            pipeline (parity-tested against{" "}
            <code className="font-mono text-xs">toCssVariables(SIGNAL_DEFAULT_TOKENS)</code>
            ). Select a demo tenant to watch the engine work.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              {resolution.source === "tenant" ? (
                <Badge>
                  <CheckIcon aria-hidden /> Theme applied
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <ShieldAlertIcon aria-hidden /> Theme refused — Signal fallback
                </Badge>
              )}
              {resolution.report && resolution.report.adjustments.length > 0 ? (
                <Badge variant="secondary">
                  <WandSparklesIcon aria-hidden />
                  {resolution.report.adjustments.length} auto-correction
                  {resolution.report.adjustments.length === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>

            {resolution.fallbackReason ? (
              <div className="rounded-md border border-negative bg-overlay p-4">
                <p className="text-sm font-medium text-negative">
                  Why this palette was refused
                </p>
                <p className="mt-1 font-mono text-xs leading-5 text-muted">
                  {resolution.fallbackReason}
                </p>
                <p className="mt-2 text-xs text-muted">
                  The dashboard stays on the accessible Signal theme; the tenant is
                  told exactly what to change. A refused theme is never silently
                  approximated.
                </p>
              </div>
            ) : null}

            {resolution.report && resolution.report.adjustments.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-medium text-ink">
                  Corrections applied by the gate
                </p>
                <ul className="flex flex-col gap-2">
                  {resolution.report.adjustments.map((adjustment) => (
                    <li
                      key={adjustment.token}
                      className="rounded-md bg-overlay px-3 py-2 font-mono text-xs leading-5"
                    >
                      <span className="text-ink">
                        {adjustment.token}: <Swatch value={adjustment.from} />{" "}
                        {adjustment.from} → <Swatch value={adjustment.to} /> {adjustment.to}
                      </span>
                      <span className="mt-1 block text-muted">{adjustment.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {resolution.report ? (
              <div>
                <p className="mb-2 text-sm font-medium text-ink">
                  Contrast checks (post-correction)
                </p>
                <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {resolution.report.checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex items-baseline justify-between gap-3 font-mono text-xs"
                    >
                      <span className="flex items-center gap-1.5 text-muted">
                        {check.pass ? (
                          <CheckIcon aria-hidden className="size-3 text-positive" />
                        ) : (
                          <XIcon aria-hidden className="size-3 text-negative" />
                        )}
                        {check.id}
                      </span>
                      <span className={check.pass ? "text-ink" : "text-negative"}>
                        {check.ratio.toFixed(2)}:1 / {check.required}:1
                      </span>
                    </li>
                  ))}
                  <li className="flex items-baseline justify-between gap-3 font-mono text-xs">
                    <span className="flex items-center gap-1.5 text-muted">
                      {resolution.report.distinguishability.pass ? (
                        <CheckIcon aria-hidden className="size-3 text-positive" />
                      ) : (
                        <XIcon aria-hidden className="size-3 text-negative" />
                      )}
                      positive-vs-negative
                    </span>
                    <span className="text-ink">
                      {Math.round(resolution.report.distinguishability.hueSeparationDeg)}° hue
                    </span>
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </SpecimenPanel>
    </Section>
  );
}
