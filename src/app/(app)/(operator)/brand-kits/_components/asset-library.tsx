"use client";

/**
 * The per-client Brand Asset Library — the client's "home of assets" (operator
 * direction: "every client has their own home of assets, branding never mixed").
 * Client-scoped by the `clientId` prop (the URL carries it; RLS is the boundary
 * below); this surface NEVER offers a cross-client action or list.
 *
 * BUILT TO THE LANDED CONTRACT (src/lib/brand-assets/*), nothing more:
 *  - LIST comes from the server page's `listBrandAssets` read (server truth);
 *    after a write, rows update from the ACTION'S returned asset — never an
 *    optimistic fabrication. An unconfirmed round-trip → router.refresh() and the
 *    compare-before-set re-seed inspect server truth (the house pattern).
 *  - UPLOAD routes by file kind: RASTER (png/jpeg/webp/gif) → requestAssetUpload
 *    → browser PUT to the signed URL (uploadToSignedUrl) → finalizeAssetUpload
 *    (magic-byte verified server-side); SVG → uploadSvgAsset (bytes through the
 *    action body, sanitized server-side — NEVER the signed PUT). Every refusal is
 *    rendered VERBATIM from the action/validator.
 *  - REPLACE reuses the same two flows with `replaceAssetId`. The landed repoint
 *    swaps bytes + label but NOT the stored `type`, so the type is LOCKED to the
 *    asset's slot on replace (stated in the form).
 *  - REMOVE = removeAsset. Two-step inline confirm (autoFocus Cancel, so a held
 *    Enter can't complete a delete). The action ARCHIVES (keeps bytes) when a
 *    LOCKED brand kit references the asset, else hard-removes — surfaced honestly.
 *  - WRITER FLOOR: writes admit staff (requireOperator = is_writer). A non-writer
 *    who reaches this operator surface sees the library READ-ONLY, no controls —
 *    mirroring the action floor (the action would refuse anyway).
 *
 * THE SERVE CONTRACT is owned by <AssetThumb>: bytes render ONLY via `<img src>`
 * from a signed URL, never inline SVG / injected DOM. This island never touches
 * asset bytes.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  FolderIcon,
  ImageIcon,
  ImagePlusIcon,
  PlusIcon,
  ShapesIcon,
  SquareIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";

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
import { EmptyState, FailedState, StatusPill } from "../../../_components/surface";
import { NEGATIVE_TEXT_CLASS, POSITIVE_TEXT_CLASS } from "../../../_components/tone";
import { makeAnnouncer } from "@/components/announcer";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import {
  finalizeAssetUpload,
  removeAsset,
  requestAssetUpload,
  uploadSvgAsset,
} from "@/lib/brand-assets/actions";
import {
  BRAND_ASSET_LABEL_MAX_CHARS,
  BRAND_ASSET_TYPES,
  type BrandAsset,
  type BrandAssetType,
} from "@/lib/brand-assets";
import {
  ASSET_ACCEPT_ATTR,
  ASSET_TYPE_HINT,
  ASSET_TYPE_LABEL,
  formatBytes,
  groupAssets,
  mimeShortLabel,
  precheckFile,
  type AssetGroupDef,
} from "./asset-library-shared";
import { AssetThumb } from "./asset-thumb";

/** Mirrors the server BUCKET (actions.ts) — the fixed private bucket the browser
 *  PUTs the signed raster upload into. */
const BUCKET = "brand-assets";

/** Honest fallback when a write can't be confirmed to have round-tripped. The
 *  recovery is REAL: the catch path calls router.refresh(), the server read
 *  re-runs, and the compare-before-set sync re-seeds the list. */
const SEAM_UNREACHABLE =
  "We couldn’t confirm that. We’ve refreshed the library below — check it before trying again.";

/** The signed PUT failed (network / storage unreachable) — the object never
 *  landed, so no finalize is attempted. */
const UPLOAD_PUT_FAILED =
  "We couldn’t upload that file to storage. Check your connection and try again.";

const { announce, Announcer } = makeAnnouncer();

const GROUP_ICON: Record<AssetGroupDef["id"], LucideIcon> = {
  logos: ShapesIcon,
  favicon: SquareIcon,
  icons: ShapesIcon,
  imagery: ImageIcon,
  other: FolderIcon,
};

/* ------------------------------------------------------------------ */
/* Upload orchestration (browser side of the two-phase raster flow)    */
/* ------------------------------------------------------------------ */

type UploadResult = { ok: true; asset: BrandAsset } | { ok: false; error: string };

async function performRasterUpload(args: {
  clientId: string;
  type: BrandAssetType;
  label: string | undefined;
  contentType: string;
  file: File;
  replaceAssetId?: string;
}): Promise<UploadResult> {
  const req = await requestAssetUpload({
    clientId: args.clientId,
    type: args.type,
    label: args.label,
    contentType: args.contentType,
    sizeBytes: args.file.size,
  });
  if (!req.ok) return { ok: false, error: req.error };

  // Browser PUT to the signed URL. The stored content-type is browser-asserted
  // here; finalize re-sniffs the REAL bytes and refuses a non-raster, so a lie
  // only wastes this round-trip.
  try {
    const supabase = createBrowserSupabase();
    const { error } = await supabase.storage
      .from(BUCKET)
      .uploadToSignedUrl(req.storagePath, req.token, args.file);
    if (error) return { ok: false, error: UPLOAD_PUT_FAILED };
  } catch {
    return { ok: false, error: UPLOAD_PUT_FAILED };
  }

  const fin = await finalizeAssetUpload({
    clientId: args.clientId,
    storagePath: req.storagePath,
    type: args.type,
    label: args.label,
    contentType: args.contentType,
    sizeBytes: args.file.size,
    replaceAssetId: args.replaceAssetId,
  });
  return fin.ok ? { ok: true, asset: fin.asset } : { ok: false, error: fin.error };
}

async function performSvgUpload(args: {
  clientId: string;
  type: BrandAssetType;
  label: string | undefined;
  file: File;
  replaceAssetId?: string;
}): Promise<UploadResult> {
  // SVG NEVER takes the signed PUT — the raw text travels in the action body and
  // is sanitized server-side before storage.
  const svg = await args.file.text();
  const res = await uploadSvgAsset({
    clientId: args.clientId,
    type: args.type,
    label: args.label,
    svg,
    replaceAssetId: args.replaceAssetId,
  });
  return res.ok ? { ok: true, asset: res.asset } : { ok: false, error: res.error };
}

/* ------------------------------------------------------------------ */
/* Upload / replace form                                               */
/* ------------------------------------------------------------------ */

type FormMode = { kind: "add" } | { kind: "replace"; asset: BrandAsset };

function AssetUploadPanel({
  clientId,
  mode,
  busy,
  setBusy,
  onUploaded,
  onCancel,
  onSeamError,
}: {
  clientId: string;
  mode: FormMode;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onUploaded: (asset: BrandAsset, replaced: boolean) => void;
  onCancel: () => void;
  onSeamError: () => void;
}) {
  const replacing = mode.kind === "replace";
  const [picked, setPicked] = React.useState<
    { file: File; kind: "svg" | "raster"; contentType?: string } | null
  >(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [type, setType] = React.useState<BrandAssetType | "">(
    replacing ? mode.asset.type : "",
  );
  const [label, setLabel] = React.useState<string>(
    replacing ? (mode.asset.label ?? "") : "",
  );
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const effectiveType: BrandAssetType | "" = replacing ? mode.asset.type : type;

  const onFile = (file: File | undefined) => {
    setSubmitError(null);
    if (!file) {
      setPicked(null);
      setFileError(null);
      return;
    }
    const check = precheckFile({ name: file.name, type: file.type, size: file.size });
    if (!check.ok) {
      setPicked(null);
      setFileError(check.error);
      return;
    }
    setFileError(null);
    setPicked(
      check.kind === "raster"
        ? { file, kind: "raster", contentType: check.contentType }
        : { file, kind: "svg" },
    );
  };

  const canSubmit = picked !== null && effectiveType !== "" && !busy;

  const submit = async () => {
    if (!picked || effectiveType === "") return;
    setBusy(true);
    setSubmitError(null);
    const replaceAssetId = replacing ? mode.asset.id : undefined;
    const cleanLabel = label.trim() === "" ? undefined : label.trim();
    try {
      const result =
        picked.kind === "svg"
          ? await performSvgUpload({
              clientId,
              type: effectiveType,
              label: cleanLabel,
              file: picked.file,
              replaceAssetId,
            })
          : await performRasterUpload({
              clientId,
              type: effectiveType,
              label: cleanLabel,
              contentType: picked.contentType!,
              file: picked.file,
              replaceAssetId,
            });
      if (result.ok) {
        onUploaded(result.asset, replacing);
      } else {
        setSubmitError(result.error);
      }
    } catch {
      onSeamError();
      setSubmitError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex items-center gap-2">
        <UploadIcon className="size-4 text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">
          {replacing ? `Replace file for “${mode.asset.label ?? ASSET_TYPE_LABEL[mode.asset.type]}”` : "Add an asset"}
        </h2>
      </div>

      {/* FILE */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="asset-file" className="text-muted">
          File
        </Label>
        <input
          id="asset-file"
          type="file"
          autoFocus
          accept={ASSET_ACCEPT_ATTR}
          disabled={busy}
          onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
          className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-border file:bg-overlay file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-overlay/70 disabled:opacity-50"
          aria-describedby={fileError ? "asset-file-error" : "asset-file-hint"}
          aria-invalid={fileError ? true : undefined}
        />
        {picked ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusPill tone="accent">{picked.kind === "svg" ? "SVG" : "Raster"}</StatusPill>
            <span className="truncate font-mono">{picked.file.name}</span>
            <span>· {formatBytes(picked.file.size)}</span>
          </p>
        ) : (
          <p id="asset-file-hint" className="text-xs text-muted">
            PNG, JPG, WebP, GIF, or SVG · up to 10 MB.
          </p>
        )}
        {fileError ? (
          <p id="asset-file-error" role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
            {fileError}
          </p>
        ) : null}
      </div>

      {/* TYPE */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="asset-type" className="text-muted">
          Asset type
        </Label>
        {replacing ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-ink">{ASSET_TYPE_LABEL[mode.asset.type]}</span>
            <p className="text-[11px] leading-4 text-muted italic">
              Type stays the same on replace — this swaps the file in this slot, not the slot itself.
            </p>
          </div>
        ) : (
          <>
            <Select
              value={type || undefined}
              disabled={busy}
              onValueChange={(v) => setType(v as BrandAssetType)}
            >
              <SelectTrigger id="asset-type" className="w-full">
                <SelectValue placeholder="Pick what this asset is" />
              </SelectTrigger>
              <SelectContent>
                {BRAND_ASSET_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ASSET_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {type ? (
              <p className="text-[11px] leading-4 text-muted">{ASSET_TYPE_HINT[type]}</p>
            ) : null}
          </>
        )}
      </div>

      {/* LABEL */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="asset-label" className="text-muted">
          Label <span className="text-muted/70">(optional)</span>
        </Label>
        <Input
          id="asset-label"
          value={label}
          placeholder="e.g. Full colour on white"
          disabled={busy}
          maxLength={BRAND_ASSET_LABEL_MAX_CHARS}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className="text-[11px] leading-4 text-muted">
          Name the colour treatment or variant so the design team can tell versions apart.
        </p>
      </div>

      {submitError ? (
        <p role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
          {submitError}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
          {busy ? "Uploading…" : replacing ? "Replace file" : "Upload asset"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One asset card                                                      */
/* ------------------------------------------------------------------ */

function AssetCard({
  asset,
  inLogos,
  canManage,
  busy,
  confirming,
  disabledControls,
  onReplace,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  registerRemoveRef,
  registerReplaceRef,
}: {
  asset: BrandAsset;
  inLogos: boolean;
  canManage: boolean;
  busy: boolean;
  confirming: boolean;
  disabledControls: boolean;
  onReplace: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  registerRemoveRef: (el: HTMLButtonElement | null) => void;
  registerReplaceRef: (el: HTMLButtonElement | null) => void;
}) {
  const displayName = asset.label ?? ASSET_TYPE_LABEL[asset.type];
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      {/* keyed on storagePath by the parent so a replace re-mounts + re-fetches */}
      <AssetThumb assetId={asset.id} alt={displayName} />

      <div className="flex flex-col gap-1">
        <span className="truncate text-sm font-medium text-ink" title={displayName}>
          {displayName}
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          {inLogos ? (
            <span className="rounded border border-border px-1.5 py-0.5 font-mono uppercase tracking-wide">
              {ASSET_TYPE_LABEL[asset.type]}
            </span>
          ) : null}
          <span>{mimeShortLabel(asset.contentType)}</span>
          <span>· {formatBytes(asset.sizeBytes)}</span>
        </div>
      </div>

      {canManage ? (
        confirming ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-negative/40 bg-negative/5 p-2">
            <span className="text-xs text-ink">Remove this asset?</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy}
                aria-label={`Confirm removing ${displayName}`}
                onClick={onConfirmRemove}
              >
                {busy ? "Removing…" : "Remove"}
              </Button>
              {/* Focus lands on CANCEL, never the destructive control — a held
                  Enter (key-repeat) must not be able to complete a delete. */}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                autoFocus
                disabled={busy}
                aria-label={`Cancel removing ${displayName}`}
                onClick={onCancelRemove}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button
              ref={registerReplaceRef}
              type="button"
              size="xs"
              variant="outline"
              disabled={disabledControls}
              onClick={onReplace}
            >
              Replace
            </Button>
            <Button
              ref={registerRemoveRef}
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabledControls}
              aria-label={`Remove ${displayName}`}
              onClick={onAskRemove}
            >
              Remove
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

type FocusWant = { target: "add" } | { target: "remove"; id: string } | { target: "replace"; id: string };

export function AssetLibrary({
  clientId,
  initial,
  canManage,
}: {
  clientId: string;
  /** Server truth from listBrandAssets; null ⇒ the assets read FAILED (distinct
   *  from an empty library). */
  initial: BrandAsset[] | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const initialFailed = initial === null;
  const [rows, setRows] = React.useState<BrandAsset[]>(initial ?? []);
  const [mode, setMode] = React.useState<FormMode | null>(null);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // COMPARE-BEFORE-SET prop sync (house pattern): a fresh RLS-scoped read
  // (router.refresh() after an unconfirmed write) supersedes local state.
  const [seededFrom, setSeededFrom] = React.useState(initial);
  if (seededFrom !== initial) {
    setSeededFrom(initial);
    setRows(initial ?? []);
  }

  // MANAGED FOCUS: a transient control that unmounts hands focus to a stable
  // target rather than dropping to <body>.
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const removeRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const replaceRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const wantFocus = React.useRef<FocusWant | null>(null);
  React.useEffect(() => {
    const want = wantFocus.current;
    if (!want) return;
    wantFocus.current = null;
    if (want.target === "add") addButtonRef.current?.focus();
    else if (want.target === "remove") removeRefs.current.get(want.id)?.focus();
    else replaceRefs.current.get(want.id)?.focus();
  }, [mode, confirmingId, rows]);

  const openAdd = () => {
    setMode({ kind: "add" });
    setConfirmingId(null);
    setRowError(null);
    setNotice(null);
  };
  const openReplace = (asset: BrandAsset) => {
    setMode({ kind: "replace", asset });
    setConfirmingId(null);
    setRowError(null);
    setNotice(null);
  };
  const closeForm = () => {
    const target: FocusWant =
      mode?.kind === "replace" ? { target: "replace", id: mode.asset.id } : { target: "add" };
    wantFocus.current = target;
    setMode(null);
  };

  const onUploaded = (asset: BrandAsset, replaced: boolean) => {
    setRows((prev) =>
      replaced
        ? prev.map((r) => (r.id === asset.id ? asset : r))
        : [asset, ...prev.filter((r) => r.id !== asset.id)],
    );
    wantFocus.current = replaced ? { target: "replace", id: asset.id } : { target: "add" };
    setMode(null);
    const shownName = asset.label ?? ASSET_TYPE_LABEL[asset.type];
    setNotice(replaced ? `Replaced the file for ${shownName}.` : `Added ${shownName}.`);
    announce(replaced ? `Replaced ${shownName}.` : `Added ${shownName}.`);
  };

  const onSeamError = () => {
    // The write MIGHT have landed — re-read server truth so the list is honest.
    setMode(null);
    router.refresh();
  };

  const askRemove = (id: string) => {
    setConfirmingId(id);
    setRowError(null);
    setNotice(null);
  };
  const cancelRemove = (id: string) => {
    wantFocus.current = { target: "remove", id };
    setConfirmingId(null);
  };
  const confirmRemove = async (asset: BrandAsset) => {
    setBusy(true);
    setRowError(null);
    setNotice(null);
    const shownName = asset.label ?? ASSET_TYPE_LABEL[asset.type];
    try {
      const result = await removeAsset({ assetId: asset.id });
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.id !== asset.id));
        wantFocus.current = { target: "add" };
        setConfirmingId(null);
        if (result.outcome === "archived") {
          setNotice(
            `Kept ${shownName} in history — a locked brand kit still uses it, so it was archived rather than deleted.`,
          );
          announce(`${shownName} archived — kept because a locked kit uses it.`);
        } else {
          setNotice(`Removed ${shownName}.`);
          announce(`Removed ${shownName}.`);
        }
      } else {
        if (result.reason === "not_found") {
          // Ghost row (removed elsewhere): re-read so it clears; arm focus first.
          wantFocus.current = { target: "add" };
          setConfirmingId(null);
          router.refresh();
        }
        setRowError(result.error);
      }
    } catch {
      wantFocus.current = { target: "add" };
      setConfirmingId(null);
      router.refresh();
      setRowError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const grouped = groupAssets(rows);
  const libraryEmpty = rows.length === 0;
  const formActive = mode !== null;

  return (
    <div className="flex flex-col gap-6">
      <Announcer />

      {/* Add affordance (staff) — withheld while a form is open, and when the
          library is empty (the EmptyState below owns the first-run Add, so only
          ONE addButtonRef-bearing button is ever mounted at a time). */}
      {canManage && !formActive && !libraryEmpty ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-5 text-muted">
            Upload logos, favicons, iconography, and imagery — including colour and reversed
            versions. Each asset is filed under this client only.
          </p>
          <Button
            ref={addButtonRef}
            type="button"
            size="sm"
            disabled={busy}
            onClick={openAdd}
          >
            <PlusIcon aria-hidden /> Add an asset
          </Button>
        </div>
      ) : null}

      {canManage && formActive ? (
        <AssetUploadPanel
          clientId={clientId}
          mode={mode}
          busy={busy}
          setBusy={setBusy}
          onUploaded={onUploaded}
          onCancel={closeForm}
          onSeamError={onSeamError}
        />
      ) : null}

      {rowError ? (
        <p role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
          {rowError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`text-sm ${POSITIVE_TEXT_CLASS}`}>
          {notice}
        </p>
      ) : null}

      {initialFailed ? (
        <FailedState subject="the asset library" />
      ) : libraryEmpty && !formActive ? (
        <EmptyState
          icon={ImagePlusIcon}
          title="No assets yet"
          description={
            canManage
              ? "This is this client’s home for brand assets — logos, favicons, icons, and imagery. Upload the first one to start the library."
              : "Your agency uploads and organises this client’s brand assets here."
          }
          action={
            canManage ? (
              <Button ref={addButtonRef} type="button" size="sm" onClick={openAdd}>
                <PlusIcon aria-hidden /> Add an asset
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ group, assets }) => (
            <AssetGroupSection
              key={group.id}
              group={group}
              assets={assets}
              canManage={canManage}
              busy={busy}
              confirmingId={confirmingId}
              formActive={formActive}
              onReplace={openReplace}
              onAskRemove={askRemove}
              onCancelRemove={cancelRemove}
              onConfirmRemove={confirmRemove}
              registerRemoveRef={(id, el) => {
                if (el) removeRefs.current.set(id, el);
                else removeRefs.current.delete(id);
              }}
              registerReplaceRef={(id, el) => {
                if (el) replaceRefs.current.set(id, el);
                else replaceRefs.current.delete(id);
              }}
            />
          ))}
        </div>
      )}

      {!initialFailed && !libraryEmpty ? (
        <p className="border-t border-border pt-3 text-[11px] leading-5 text-muted">
          Removing an asset a locked brand kit relies on archives it (kept in history) instead of
          deleting it, so that kit’s snapshot is never broken.
        </p>
      ) : null}
    </div>
  );
}

function AssetGroupSection({
  group,
  assets,
  canManage,
  busy,
  confirmingId,
  formActive,
  onReplace,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  registerRemoveRef,
  registerReplaceRef,
}: {
  group: AssetGroupDef;
  assets: BrandAsset[];
  canManage: boolean;
  busy: boolean;
  confirmingId: string | null;
  formActive: boolean;
  onReplace: (asset: BrandAsset) => void;
  onAskRemove: (id: string) => void;
  onCancelRemove: (id: string) => void;
  onConfirmRemove: (asset: BrandAsset) => void;
  registerRemoveRef: (id: string, el: HTMLButtonElement | null) => void;
  registerReplaceRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
  const Icon = GROUP_ICON[group.id];
  const inLogos = group.id === "logos";
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted" aria-hidden strokeWidth={1.75} />
        <h2 className="text-sm font-semibold text-ink">{group.title}</h2>
        <span className="font-mono text-[11px] text-muted">{assets.length}</span>
      </div>

      {assets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
          {group.emptyTitle}
          {canManage ? " — add one above." : "."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((asset) => (
            <AssetCard
              // storagePath in the key so a replace (new object path) re-mounts
              // the card + its thumbnail, forcing a fresh signed-URL fetch.
              key={`${asset.id}:${asset.storagePath}`}
              asset={asset}
              inLogos={inLogos}
              canManage={canManage}
              busy={busy}
              confirming={confirmingId === asset.id}
              disabledControls={busy || confirmingId !== null || formActive}
              onReplace={() => onReplace(asset)}
              onAskRemove={() => onAskRemove(asset.id)}
              onCancelRemove={() => onCancelRemove(asset.id)}
              onConfirmRemove={() => onConfirmRemove(asset)}
              registerRemoveRef={(el) => registerRemoveRef(asset.id, el)}
              registerReplaceRef={(el) => registerReplaceRef(asset.id, el)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
