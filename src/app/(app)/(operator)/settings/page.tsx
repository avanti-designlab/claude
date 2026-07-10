import type { Metadata } from "next";
import {
  BuildingIcon,
  CreditCardIcon,
  PaletteIcon,
  UsersRoundIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import { getClaims } from "@/lib/auth/session";
import type { JwtRole } from "@/lib/types/db";
import {
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { tryCreateClient } from "../../_components/reads";

export const metadata: Metadata = {
  title: "Settings — AEO/GEO + Brand Production OS",
  description: "Your workspace, branding, team, and billing.",
};

/**
 * Settings (global) — the workspace surface. Reads the caller's OWN tenant row
 * (RLS returns only that row) for the workspace name + whether a white-label
 * theme is stored, and the verified claims for the caller's role. Team, billing,
 * and the theme editor are later-wave surfaces, marked honestly rather than
 * shown as dead controls.
 */

const ROLE_LABEL: Record<JwtRole, string> = {
  platform_owner: "Platform owner",
  agency_admin: "Agency admin",
  operator: "Operator",
  client_viewer: "Client viewer",
};

interface Workspace {
  name: string;
  hasTheme: boolean;
  tenantId: string;
}

type Load = { ok: false } | { ok: true; workspace: Workspace };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase
      .from("tenants")
      .select("id, name, theme")
      .maybeSingle();
    if (error || !data) return { ok: false };
    const row = data as { id: string; name: string; theme: unknown };
    return {
      ok: true,
      workspace: {
        name: row.name,
        hasTheme: row.theme != null,
        tenantId: row.id,
      },
    };
  } catch {
    return { ok: false };
  }
}

export default async function SettingsPage() {
  const [result, claims] = await Promise.all([load(), getClaims()]);
  const role = claims?.role ?? null;

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Workspace"
          title="Settings"
          description="Your workspace identity, white-label branding, team, and billing."
        />
      </Entrance>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Entrance step={1}>
          <PanelCard
            title="Workspace"
            description="Who you are on the platform"
            aside={<BuildingIcon className="size-5 text-muted" aria-hidden />}
          >
            {!result.ok ? (
              <FailedState subject="your workspace" />
            ) : (
              <dl className="flex flex-col gap-3 text-sm">
                <Row label="Name" value={result.workspace.name} />
                <Row
                  label="Your role"
                  value={role ? ROLE_LABEL[role] : "—"}
                />
                <Row
                  label="Workspace ID"
                  value={result.workspace.tenantId.slice(0, 8)}
                  mono
                />
              </dl>
            )}
          </PanelCard>
        </Entrance>

        <Entrance step={2}>
          <PanelCard
            title="White-label branding"
            description="The brand your clients' reports wear"
            aside={<PaletteIcon className="size-5 text-muted" aria-hidden />}
          >
            {!result.ok ? (
              <FailedState subject="branding" />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">Custom theme</span>
                  {result.workspace.hasTheme ? (
                    <StatusPill tone="positive">Active</StatusPill>
                  ) : (
                    <StatusPill tone="muted">Using default</StatusPill>
                  )}
                </div>
                <p className="text-xs leading-5 text-muted">
                  {result.workspace.hasTheme
                    ? "Your client reports render in your brand — accent, logo, and type — through the theming engine."
                    : "Client reports use the platform's default brand until a custom theme is set. Editing branding here arrives in a later wave."}
                </p>
              </div>
            )}
          </PanelCard>
        </Entrance>
      </section>

      <Entrance step={3}>
        <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <ComingRow
            icon={UsersRoundIcon}
            title="Team"
            description="Invite and manage staff and client-viewer access, with roles."
          />
          <ComingRow
            icon={CreditCardIcon}
            title="Billing"
            description="Plan, usage, and invoices for your workspace."
          />
        </section>
      </Entrance>
    </PageContainer>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0">
      <dt className="text-muted">{label}</dt>
      <dd className={"text-ink" + (mono ? " font-mono text-xs" : "")}>{value}</dd>
    </div>
  );
}

function ComingRow({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof BuildingIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-border px-4 py-4">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-4 text-muted" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          <StatusPill tone="accent">In build</StatusPill>
        </div>
        <p className="text-xs leading-5 text-muted">{description}</p>
      </div>
    </div>
  );
}
