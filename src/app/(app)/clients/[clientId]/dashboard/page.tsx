import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import { ModeToggle } from "@/components/dashboard-preview";
import { TenantThemeScope } from "@/lib/theme/scope";
import { getClaims } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isUuidV4 } from "@/lib/clients/validate";
import { verticalLabel } from "@/lib/clients/format";
import type { TenantTheme } from "@/lib/skills/brand-kit";
import { loadClientDashboard } from "./load";
import {
  AlertsPanel,
  ContentCalendarPanelView,
  LocalRankingsPanel,
  RoiPanelView,
  ShareOfVoicePanel,
  TrendPanel,
  VisibilityHero,
  WorkLogPanel,
} from "./panels";

export const metadata: Metadata = {
  title: "Visibility report — AEO/GEO + Brand Production OS",
  description:
    "Your AI-visibility report — visibility score, share of voice, local presence, the work we did, and results. Rendered in your agency's brand.",
};

/**
 * M19 — the white-label CLIENT dashboard (doc 06 §5, doc 07 §1.10).
 *
 * A read-only, agency-branded report of ONE client's AEO/GEO health. It renders
 * in the resolved TENANT theme (the reseller agency's brand — or, for tenant #1,
 * the operator's), NOT a hardcoded operator brand. It CONSUMES the frozen module
 * read APIs (M3/M4 visibility + share of voice, M14 local, M16 ROI, M17 alerts,
 * plus the tenant's real site_changes / content_items activity) — it reimplements
 * none of them.
 *
 * SCOPING (defense in depth over RLS):
 *  - The (app) layout has already verified the session.
 *  - RLS is the real boundary: every read is tenant + client_scope scoped in the
 *    database, so an out-of-scope id simply returns nothing (→ notFound).
 *  - Additionally, a `client_viewer` may only open THEIR OWN client — we refuse
 *    any other id up front (notFound) rather than lean on RLS alone. We never
 *    widen scope in app code.
 *
 * HONESTY RULE: every panel is `ready` (real stored data), `pending` (source not
 * connected yet — most modules today), or `failed` (retryable). No fabricated
 * numbers, ever; pending/empty states are designed, not placeholders.
 *
 * DEGRADES, NEVER 500s: an env-less build or a failed root read renders a quiet
 * degraded shell (loadClientDashboard returns ok:false); the page never throws.
 */

interface TenantBrand {
  name: string;
  /** null → no stored theme; the page inherits the app-wide (operator/Signal) theme. */
  theme: TenantTheme | null;
  tenantId: string;
}

/**
 * The caller's tenant brand. RLS returns ONLY the caller's own tenant row, so
 * this is the tenant that owns the client — the white-label brand the report
 * wears. A stored `tenants.theme` re-skins the whole report; a null theme means
 * "inherit the app default" (tenant #1's operator brand is applied app-wide by
 * the root layout — the code-driven dual palette).
 */
async function loadTenantBrand(): Promise<TenantBrand | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select("id, name, theme")
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { id: string; name: string; theme: TenantTheme | null };
    return { name: row.name, theme: row.theme ?? null, tenantId: row.id };
  } catch {
    return null;
  }
}

export default async function ClientDashboardPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;

  // A malformed id can never name a real row — refuse before touching the DB.
  if (!isUuidV4(clientId)) notFound();

  const claims = await getClaims();
  // A client_viewer is pinned to one client; refuse any other id up front. RLS
  // would already return nothing, but this makes the boundary explicit and
  // avoids nine reads for an obviously out-of-scope request.
  if (
    claims?.role === "client_viewer" &&
    claims.clientId &&
    claims.clientId !== clientId
  ) {
    notFound();
  }

  const [brand, load] = await Promise.all([
    loadTenantBrand(),
    loadClientDashboard(clientId),
  ]);

  if (!load.ok) return <DegradedShell />;
  if (!load.found) notFound();

  const { data } = load;
  const brandName = brand?.name ?? "Your agency";

  const report = (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-9 px-4 py-8 sm:px-6 sm:py-10">
      <Entrance
        step={0}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted">
            {brandName}
          </span>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {data.client.name}
          </h1>
        </div>
        <ModeToggle />
      </Entrance>

      <Entrance step={1}>
        <VisibilityHero
          clientName={data.client.name}
          vertical={verticalLabel(data.client.vertical)}
          brandName={brandName}
          panel={data.visibility}
        />
      </Entrance>

      <Entrance step={2}>
        <TrendPanel panel={data.visibility} />
      </Entrance>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Entrance step={3}>
          <ShareOfVoicePanel
            clientName={data.client.name}
            panel={data.shareOfVoice}
          />
        </Entrance>
        <Entrance step={4}>
          <LocalRankingsPanel panel={data.local} />
        </Entrance>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Entrance step={5}>
          <WorkLogPanel panel={data.workLog} />
        </Entrance>
        <Entrance step={6}>
          <ContentCalendarPanelView panel={data.content} />
        </Entrance>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Entrance step={7}>
          <RoiPanelView panel={data.roi} />
        </Entrance>
        <Entrance step={8}>
          <AlertsPanel panel={data.alerts} />
        </Entrance>
      </section>

      <footer className="border-t border-border pt-6">
        <p className="max-w-3xl text-xs leading-5 text-muted">
          Live data only. Every figure here is read from your workspace through
          tenant-scoped queries — nothing is sampled or projected. Anything not
          connected yet says so instead of showing a placeholder number.
        </p>
      </footer>
    </div>
  );

  // White-label: a stored tenant theme re-skins the entire report via the frozen
  // theming engine (accessibility-gated; a refused palette falls back to Signal,
  // logged — never silently approximated). A null theme inherits the app-wide
  // theme the root layout already applied (tenant #1's operator brand), so the
  // report is ALWAYS the tenant's brand, never a hardcoded one.
  if (brand?.theme) {
    return (
      <TenantThemeScope
        theme={brand.theme}
        tenantId={brand.tenantId}
        className="flex min-h-full flex-1 flex-col"
      >
        {report}
      </TenantThemeScope>
    );
  }
  return report;
}

/** Env unset or a root read failed — a calm shell, never a 500. */
function DegradedShell() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <Entrance step={0} className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Visibility report
        </h1>
        <p className="text-sm text-muted">
          Your agency-branded AEO/GEO report.
        </p>
      </Entrance>
      <Entrance step={1}>
        <Card className="flex flex-col items-center gap-3 border-dashed py-16 text-center">
          <p className="max-w-md px-6 text-sm text-muted">
            We couldn&apos;t load this report right now. Check your connection
            and refresh — your data is safe.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/clients">Back to clients</Link>
          </Button>
        </Card>
      </Entrance>
    </div>
  );
}
