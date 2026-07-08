"use client";

/**
 * Step 3 — connect properties (doc 06 §5, doc 04 §4). UI only: no real
 * connections are made here. For each property we show what WOULD happen once
 * connected — the change-management method the platform resolves to (direct
 * API auto-fix, Cloudflare edge worker, or a pull request).
 */

import { LinkIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PropertyPlatform } from "@/lib/types/db";
import { PLATFORM_GUIDANCE, PLATFORM_ORDER } from "./onboarding-copy";

export interface PropertyDraft {
  id: string;
  url: string;
  /** Empty string until the operator picks / confirms the detected platform. */
  platform: PropertyPlatform | "";
}

export interface StepPropertiesProps {
  properties: PropertyDraft[];
  onUpdateUrl: (id: string, url: string) => void;
  onUpdatePlatform: (id: string, platform: PropertyPlatform) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

function PropertyRow({
  property,
  index,
  canRemove,
  onUpdateUrl,
  onUpdatePlatform,
  onRemove,
}: {
  property: PropertyDraft;
  index: number;
  canRemove: boolean;
  onUpdateUrl: (id: string, url: string) => void;
  onUpdatePlatform: (id: string, platform: PropertyPlatform) => void;
  onRemove: (id: string) => void;
}) {
  const guidance = property.platform
    ? PLATFORM_GUIDANCE[property.platform]
    : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted">
          Property {String(index + 1).padStart(2, "0")}
        </span>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(property.id)}
            aria-label={`Remove property ${index + 1}`}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`property-url-${property.id}`} className="text-muted">
            Website
          </Label>
          <Input
            id={`property-url-${property.id}`}
            type="url"
            inputMode="url"
            value={property.url}
            placeholder="https://yoursite.com"
            onChange={(event) => onUpdateUrl(property.id, event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`property-platform-${property.id}`} className="text-muted">
            Platform
          </Label>
          <Select
            value={property.platform || undefined}
            onValueChange={(value) =>
              onUpdatePlatform(property.id, value as PropertyPlatform)
            }
          >
            <SelectTrigger id={`property-platform-${property.id}`} className="w-full">
              <SelectValue placeholder="Detect platform" />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_ORDER.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  {PLATFORM_GUIDANCE[platform].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {guidance ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed bg-surface-raised px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{guidance.methodLabel}</Badge>
            <Badge variant="outline" className="text-muted">
              {guidance.capability}
            </Badge>
            {guidance.phaseNote ? (
              <span className="font-mono text-[10px] tracking-wide text-muted uppercase">
                {guidance.phaseNote}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted">{guidance.guidance}</p>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted">
          <LinkIcon aria-hidden className="size-4" />
          Pick your platform and we&apos;ll show exactly how we&apos;ll connect.
        </p>
      )}
    </div>
  );
}

export function StepProperties({
  properties,
  onUpdateUrl,
  onUpdatePlatform,
  onAdd,
  onRemove,
}: StepPropertiesProps) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-2xl text-ink">
          Connect your properties
        </h2>
        <p className="text-sm text-muted">
          Add each site you want us to work on. We&apos;ll show how we connect —
          nothing is connected yet, and every change is previewed before it goes
          live.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {properties.map((property, index) => (
          <PropertyRow
            key={property.id}
            property={property}
            index={index}
            canRemove={properties.length > 1}
            onUpdateUrl={onUpdateUrl}
            onUpdatePlatform={onUpdatePlatform}
            onRemove={onRemove}
          />
        ))}
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <PlusIcon aria-hidden /> Add another property
        </Button>
      </div>
    </div>
  );
}
