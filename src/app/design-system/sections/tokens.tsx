"use client";

/**
 * Token specimens: the doc 06 §2 named colors, the type scale (including the
 * score/display treatment), and the spacing scale. Every swatch reads its
 * value from the live CSS custom property — switching theme or tenant
 * re-paints this section like everything else.
 */

import * as React from "react";
import { Section, SpecimenPanel } from "./section";

const COLOR_TOKENS = [
  { name: "--surface", role: "Deep neutral base" },
  { name: "--surface-raised", role: "Raised panels, cards" },
  { name: "--ink", role: "High-contrast foreground" },
  { name: "--muted", role: "Secondary text" },
  { name: "--accent", role: "Tenant brand — does the talking" },
  { name: "--positive", role: "Citation up, rank up" },
  { name: "--negative", role: "Citation down, rank down" },
] as const;

const TYPE_STEPS = [
  { step: "score", sample: "68", note: "The Visibility Score — display face, one line, reserved box" },
  { step: "display", sample: "Signal over noise", note: "Section heroes" },
  { step: "3xl", sample: "Share of voice", note: "Page titles" },
  { step: "2xl", sample: "Tracker results", note: "Card titles" },
  { step: "xl", sample: "Open tasks by module", note: "Subheads" },
  { step: "lg", sample: "Content pipeline status", note: "Emphasis body" },
  { step: "base", sample: "Dense dashboard reading stays comfortable at this size.", note: "Body" },
  { step: "sm", sample: "Row metadata and quiet labels sit one step down.", note: "Secondary" },
  { step: "xs", sample: "TIMESTAMPS · UNITS · OVERLINES", note: "Captions" },
] as const;

const SPACE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16] as const;

/** Static class map — Tailwind's scanner needs literal class names. */
const STEP_CLASS: Record<(typeof TYPE_STEPS)[number]["step"], string> = {
  score: "text-score font-display text-ink",
  display: "text-display font-display text-ink",
  "3xl": "text-3xl text-ink",
  "2xl": "text-2xl text-ink",
  xl: "text-xl text-ink",
  lg: "text-lg text-ink",
  base: "text-base text-ink",
  sm: "text-sm text-ink",
  xs: "text-xs text-ink",
};

/** Read custom properties' current values off <html> (client only). */
function useTokenValues(names: readonly string[], refreshKey: string): Record<string, string> {
  const [values, setValues] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    // Deferred a frame so injected tenant <style> rules are applied first.
    const frame = requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement);
      setValues(
        Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]))
      );
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- names is a module constant; refreshKey signals theme changes
  }, [refreshKey]);
  return values;
}

export function TokensSection({ refreshKey }: { refreshKey: string }) {
  const values = useTokenValues(
    COLOR_TOKENS.map((token) => token.name),
    refreshKey
  );

  return (
    <Section
      id="tokens"
      overline="01 · Tokens"
      title="The token system"
      description="Seven named colors, three faces, one scale. Nothing below is a literal value — every swatch, size, and face reads a CSS custom property that the theming engine can override per tenant."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <SpecimenPanel label="Color tokens (live values)">
          <ul className="flex flex-col gap-2">
            {COLOR_TOKENS.map(({ name, role }) => (
              <li key={name} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="size-8 shrink-0 rounded-md border"
                  style={{ backgroundColor: `var(${name})` }}
                />
                <code className="w-40 shrink-0 font-mono text-xs text-ink">{name}</code>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">
                  {role}
                </span>
                <code className="font-mono text-xs text-muted">{values[name] ?? ""}</code>
              </li>
            ))}
          </ul>
        </SpecimenPanel>

        <SpecimenPanel label="Faces">
          <div className="flex flex-col gap-4">
            <div>
              <p className="font-display text-2xl text-ink">Display — big data moments</p>
              <p className="mt-1 font-mono text-xs text-muted">var(--font-display)</p>
            </div>
            <div>
              <p className="text-base text-ink">
                Body — dense dashboard reading, forms, and flows.
              </p>
              <p className="mt-1 font-mono text-xs text-muted">var(--font-body)</p>
            </div>
            <div>
              <p className="font-mono text-base text-ink">Mono — 68 / 100 · 3,412 citations</p>
              <p className="mt-1 font-mono text-xs text-muted">var(--font-mono)</p>
            </div>
          </div>
        </SpecimenPanel>
      </div>

      <SpecimenPanel label="Type scale (--text-*)">
        <ul className="flex flex-col gap-4">
          {TYPE_STEPS.map(({ step, sample, note }) => (
            <li key={step} className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-6">
              <code className="w-24 shrink-0 font-mono text-xs text-muted">
                text-{step}
              </code>
              <span className={`min-w-0 flex-1 truncate ${STEP_CLASS[step]}`}>{sample}</span>
              <span className="hidden w-64 shrink-0 text-right text-xs text-muted lg:block">
                {note}
              </span>
            </li>
          ))}
        </ul>
      </SpecimenPanel>

      <SpecimenPanel label="Spacing (--space-*, 4px base unit)">
        <ul className="flex flex-col gap-2">
          {SPACE_STEPS.map((step) => (
            <li key={step} className="flex items-center gap-3">
              <code className="w-24 shrink-0 font-mono text-xs text-muted">--space-{step}</code>
              <span
                aria-hidden
                className="h-3 rounded-xs bg-accent"
                style={{ width: `var(--space-${step})` }}
              />
              <span className="font-mono text-xs text-muted">{step * 4}px</span>
            </li>
          ))}
        </ul>
      </SpecimenPanel>
    </Section>
  );
}
