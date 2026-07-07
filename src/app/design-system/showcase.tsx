"use client";

/**
 * F2 review shell. Header controls prove the three claims that matter:
 *
 * 1. Tenant switcher — the SAME page re-skins per tenant via
 *    resolveTenantTheme() → :root[data-tenant-theme] variables. Zero
 *    component changes; portaled overlays included.
 * 2. Mode control — dark (default) / light for the Signal theme. A tenant
 *    theme defines its own single palette, so the control locks while a
 *    tenant is active.
 * 3. Reduced-motion toggle — forces the shared gate all five moments use.
 */

import * as React from "react";
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
import { ReducedMotionProvider } from "@/components/moments";
import { ChartsGallery } from "./sections/charts-gallery";
import { ComponentsGallery } from "./sections/components-gallery";
import { MomentsGallery } from "./sections/moments-gallery";
import { ThemingSection } from "./sections/theming";
import { TokensSection } from "./sections/tokens";

type Mode = "auto" | "dark" | "light";

export function DesignSystemShowcase() {
  const [tenantId, setTenantId] = React.useState("signal");
  const [mode, setMode] = React.useState<Mode>("auto");
  const [forceReduced, setForceReduced] = React.useState(false);

  const tenant = DEMO_TENANTS.find((entry) => entry.id === tenantId) ?? DEMO_TENANTS[0];

  const resolution = React.useMemo<TenantThemeResolution | null>(
    () => (tenant.theme ? resolveTenantTheme(tenant.theme) : null),
    [tenant]
  );
  const tenantApplied = resolution?.source === "tenant";
  const tenantAttribute = resolution
    ? tenantApplied
      ? tenant.id
      : "signal-fallback"
    : null;

  // Signal mode override (dark is the no-preference default in globals.css).
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

  // Tenant scope at :root so portaled overlays are themed too.
  React.useEffect(() => {
    const root = document.documentElement;
    if (tenantAttribute) {
      root.dataset.tenantTheme = tenantAttribute;
    } else {
      delete root.dataset.tenantTheme;
    }
    return () => {
      delete root.dataset.tenantTheme;
    };
  }, [tenantAttribute]);

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
                value={tenant.theme ? "tenant" : mode}
                onValueChange={(value) => setMode(value as Mode)}
              >
                <TabsList aria-labelledby="ds-mode-label">
                  {tenant.theme ? (
                    <TabsTrigger value="tenant" disabled>
                      Tenant palette
                    </TabsTrigger>
                  ) : (
                    <>
                      <TabsTrigger value="auto">Auto</TabsTrigger>
                      <TabsTrigger value="dark">Dark</TabsTrigger>
                      <TabsTrigger value="light">Light</TabsTrigger>
                    </>
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

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 py-12">
          <section className="flex flex-col gap-3">
            <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
              Precision instrument meets studio
            </p>
            <h1 className="max-w-3xl font-display text-display text-ink">
              Signal — the F2 design system
            </h1>
            <p className="max-w-2xl text-base text-muted">
              Neutral-premium chrome; the tenant accent does the talking. This
              page is the review surface for the F2 freeze: switch tenants,
              flip modes, force reduced motion — everything below must hold.
            </p>
          </section>

          <TokensSection refreshKey={`${tenantId}:${mode}`} />
          <ThemingSection tenant={tenant} resolution={resolution} />
          <ComponentsGallery />
          <ChartsGallery />
          <MomentsGallery />

          <footer className="border-t pt-6 pb-12">
            <p className="max-w-2xl text-xs leading-5 text-muted">
              F2 freeze gate (doc 07 §0.4): after Design Review and operator
              sign-off this system freezes — changes then require Orchestrator
              + Code Review approval. Feature UI builds only on what is shown
              here.
            </p>
          </footer>
        </main>
      </div>

      <Toaster position="bottom-right" />
    </ReducedMotionProvider>
  );
}
