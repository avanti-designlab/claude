"use client";

/**
 * Step 2 — add location(s) (doc 06 §5). Drives the local module's intensity.
 * The hint reflects the loaded playbook's `local_intensity` — real value when
 * the playbook is loaded, honest fallback while the engine lands in parallel.
 */

import { MapPinIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { LocalIntensity } from "@/lib/types/playbook";
import { localIntensityHint, localIntensityLabel } from "./onboarding-copy";

export interface LocationDraft {
  id: string;
  value: string;
}

export interface StepLocationsProps {
  locations: LocationDraft[];
  localIntensity: LocalIntensity | null;
  onUpdate: (id: string, value: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export function StepLocations({
  locations,
  localIntensity,
  onUpdate,
  onAdd,
  onRemove,
}: StepLocationsProps) {
  const canRemove = locations.length > 1;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-2xl text-ink">
          Where do you serve customers?
        </h2>
        <p className="text-sm text-muted">
          Add the places you want to win. This sets how hard the local module
          runs for you.
        </p>
      </header>

      <div className="flex items-start gap-3 rounded-lg border bg-surface-raised px-4 py-3">
        <MapPinIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">Local intensity</span>
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {localIntensityLabel(localIntensity)}
            </Badge>
          </div>
          <p className="text-sm text-muted">
            {localIntensityHint(localIntensity)}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {locations.map((location, index) => (
          <div key={location.id} className="flex flex-col gap-1.5">
            <Label htmlFor={`location-${location.id}`} className="text-muted">
              Location {index + 1}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`location-${location.id}`}
                value={location.value}
                placeholder="City, neighborhood, or service area"
                onChange={(event) => onUpdate(location.id, event.target.value)}
              />
              {canRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(location.id)}
                  aria-label={`Remove location ${index + 1}`}
                >
                  <XIcon aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <PlusIcon aria-hidden /> Add another location
        </Button>
      </div>
    </div>
  );
}
