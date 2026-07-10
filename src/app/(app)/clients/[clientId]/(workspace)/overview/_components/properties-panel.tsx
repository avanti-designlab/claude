"use client";

/**
 * The minimal workspace Properties surface (combined-remediation Part B) — the
 * page the onboarding soft-fail warning points at ("add it from the client's
 * Properties once you're in"), now real. Deliberately small and quiet
 * (utilitarian operator surface, doc 06 §4):
 *
 *  - lists this client's saved properties (the page's RLS-scoped read seeds
 *    `initial`; after a write, rows update from the ACTION'S returned values —
 *    server truth, never an optimistic fabrication; an UNCONFIRMED round-trip
 *    triggers router.refresh() and the fresh read re-seeds the list);
 *  - add + edit through the LANDED seam only (`createProperty` /
 *    `editProperty`, src/lib/properties/actions.ts) — the seam pins
 *    connection_method 'none' and never touches auth_ref;
 *  - NO delete (v1 ruling: properties are on-delete-restrict FK parents) and
 *    NO connect affordance — connections aren't available yet and the panel
 *    says so plainly;
 *  - URL handling is the SAME shared normalize + persistability mirror as
 *    onboarding step 3 (website-url.ts) — one validation approach, no fork;
 *  - seam errors are interface-voice already — rendered VERBATIM.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { GlobeIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isPropertyPlatform, type PropertyPlatform } from "@/lib/types/db";
import { createProperty, editProperty } from "@/lib/properties/actions";
import {
  normalizeWebsiteUrl,
  websiteUrlProblem,
} from "@/components/properties/website-url";
import {
  PLATFORM_GUIDANCE,
  PLATFORM_ORDER,
} from "@/components/onboarding/onboarding-copy";
import { EmptyState, StatusPill } from "../../../../../_components/surface";
import {
  NEGATIVE_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
} from "../../../../../_components/tone";

/** One saved property, as the page's read returned it. */
export interface WorkspaceProperty {
  id: string;
  url: string;
  platform: string | null;
  connectionMethod: string;
}

/**
 * Honest fallback when the action call itself fails to round-trip. This seam
 * has NO idempotency key (unlike onboarding), so a lost response may or may
 * not have landed. The recovery instruction is REAL (Design B2 / Code minor 1):
 * the catch path calls router.refresh(), the page's server read re-runs, and
 * the compare-before-set sync below re-seeds the list from that fresh read —
 * so "check whether it saved" is actually followable before retrying.
 */
const SEAM_UNREACHABLE =
  "We couldn’t confirm the save. We’ve refreshed the list below — check whether it saved before trying again.";

/** connection_method → rendered state. Only 'none' is writable today; the
 * connected values are doc-04 vocabulary, mapped so no internal code renders. */
function connectionState(method: string): {
  label: string;
  tone: "muted" | "accent";
} {
  switch (method) {
    case "none":
      return { label: "Not connected", tone: "muted" };
    case "api":
      return { label: "Connected — direct API", tone: "accent" };
    case "edge_worker":
      return { label: "Connected — edge worker", tone: "accent" };
    case "pr":
      return { label: "Connected — pull request", tone: "accent" };
    default:
      return { label: "Unrecognized connection", tone: "muted" };
  }
}

function platformLabel(platform: string | null): string {
  // Null AND enum drift both land on the honest fallback (Code minor 3): a
  // raw DB token is an internal code and never renders.
  return isPropertyPlatform(platform)
    ? PLATFORM_GUIDANCE[platform].label
    : "Platform not recorded";
}

/* ------------------------------------------------------------------ */
/* The shared add/edit fields (same normalization as onboarding)       */
/* ------------------------------------------------------------------ */

function PropertyForm({
  idPrefix,
  initialUrl,
  initialPlatform,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initialUrl: string;
  initialPlatform: PropertyPlatform | "";
  busy: boolean;
  /** The seam's interface-voice error (or the unreachable fallback), verbatim. */
  error: string | null;
  submitLabel: string;
  onSubmit: (url: string, platform: PropertyPlatform) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = React.useState(initialUrl);
  const [platform, setPlatform] = React.useState<PropertyPlatform | "">(
    initialPlatform
  );

  // Identical to onboarding step 3: gate on the normalized value; the input
  // normalizes on blur so what's shown is byte-identical to what's sent.
  const normalized = normalizeWebsiteUrl(url);
  const urlProblem = normalized === "" ? null : websiteUrlProblem(normalized);
  const problemId = `${idPrefix}-url-problem`;
  const canSubmit =
    normalized !== "" && urlProblem === null && platform !== "" && !busy;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-url`} className="text-muted">
            Website
          </Label>
          <Input
            id={`${idPrefix}-url`}
            type="url"
            inputMode="url"
            autoFocus
            value={url}
            placeholder="https://yoursite.com"
            disabled={busy}
            aria-invalid={urlProblem ? true : undefined}
            aria-describedby={urlProblem ? problemId : undefined}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => setUrl(normalizeWebsiteUrl(url))}
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
          <Label htmlFor={`${idPrefix}-platform`} className="text-muted">
            Platform
          </Label>
          <Select
            value={platform || undefined}
            disabled={busy}
            onValueChange={(value) => setPlatform(value as PropertyPlatform)}
          >
            <SelectTrigger id={`${idPrefix}-platform`} className="w-full">
              <SelectValue placeholder="Select platform" />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_ORDER.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {PLATFORM_GUIDANCE[entry].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <p role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          onClick={() => {
            if (platform === "") return;
            onSubmit(normalized, platform);
          }}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

type Mode = { kind: "idle" } | { kind: "add" } | { kind: "edit"; id: string };

/** Where focus returns when a form unmounts (Design B3 — managed focus). */
type FocusWant = { target: "add" } | { target: "row"; id: string };

export function PropertiesPanel({
  clientId,
  initial,
}: {
  clientId: string;
  initial: WorkspaceProperty[];
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<WorkspaceProperty[]>(initial);
  const [mode, setMode] = React.useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // Success echo (house outcome discipline): set from a confirmed action
  // result only; cleared when the next operation starts.
  const [notice, setNotice] = React.useState<string | null>(null);

  // COMPARE-BEFORE-SET prop sync (the house pattern): when the server
  // component re-renders — router.refresh() after an unconfirmed save is the
  // one trigger today — the fresh RLS-scoped read supersedes local state, so
  // the "check the list below" instruction inspects server truth.
  const [seededFrom, setSeededFrom] = React.useState(initial);
  if (seededFrom !== initial) {
    setSeededFrom(initial);
    setRows(initial);
  }

  // MANAGED FOCUS (Design B3): Cancel and successful save unmount the form —
  // focus returns to the Add button (add flow) or the affected row's Edit
  // button (edit flow) instead of dropping to <body>. The exact
  // want-flag/target-ref mechanism the review-queue decision panel ships: the
  // handler arms the ref, the effect keyed on the mode change reads-and-clears
  // it after the target has re-rendered. Unarmed mode changes (opening a form)
  // do nothing.
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const editButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const wantFocusRef = React.useRef<FocusWant | null>(null);
  React.useEffect(() => {
    const want = wantFocusRef.current;
    if (!want) return;
    wantFocusRef.current = null;
    if (want.target === "add") {
      addButtonRef.current?.focus();
    } else {
      editButtonRefs.current.get(want.id)?.focus();
    }
  }, [mode]);

  const openAdd = () => {
    setMode({ kind: "add" });
    setFormError(null);
    setNotice(null);
  };
  const openEdit = (id: string) => {
    setMode({ kind: "edit", id });
    setFormError(null);
    setNotice(null);
  };
  const close = () => {
    // Cancel: hand focus back to whatever opened the form.
    if (mode.kind === "edit") {
      wantFocusRef.current = { target: "row", id: mode.id };
    } else if (mode.kind === "add") {
      wantFocusRef.current = { target: "add" };
    }
    setMode({ kind: "idle" });
    setFormError(null);
  };

  const submitAdd = async (url: string, platform: PropertyPlatform) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await createProperty({ clientId, url, platform });
      if (result.ok) {
        // Server truth: the action's returned row. The seam pins
        // connection_method 'none' on insert, so stating it is not a guess.
        setRows((prev) => [
          ...prev,
          {
            id: result.property.id,
            url: result.property.url,
            platform: result.property.platform,
            connectionMethod: "none",
          },
        ]);
        wantFocusRef.current = { target: "add" };
        setMode({ kind: "idle" });
        setNotice("Website saved — not connected yet.");
      } else {
        setFormError(result.error);
      }
    } catch {
      // Unconfirmed round-trip: re-run the page's server read so the list
      // below reflects whether the write landed (the copy promises this).
      router.refresh();
      setFormError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (
    propertyId: string,
    url: string,
    platform: PropertyPlatform
  ) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await editProperty({ propertyId, url, platform });
      if (result.ok) {
        setRows((prev) =>
          prev.map((row) =>
            row.id === propertyId
              ? {
                  ...row,
                  url: result.property.url,
                  platform: result.property.platform,
                }
              : row
          )
        );
        wantFocusRef.current = { target: "row", id: propertyId };
        setMode({ kind: "idle" });
        setNotice("Changes saved.");
      } else {
        setFormError(result.error);
      }
    } catch {
      // Same real recovery as add: refresh the server read behind the copy.
      router.refresh();
      setFormError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 && mode.kind !== "add" ? (
        <EmptyState
          icon={GlobeIcon}
          title="No websites saved yet"
          description="Add this client's site so audits and intelligence runs have a target. It saves as not connected — connections come later."
          action={
            <Button
              ref={addButtonRef}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={openAdd}
            >
              <PlusIcon aria-hidden /> Add a website
            </Button>
          }
        />
      ) : null}

      {/* The list renders only when there are rows (Design B4) — add mode on
          an empty client shows just the form, never an empty <ul>. */}
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const connection = connectionState(row.connectionMethod);
            return (
              <li key={row.id}>
                {mode.kind === "edit" && mode.id === row.id ? (
                  <PropertyForm
                    idPrefix={`edit-${row.id}`}
                    initialUrl={row.url}
                    initialPlatform={
                      isPropertyPlatform(row.platform) ? row.platform : ""
                    }
                    busy={busy}
                    error={formError}
                    submitLabel="Save changes"
                    onSubmit={(url, platform) =>
                      submitEdit(row.id, url, platform)
                    }
                    onCancel={close}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-mono text-sm text-ink">
                        {row.url}
                      </span>
                      <span className="text-xs text-muted">
                        {platformLabel(row.platform)}
                      </span>
                    </div>
                    <StatusPill tone={connection.tone}>
                      {connection.label}
                    </StatusPill>
                    <Button
                      ref={(el: HTMLButtonElement | null) => {
                        if (el) editButtonRefs.current.set(row.id, el);
                        else editButtonRefs.current.delete(row.id);
                      }}
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || mode.kind !== "idle"}
                      aria-label={`Edit ${row.url}`}
                      onClick={() => openEdit(row.id)}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {mode.kind === "add" ? (
        <PropertyForm
          idPrefix="add-property"
          initialUrl=""
          initialPlatform=""
          busy={busy}
          error={formError}
          submitLabel="Save website"
          onSubmit={submitAdd}
          onCancel={close}
        />
      ) : rows.length > 0 ? (
        <div>
          {/* disabled while busy (Code minor 2): an in-flight edit must not be
              able to resolve into — or error-attribute onto — a freshly opened
              add form. */}
          <Button
            ref={addButtonRef}
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={openAdd}
          >
            <PlusIcon aria-hidden /> Add a website
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className={"text-sm " + POSITIVE_TEXT_CLASS}>
          {notice}
        </p>
      ) : null}

      <p className="text-xs leading-5 text-muted">
        Connecting a site for crawling and auto-fixes isn&apos;t available yet —
        that ships with the Connections step. Every site here is saved as not
        connected.
      </p>
    </div>
  );
}
