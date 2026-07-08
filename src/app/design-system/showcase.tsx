"use client";

/**
 * F2 review shell. Header controls prove the three claims that matter:
 *
 * 1. Tenant switcher — the SAME page re-skins per tenant via
 *    resolveTenantTheme() → :root[data-tenant-theme] variables. Zero
 *    component changes; portaled overlays included.
 * 2. Mode control — auto / dark / light through the app's STANDARD mode
 *    mechanism (`data-theme` override on top of the OS preference). Live for
 *    the Signal default AND for the dual-palette operator brand (whose
 *    light+dark emission ships from the root layout); a single-palette
 *    tenant theme locks the control, since it defines one palette.
 * 3. Reduced-motion toggle — forces the shared gate all five moments use,
 *    and mirrors onto `:root[data-motion="reduced"]` so the CSS-driven
 *    entrance choreography obeys the same switch.
 *
 * Chrome is swept to working brand v1 (2026-07-08): floating rounded bubble
 * hero (the page's one glow moment) + entrance choreography on the page
 * chrome; the specimen galleries below stay quiet and appear with their
 * sections.
 */

import * as React from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEMO_TENANTS } from "@/lib/theme/demo-themes";
import {
  resolveTenantTheme,
  tenantThemeCss,
  type TenantThemeResolution,
} from "@/lib/theme/engine";
import { OPERATOR_TENANT_ID, type OperatorMode } from "@/lib/theme/operator-theme";
import { Entrance, ReducedMotionProvider } from "@/components/moments";
import { GlowCard } from "@/components/dashboard-preview";
import { ChartsGallery } from "./sections/charts-gallery";
import { ComponentsGallery } from "./sections/components-gallery";
import { MomentsGallery } from "./sections/moments-gallery";
import { ThemingSection } from "./sections/theming";
import { TokensSection } from "./sections/tokens";

type Mode = "auto" | "dark" | "light";

/** Mode-aware on-hero foregrounds (working brand v1 glow hero). */
const HERO = {
  base: "text-accent-foreground dark:text-ink",
  soft: "text-accent-foreground/85 dark:text-ink/85",
  dim: "text-accent-foreground/70 dark:text-muted",
  link:
    "border-accent-foreground/30 bg-accent-foreground/12 text-accent-foreground hover:bg-accent-foreground/20 focus-visible:ring-accent-foreground/60 " +
    "dark:border-ink/25 dark:bg-ink/8 dark:text-ink dark:hover:bg-ink/15 dark:focus-visible:ring-ring/60",
  linkCircle:
    "bg-accent-foreground text-accent dark:bg-ink dark:text-surface",
};

export function DesignSystemShowcase() {
  const [tenantId, setTenantId] = React.useState("operator");
  const [mode, setMode] = React.useState<Mode>("auto");
  const [forceReduced, setForceReduced] = React.useState(false);

  const tenant = DEMO_TENANTS.find((entry) => entry.id === tenantId) ?? DEMO_TENANTS[0];

  // Single-palette tenants resolve here (and inject scoped CSS below). The
  // dual-palette operator brand needs NO injection — the root layout already
  // emits both palettes under the standard mode mechanism.
  const resolution = React.useMemo<TenantThemeResolution | null>(
    () => (tenant.theme ? resolveTenantTheme(tenant.theme) : null),
    [tenant]
  );
  const modeResolutions = React.useMemo<Record<
    OperatorMode,
    TenantThemeResolution
  > | null>(
    () =>
      tenant.modes
        ? {
            light: resolveTenantTheme(tenant.modes.light),
            dark: resolveTenantTheme(tenant.modes.dark),
          }
        : null,
    [tenant]
  );

  const tenantApplied = resolution?.source === "tenant";
  const modesApplied =
    modeResolutions !== null &&
    modeResolutions.light.source === "tenant" &&
    modeResolutions.dark.source === "tenant";
  const tenantAttribute = tenant.modes
    ? modesApplied
      ? tenant.id
      : "signal-fallback"
    : resolution
      ? tenantApplied
        ? tenant.id
        : "signal-fallback"
      : null;

  // The mode control works whenever the active scope carries both palettes:
  // the Signal default (globals.css) or a dual-palette tenant.
  const modeControlLive = tenant.theme === null;

  // Standard mode override (data-theme on :root).
  React.useEffect(() => {
    const root = document.documentElement;
    if (mode === "auto") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = mode;
    }
    return () => {
      delete root.dataset.theme;
    };
  }, [mode]);

  // Tenant scope at :root so portaled overlays are themed too. Cleanup
  // RESTORES the boot scope (the operator brand) — the app must not fall
  // back to Signal after leaving the review surface.
  React.useEffect(() => {
    const root = document.documentElement;
    if (tenantAttribute) {
      root.dataset.tenantTheme = tenantAttribute;
    } else {
      delete root.dataset.tenantTheme;
    }
    return () => {
      root.dataset.tenantTheme = OPERATOR_TENANT_ID;
    };
  }, [tenantAttribute]);

  // Mirror the force-toggle onto :root for the CSS-driven entrance
  // choreography (same policy as the frozen useReducedMotion gate).
  React.useEffect(() => {
    const root = document.documentElement;
    if (forceReduced) {
      root.dataset.motion = "reduced";
    } else {
      delete root.dataset.motion;
    }
    return () => {
      delete root.dataset.motion;
    };
  }, [forceReduced]);

  return (
    <ReducedMotionProvider force={forceReduced ? true : null}>
      {tenantApplied && resolution ? (
        <style>{tenantThemeCss(resolution, tenant.id)}</style>
      ) : null}

      <div className="min-h-full">
        <header className="sticky top-0 z-40 border-b bg-surface/85 backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
            <div className="mr-auto">
              <p className="font-display text-lg leading-6 text-ink">Signal</p>
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">
                F2 design system · review
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="ds-tenant" className="text-xs text-muted">
                Tenant
              </Label>
              <Select value={tenantId} onValueChange={setTenantId}>
                <SelectTrigger id="ds-tenant" size="sm" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEMO_TENANTS.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted" id="ds-mode-label">
                Mode
              </span>
              <Tabs
                value={modeControlLive ? mode : "tenant"}
                onValueChange={(value) => setMode(value as Mode)}
              >
                <TabsList aria-labelledby="ds-mode-label">
                  {modeControlLive ? (
                    <>
                      <TabsTrigger value="auto">Auto</TabsTrigger>
                      <TabsTrigger value="dark">Dark</TabsTrigger>
                      <TabsTrigger value="light">Light</TabsTrigger>
                    </>
                  ) : (
                    <TabsTrigger value="tenant" disabled>
                      Tenant palette
                    </TabsTrigger>
                  )}
                </TabsList>
              </Tabs>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted">
              <Switch
                checked={forceReduced}
                onCheckedChange={setForceReduced}
                aria-label="Force reduced motion"
              />
              Reduced motion
            </label>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-4 py-10 sm:px-6 sm:py-12">
          {/* HERO — the floating rounded bubble (the page's one glow moment) */}
          <Entrance step={0}>
            <GlowCard surface="hero" scale="hero" bloom>
              <section className={"flex flex-col gap-3 p-7 sm:p-10 lg:p-12 " + HERO.base}>
                <p className={"font-mono text-xs tracking-[0.2em] uppercase " + HERO.dim}>
                  Precision instrument meets studio
                </p>
                <h1 className="max-w-3xl font-display text-display leading-[1.05] font-bold tracking-[-0.02em]">
                  Signal — the F2 design system
                </h1>
                <p className={"max-w-2xl text-base " + HERO.soft}>
                  Neutral-premium chrome; the tenant accent does the talking. This
                  page is the review surface: switch tenants, flip modes, force
                  reduced motion — everything below must hold.
                </p>
                <div className="pt-1">
                  <a
                    href="/dashboard-preview"
                    className={
                      "group inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] " +
                      HERO.link
                    }
                  >
                    See the sample dashboard preview
                    <span
                      className={
                        "flex size-6 items-center justify-center rounded-full transition-transform group-hover:-translate-y-0.5 " +
                        HERO.linkCircle
                      }
                    >
                      <ArrowUpRightIcon className="size-3.5" strokeWidth={2.25} />
                    </span>
                  </a>
                </div>
              </section>
            </GlowCard>
          </Entrance>

          <Entrance step={1}>
            <TokensSection refreshKey={`${tenantId}:${mode}`} />
          </Entrance>
          <Entrance step={2}>
            <ThemingSection
              tenant={tenant}
              resolution={resolution}
              modeResolutions={modeResolutions}
            />
          </Entrance>
          <Entrance step={3}>
            <ComponentsGallery />
          </Entrance>
          <Entrance step={4}>
            <ChartsGallery />
          </Entrance>
          <Entrance step={5}>
            <MomentsGallery />
          </Entrance>

          <footer className="border-t pt-6 pb-12">
            <p className="max-w-2xl text-xs leading-5 text-muted">
              F2 is frozen; the operator brand riding it is working v1 (values
              may still change — structure is locked). Post-freeze changes
              require Orchestrator + Code Review approval. Feature UI builds
              only on what is shown here.
            </p>
          </footer>
        </main>
      </div>

      <Toaster position="bottom-right" />
    </ReducedMotionProvider>
  );
}
