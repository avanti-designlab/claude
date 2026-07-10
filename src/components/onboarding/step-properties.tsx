"use client";

/**
 * Step 3 — the client's website (doc 06 §5, doc 04 §4). The PRIMARY (first)
 * site on this step SAVES with the client when the flow leaves it — url +
 * platform, stored not-connected via the landed properties write-path;
 * additional rows are workspace adds later and do NOT persist here. No
 * connections are made anywhere yet: for each site we show what WOULD happen
 * once connected — the change-management method the platform resolves to
 * (direct API auto-fix, Cloudflare edge worker, or a pull request).
 *
 * The URL input normalizes on blur with the SAME idempotent helper the flow
 * uses to build the payload (normalizeWebsiteUrl), so the address the operator
 * sees is byte-identical to the one that saves; when the normalized address
 * still can't persist, the row explains why inline (websiteUrlProblem — the
 * exact sanitizePropertyUrl mirror the server runs). Remediation A1–A4.
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
import {
  normalizeWebsiteUrl,
  websiteUrlProblem,
} from "@/components/properties/website-url";
import { PLATFORM_GUIDANCE, PLATFORM_ORDER } from "./onboarding-copy";
import { NEGATIVE_TEXT_CLASS } from "@/components/tone";

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
  isPrimary,
  canRemove,
  onUpdateUrl,
  onUpdatePlatform,
  onRemove,
}: {
  property: PropertyDraft;
  index: number;
  /** The first row is the primary website — the one the client save persists. */
  isPrimary: boolean;
  canRemove: boolean;
  onUpdateUrl: (id: string, url: string) => void;
  onUpdatePlatform: (id: string, platform: PropertyPlatform) => void;
  onRemove: (id: string) => void;
}) {
  const guidance = property.platform
    ? PLATFORM_GUIDANCE[property.platform]
    : null;

  // The persistability mirror (remediation A1): compute against the SAME
  // normalized value the payload sends. Shown only for a non-empty address —
  // normalization auto-prefixes https://, so this fires only when the address
  // itself can't be a web address.
  const normalized = normalizeWebsiteUrl(property.url);
  const urlProblem = normalized === "" ? null : websiteUrlProblem(normalized);
  const problemId = `property-url-problem-${property.id}`;

  // Visible row label — the remove button's aria-label matches it exactly
  // (Design M5).
  const rowLabel = isPrimary
    ? "Primary website"
    : `Additional site ${String(index).padStart(2, "0")}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted">{rowLabel}</span>
          {isPrimary ? (
            <Badge variant="secondary">Saves with this client</Badge>
          ) : null}
        </div>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(property.id)}
            aria-label={`Remove ${rowLabel.toLowerCase()}`}
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
            aria-invalid={urlProblem ? true : undefined}
            aria-describedby={urlProblem ? problemId : undefined}
            onChange={(event) => onUpdateUrl(property.id, event.target.value)}
            // Normalize IN PLACE on blur ("mysite.com" → "https://mysite.com"):
            // the operator sees exactly the address that saves. Idempotent, so
            // the payload's own normalization can never diverge from this.
            onBlur={() =>
              onUpdateUrl(property.id, normalizeWebsiteUrl(property.url))
            }
          />
          {urlProblem ? (
            <p
              id={problemId}
              role="alert"
              className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}
            >
              {urlProblem}
            </p>
          ) : null}
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
              <SelectValue placeholder="Select platform" />
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
          {isPrimary
            ? "Select this site’s platform — your primary website needs both an address and a platform to save."
            : "Pick your platform and we’ll show exactly how we’ll connect."}
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
          Add your website
        </h2>
        <p className="text-sm text-muted">
          Your primary website saves with this client. We don&apos;t connect to
          it yet — nothing is connected, and every future change is previewed
          before it goes live.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {properties.map((property, index) => (
          <PropertyRow
            key={property.id}
            property={property}
            index={index}
            isPrimary={index === 0}
            canRemove={properties.length > 1}
            onUpdateUrl={onUpdateUrl}
            onUpdatePlatform={onUpdatePlatform}
            onRemove={onRemove}
          />
        ))}
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <PlusIcon aria-hidden /> Add another site
        </Button>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted">
        <p>
          Only your primary website is saved during setup, and it&apos;s saved
          as not-connected — we don&apos;t connect to any site yet, so crawling
          and auto-fixes turn on later when the Connections step ships.
        </p>
        {properties.length > 1 ? (
          <p>
            Additional sites aren&apos;t saved here — add them from the
            client&apos;s workspace once you&apos;re in.
          </p>
        ) : null}
      </div>
    </div>
  );
}
