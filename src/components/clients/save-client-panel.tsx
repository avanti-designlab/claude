"use client";

/**
 * The real "make it real" moment: persist the onboarded client to Supabase.
 *
 * Rendered only for the ACTIVE vertical at the end of onboarding (the flow
 * gates dormant verticals out). It collects a client name (pre-filled with a
 * sensible suggestion), maps the onboarding locations into the `clients`
 * shape, and calls the `createClientFromOnboarding` server action.
 *
 * IMPORTANT: this component sends only name / vertical / locations. It has NO
 * tenant_id to send — the server action sources tenant scope from the caller's
 * verified claim and RLS pins it. A browser can neither choose nor spoof the
 * tenant a client lands in.
 *
 * Only the CLIENT record persists in this slice; the generated plan is shown
 * above but its persistence is the next slice.
 */

import * as React from "react";
import Link from "next/link";
import { CheckCircle2Icon, Loader2Icon, SaveIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createClientFromOnboarding,
  type CreatedClient,
} from "@/lib/clients/actions";
import { suggestClientName, toClientLocations } from "@/lib/clients/format";
import type { SeedVertical } from "@/lib/types/playbook";
import type { LocationDraft } from "@/components/onboarding/step-locations";
import type { PropertyDraft } from "@/components/onboarding/step-properties";
import { APP_HOME } from "@/components/app-shell/nav";

export interface SaveClientPanelProps {
  vertical: SeedVertical;
  verticalLabel: string;
  locations: LocationDraft[];
  properties: PropertyDraft[];
}

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; client: CreatedClient }
  | { phase: "error"; message: string };

export function SaveClientPanel({
  vertical,
  verticalLabel,
  locations,
  properties,
}: SaveClientPanelProps) {
  const [name, setName] = React.useState(() =>
    suggestClientName(
      locations.map((l) => l.value),
      properties.map((p) => p.url)
    )
  );
  const [state, setState] = React.useState<SaveState>({ phase: "idle" });

  const clientLocations = React.useMemo(
    () => toClientLocations(locations.map((l) => l.value)),
    [locations]
  );

  const saving = state.phase === "saving";

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setState({
        phase: "error",
        message: "Add a name for this client before saving.",
      });
      return;
    }
    setState({ phase: "saving" });
    const result = await createClientFromOnboarding({
      name: trimmed,
      vertical,
      locations: clientLocations,
    });
    if (result.ok) {
      setState({ phase: "saved", client: result.client });
    } else {
      setState({ phase: "error", message: result.error });
    }
  }

  if (state.phase === "saved") {
    const { client } = state;
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-positive/40 bg-positive/5 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-positive"
          />
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-ink">Client saved</h3>
            <p className="text-sm text-muted">
              <span className="font-medium text-ink">{client.name}</span> is now
              in your workspace, in {verticalLabel.toLowerCase()}.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{verticalLabel}</Badge>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            {client.status}
          </Badge>
          <span
            className="font-mono text-[10px] text-muted"
            title={`Client ${client.id}`}
          >
            id {client.id.slice(0, 8)}
          </span>
        </div>
        <div>
          <Button asChild size="sm">
            <Link href={APP_HOME}>View clients</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-ink">Save this client</h3>
        <p className="text-sm text-muted">
          Add {verticalLabel.toLowerCase()} to your workspace. You can refine
          everything later — this just gets them on the board.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="client-name" className="text-muted">
          Client name
        </Label>
        <Input
          id="client-name"
          value={name}
          placeholder="e.g. Gable & Grove Realty"
          disabled={saving}
          onChange={(event) => {
            setName(event.target.value);
            if (state.phase === "error") setState({ phase: "idle" });
          }}
        />
      </div>

      {clientLocations.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] tracking-wide text-muted uppercase">
            Locations
          </span>
          {clientLocations.map((loc, index) => (
            <Badge key={index} variant="outline" className="text-muted">
              {loc.name}
            </Badge>
          ))}
        </div>
      ) : null}

      {state.phase === "error" ? (
        <p role="alert" className="text-sm text-negative">
          {state.message}
        </p>
      ) : null}

      <div>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2Icon aria-hidden className="animate-spin" /> Saving…
            </>
          ) : (
            <>
              <SaveIcon aria-hidden /> Save client
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
