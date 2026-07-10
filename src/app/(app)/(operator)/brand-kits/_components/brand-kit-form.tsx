"use client";

/**
 * Brand-kit ingest + revise form — the operator flow that unblocks production
 * (content generation refuses to run without a locked kit). One client component
 * serves both modes:
 *
 *   edit → REVIEW (dry-run preview) → confirm lock → navigate to the real kit
 *
 * The review step calls the read-only preview seam (_actions/preview) so the
 * operator sees what the engine WILL do — contrast corrections, defaulted and
 * missing inputs — and, when a palette can't be made accessible, the STRUCTURED
 * refusal (exactly which checks failed) BEFORE anything is locked. Locking is
 * the irreversible act, so it is always behind an explicit confirm that states
 * plainly: locked kits are immutable; a change is a new version. The authoritative
 * build + persistence is the frozen engine action (createBrandKit / reviseBrandKit),
 * invoked only on confirm; success routes to the detail of the real persisted kit.
 *
 * Quiet operator surface (doc 06 §5): no signature motion, tokens only.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LoaderCircleIcon,
  LockIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusPill } from "../../../_components/surface";
import {
  ContrastClean,
  ContrastRefusalPanel,
  PaletteSwatches,
  ReportCorrections,
  ReportNotes,
  TypographySummary,
} from "./kit-display";
import {
  previewBrandKitRevision,
  previewNewBrandKit,
  type BrandKitPreviewResult,
  type ResolvedPreviewTokens,
} from "../_actions/preview";
import {
  createBrandKit,
  reviseBrandKit,
  type CreateBrandKitInput,
  type ReviseBrandKitInput,
} from "@/lib/production/brand-kit/actions";
import type { BrandKitRevision } from "@/lib/skills/brand-kit";
import type { IngestionReport } from "@/lib/production/brand-kit";
import type { ColorTokens, LikenessRefs, VoiceProfile } from "@/lib/types/brand";

/* ------------------------------------------------------------------ */
/* Field metadata                                                      */
/* ------------------------------------------------------------------ */

type ColorKey = keyof ColorTokens;

const PRIMARY_COLORS: Array<{ key: ColorKey; label: string; hint: string }> = [
  { key: "accent", label: "Accent · brand color", hint: "The one color that does the talking — a hex value like #RRGGBB." },
  { key: "surface", label: "Surface · background", hint: "Base chrome. Drives contrast — a clearly light or dark value, not mid-gray." },
];

const ADVANCED_COLORS: Array<{ key: ColorKey; label: string; hint: string }> = [
  { key: "surfaceRaised", label: "Raised surface", hint: "Cards and panels. Defaults from the surface." },
  { key: "ink", label: "Ink · text", hint: "Primary text color." },
  { key: "muted", label: "Muted · text", hint: "Secondary text color." },
  { key: "accentSecondary", label: "Secondary accent", hint: "The energy color, used sparingly." },
  { key: "accentWarm", label: "Warm accent", hint: "Badges and warm detail." },
  { key: "positive", label: "Positive", hint: "Up / success." },
  { key: "negative", label: "Negative", hint: "Down / error." },
];

/* ------------------------------------------------------------------ */
/* Draft state                                                         */
/* ------------------------------------------------------------------ */

interface Item {
  id: string;
  value: string;
}

let uid = 0;
const nextId = () => `f${++uid}`;
const toItems = (values: string[], prefix: string): Item[] =>
  values.length === 0
    ? [{ id: `${prefix}0`, value: "" }]
    : values.map((v, i) => ({ id: `${prefix}${i}`, value: v }));
const itemValues = (items: Item[]): string[] =>
  items.map((i) => i.value.trim()).filter((v) => v.length > 0);

export interface RevisePrefill {
  version: number;
  colors: ColorTokens;
  typography: { display: string; body: string; mono: string };
  voice: VoiceProfile;
  likeness: LikenessRefs;
  logoUrl: string | null;
}

type BrandKitFormProps =
  | { mode: "create"; clientId: string; clientName: string }
  | { mode: "revise"; clientId: string; clientName: string; prefill: RevisePrefill };

type Phase = "edit" | "review" | "refused";

// Exactly the engine's accepted forms (skill normalizeHex): 3/4/6/8 hex digits,
// `#` optional — so a 5/7-digit value fails INLINE, not at the generic banner.
const HEX_RE = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const looksLikeHex = (v: string) => v.trim() === "" || HEX_RE.test(v.trim());

/** CSS needs the `#` even though the engine accepts hash-less hex — preview fills prepend it. */
function swatchFill(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/* ------------------------------------------------------------------ */
/* Small field helpers                                                 */
/* ------------------------------------------------------------------ */

function ColorField({
  id,
  label,
  hint,
  value,
  required,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  required?: boolean;
  onChange: (v: string) => void;
}) {
  const invalid = !looksLikeHex(value);
  const showFill = value.trim() !== "" && !invalid;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
        {required ? <span className="text-negative"> *</span> : null}
      </Label>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-md border border-border"
          style={showFill ? { backgroundColor: swatchFill(value) } : undefined}
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#RRGGBB"
          spellCheck={false}
          autoComplete="off"
          required={required}
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          className="font-mono"
        />
      </div>
      <p
        id={hintId}
        className={"text-[11px] leading-4 " + (invalid ? "text-negative" : "text-muted")}
      >
        {invalid ? "Enter a hex value like #RRGGBB." : hint}
      </p>
    </div>
  );
}

function ListEditor({
  legend,
  hint,
  items,
  onChange,
  placeholder,
  multiline,
  addLabel,
}: {
  legend: string;
  hint?: string;
  items: Item[];
  onChange: (items: Item[]) => void;
  placeholder: string;
  multiline?: boolean;
  addLabel: string;
}) {
  const update = (id: string, value: string) =>
    onChange(items.map((it) => (it.id === id ? { ...it, value } : it)));
  const add = () => onChange([...items, { id: nextId(), value: "" }]);
  const remove = (id: string) => {
    const next = items.filter((it) => it.id !== id);
    onChange(next.length === 0 ? [{ id: nextId(), value: "" }] : next);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-medium text-ink">{legend}</legend>
      {hint ? <p className="text-[11px] leading-4 text-muted">{hint}</p> : null}
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <div key={it.id} className="flex items-start gap-2">
            {multiline ? (
              <Textarea
                value={it.value}
                onChange={(e) => update(it.id, e.target.value)}
                placeholder={placeholder}
                className="min-h-14"
              />
            ) : (
              <Input
                value={it.value}
                onChange={(e) => update(it.id, e.target.value)}
                placeholder={placeholder}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(it.id)}
              aria-label={`Remove ${legend} entry`}
              className="shrink-0 text-muted"
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <PlusIcon aria-hidden /> {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-bold tracking-tight text-ink">{title}</h2>
        {description ? <p className="text-xs leading-5 text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The form                                                            */
/* ------------------------------------------------------------------ */

export function BrandKitForm(props: BrandKitFormProps) {
  const { mode, clientId, clientName } = props;
  const router = useRouter();

  const prefill = mode === "revise" ? props.prefill : null;

  // Colors: pre-filled from the current kit for revise; blank for create.
  const [colors, setColors] = React.useState<Record<ColorKey, string>>(() => {
    const base = {
      surface: "",
      surfaceRaised: "",
      ink: "",
      muted: "",
      accent: "",
      accentSecondary: "",
      accentWarm: "",
      positive: "",
      negative: "",
    } as Record<ColorKey, string>;
    if (prefill) {
      for (const key of Object.keys(base) as ColorKey[]) base[key] = prefill.colors[key] ?? "";
    }
    return base;
  });
  const [faces, setFaces] = React.useState(() => ({
    display: prefill?.typography.display ?? "",
    body: prefill?.typography.body ?? "",
    mono: prefill?.typography.mono ?? "",
  }));
  const [logoUrl, setLogoUrl] = React.useState(prefill?.logoUrl ?? "");
  const [descriptors, setDescriptors] = React.useState<Item[]>(() =>
    toItems(prefill?.voice.descriptors ?? [], "d"),
  );
  const [dos, setDos] = React.useState<Item[]>(() => toItems(prefill?.voice.do ?? [], "do"));
  const [donts, setDonts] = React.useState<Item[]>(() => toItems(prefill?.voice.dont ?? [], "dn"));
  const [samples, setSamples] = React.useState<Item[]>(() =>
    toItems(prefill?.voice.samples ?? [], "s"),
  );
  const [higgs, setHiggs] = React.useState<Item[]>(() =>
    toItems(prefill?.likeness.higgsfieldElementIds ?? [], "hg"),
  );
  const [motion, setMotion] = React.useState<Item[]>(() =>
    toItems(prefill?.likeness.motionElementIds ?? [], "mo"),
  );
  const [showAdvancedColors, setShowAdvancedColors] = React.useState(false);

  const [phase, setPhase] = React.useState<Phase>("edit");
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<IngestionReport | null>(null);
  const [resolved, setResolved] = React.useState<ResolvedPreviewTokens | null>(null);
  const [topError, setTopError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<{
    message: string;
    recover?: { href: string; label: string };
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Phase transitions swap the whole panel; without this, focus drops to <body>
  // and screen-reader/keyboard users lose their place. Move focus to the new
  // panel's heading (both carry tabIndex={-1}).
  const reviewHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const refusalHeadingRef = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(() => {
    if (phase === "review") reviewHeadingRef.current?.focus();
    else if (phase === "refused") refusalHeadingRef.current?.focus();
  }, [phase]);

  const setColor = (key: ColorKey, v: string) =>
    setColors((prev) => ({ ...prev, [key]: v }));

  const accentMissing = colors.accent.trim() === "";
  const anyColorInvalid = (Object.values(colors) as string[]).some((v) => !looksLikeHex(v));
  const canReview = !busy && !accentMissing && !anyColorInvalid;

  /* ---- assemble engine inputs (omit blanks — the skill throws on "") ---- */

  const buildColors = React.useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(colors)) {
      if (value.trim() !== "") out[key] = value.trim();
    }
    return out;
  }, [colors]);

  const buildFaces = React.useCallback((): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    if (faces.display.trim()) out.display = faces.display.trim();
    if (faces.body.trim()) out.body = faces.body.trim();
    if (faces.mono.trim()) out.mono = faces.mono.trim();
    return Object.keys(out).length > 0 ? out : undefined;
  }, [faces]);

  const buildCreateInput = React.useCallback((): CreateBrandKitInput => {
    const voice: Partial<VoiceProfile> = {};
    const d = itemValues(descriptors);
    const s = itemValues(samples);
    const dd = itemValues(dos);
    const dn = itemValues(donts);
    if (d.length) voice.descriptors = d;
    if (s.length) voice.samples = s;
    if (dd.length) voice.do = dd;
    if (dn.length) voice.dont = dn;

    const likeness: Partial<LikenessRefs> = {};
    const hg = itemValues(higgs);
    const mo = itemValues(motion);
    if (hg.length) likeness.higgsfieldElementIds = hg;
    if (mo.length) likeness.motionElementIds = mo;

    const faceObj = buildFaces();
    return {
      clientId,
      // accent is guaranteed present at call time (canReview gates it); the map
      // is built by filtering blanks, so the double cast is the honest bridge.
      colors: buildColors() as unknown as CreateBrandKitInput["colors"],
      ...(faceObj ? { typography: faceObj as CreateBrandKitInput["typography"] } : {}),
      ...(Object.keys(voice).length ? { voice } : {}),
      ...(Object.keys(likeness).length ? { likeness } : {}),
      ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
    };
  }, [clientId, descriptors, samples, dos, donts, higgs, motion, buildFaces, buildColors, logoUrl]);

  const buildReviseInput = React.useCallback((): ReviseBrandKitInput => {
    const tokens: NonNullable<BrandKitRevision["tokens"]> = {};
    const c = buildColors();
    if (Object.keys(c).length) tokens.colors = c as NonNullable<BrandKitRevision["tokens"]>["colors"];
    const faceObj = buildFaces();
    if (faceObj) tokens.typography = faceObj as NonNullable<BrandKitRevision["tokens"]>["typography"];

    const changes: BrandKitRevision = {};
    if (Object.keys(tokens).length) changes.tokens = tokens;
    // Arrays replace wholesale on revise — send the current lists (edited or not).
    changes.voice_profile = {
      descriptors: itemValues(descriptors),
      samples: itemValues(samples),
      do: itemValues(dos),
      dont: itemValues(donts),
    };
    changes.likeness_refs = {
      higgsfieldElementIds: itemValues(higgs),
      motionElementIds: itemValues(motion),
    };
    return { clientId, changes, logoUrl: logoUrl.trim() === "" ? null : logoUrl.trim() };
  }, [clientId, descriptors, samples, dos, donts, higgs, motion, buildFaces, buildColors, logoUrl]);

  /* ---- review (dry-run preview) ---- */

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canReview) return;
    setBusy(true);
    setTopError(null);
    setSubmitError(null);
    let result: BrandKitPreviewResult;
    try {
      result =
        mode === "create"
          ? await previewNewBrandKit(buildCreateInput())
          : await previewBrandKitRevision(buildReviseInput());
    } catch {
      setBusy(false);
      setTopError("We couldn’t reach the review step. Check your connection and try again.");
      return;
    }
    setBusy(false);
    if (!result.ok) {
      if (result.reason === "invalid_brand_input") {
        setTopError(result.error);
        return;
      }
      // forbidden / not_found / no_kit / read_failed — a state the operator
      // can't fix by editing a field; surface it verbatim at the top.
      setTopError(result.error);
      return;
    }
    setReport(result.report);
    setResolved(result.resolved);
    setPhase(result.report.contrastResolved ? "review" : "refused");
  };

  /* ---- confirm lock (the real, persisting write) ---- */

  const handleConfirm = async () => {
    if (busy) return; // re-entrancy guard — one lock write at a time
    setBusy(true);
    setSubmitError(null);
    try {
      if (mode === "create") {
        const res = await createBrandKit(buildCreateInput());
        if (res.ok) {
          router.push(`/brand-kits/${clientId}?created=1`);
          return; // keep busy true through navigation
        }
        handleWriteFailure(res.reason, res.error);
      } else {
        const res = await reviseBrandKit(buildReviseInput());
        if (res.ok) {
          router.push(`/brand-kits/${clientId}?revised=${res.version}`);
          return;
        }
        handleWriteFailure(res.reason, res.error);
      }
    } catch {
      setSubmitError({
        message: "We couldn’t save this brand kit. Check your connection and try again.",
      });
    }
    setBusy(false);
    setConfirmOpen(false);
  };

  const handleWriteFailure = (reason: string, error: string) => {
    if (reason === "already_exists") {
      setSubmitError({
        message: error,
        recover: { href: `/brand-kits/${clientId}`, label: "Open the existing kit" },
      });
      return;
    }
    if (reason === "no_kit") {
      setSubmitError({
        message: error,
        recover: { href: `/brand-kits/new/${clientId}`, label: "Create the first kit" },
      });
      return;
    }
    if (reason === "not_found") {
      setSubmitError({
        message: error,
        recover: { href: "/brand-kits/new", label: "Back to client picker" },
      });
      return;
    }
    if (reason === "contrast_unresolvable" || reason === "invalid_brand_input") {
      // Shouldn't happen after a clean preview, but stay honest: send them back to
      // edit, where the top banner (not the review panel) is what renders.
      setTopError(error);
      setReport(null);
      setResolved(null);
      setPhase("edit");
      return;
    }
    setSubmitError({ message: error });
  };

  const backToEdit = () => {
    setPhase("edit");
    setReport(null);
    setResolved(null);
    setSubmitError(null);
  };

  /* ---- render ---- */

  const reviewLabel = mode === "create" ? "Lock & create" : "Lock revision";
  const nextVersion = prefill ? prefill.version + 1 : 1;

  // Blank-field semantics DIFFER by mode and by field group — the copy states
  // each rule plainly so a blank never lies:
  //  - create: a blank color/font falls back to an accessible platform default.
  //  - revise: colors/fonts deep-merge — a CLEARED field keeps its current
  //    value (it is omitted from the revision, so the old value carries
  //    forward); it is NOT reset to a default and NOT removed.
  //  - revise: voice, likeness, and logo save exactly as shown — clearing an
  //    entry (or the logo) REMOVES it from the new version.
  const isRevise = mode === "revise";
  const paletteCopy = isRevise
    ? "Pre-filled from the current version. Clearing a color keeps its current value — it isn’t removed and doesn’t reset to a default. The review shows the exact palette that will lock."
    : "The brand color is required; anything left blank falls back to an accessible platform default — the review shows exactly what resolves before you lock.";
  const typographyCopy = isRevise
    ? "Plain font names, pre-filled from the current version. Clearing a font keeps the current face — it doesn’t reset it. The type scale carries forward unchanged; custom scales aren’t edited here yet."
    : "Plain font names — e.g. “Söhne”, “Inter”, “IBM Plex Mono”. Leave blank to use the platform default face. The type scale uses the default scale; custom scales aren’t edited here yet.";
  const voiceCopy = isRevise
    ? "Read at generation time so content ships in this brand’s voice. These lists save exactly as shown — removing an entry removes it from the new version."
    : "Read at generation time so content ships in this brand’s voice. Without descriptors or samples, voice can’t be enforced.";
  const logoCopy = isRevise
    ? "Saved exactly as shown: clearing the logo or a reference removes it from the new version. The logo feeds schema and press placements; likeness references anchor on-brand media generation."
    : "Optional. The logo feeds schema and press placements; likeness references anchor on-brand media generation.";

  return (
    <div className="flex flex-col gap-6">
      {topError ? (
        <div
          role="alert"
          className="rounded-lg border border-negative/40 bg-negative/5 px-4 py-3 text-sm text-ink"
        >
          {topError}
        </div>
      ) : null}

      {phase === "edit" ? (
        <form onSubmit={handleReview} className="flex flex-col gap-8">
          <Section title="Palette" description={paletteCopy}>
            <div className="grid gap-4 sm:grid-cols-2">
              {PRIMARY_COLORS.map((f) => (
                <ColorField
                  key={f.key}
                  id={`color-${f.key}`}
                  label={f.label}
                  hint={f.hint}
                  value={colors[f.key]}
                  required={f.key === "accent"}
                  onChange={(v) => setColor(f.key, v)}
                />
              ))}
            </div>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAdvancedColors((s) => !s)}
              >
                {showAdvancedColors ? "Hide" : "Show"} the rest of the palette
              </Button>
            </div>
            {showAdvancedColors ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {ADVANCED_COLORS.map((f) => (
                  <ColorField
                    key={f.key}
                    id={`color-${f.key}`}
                    label={f.label}
                    hint={f.hint}
                    value={colors[f.key]}
                    onChange={(v) => setColor(f.key, v)}
                  />
                ))}
              </div>
            ) : null}
          </Section>

          <Section title="Typography" description={typographyCopy}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="face-display" className="text-xs">Display font</Label>
                <Input
                  id="face-display"
                  value={faces.display}
                  onChange={(e) => setFaces((f) => ({ ...f, display: e.target.value }))}
                  placeholder="Söhne"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="face-body" className="text-xs">Body font</Label>
                <Input
                  id="face-body"
                  value={faces.body}
                  onChange={(e) => setFaces((f) => ({ ...f, body: e.target.value }))}
                  placeholder="Inter"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="face-mono" className="text-xs">Mono font</Label>
                <Input
                  id="face-mono"
                  value={faces.mono}
                  onChange={(e) => setFaces((f) => ({ ...f, mono: e.target.value }))}
                  placeholder="IBM Plex Mono"
                  autoComplete="off"
                />
              </div>
            </div>
          </Section>

          <Section title="Brand voice" description={voiceCopy}>
            <ListEditor
              legend="Descriptors"
              hint="Short tone words — e.g. “confident”, “plain-spoken”, “warm”."
              items={descriptors}
              onChange={setDescriptors}
              placeholder="confident"
              addLabel="Add descriptor"
            />
            <div className="grid gap-6 sm:grid-cols-2">
              <ListEditor
                legend="Do"
                items={dos}
                onChange={setDos}
                placeholder="Lead with the outcome"
                addLabel="Add do-rule"
              />
              <ListEditor
                legend="Don’t"
                items={donts}
                onChange={setDonts}
                placeholder="Don’t use hype words"
                addLabel="Add don’t-rule"
              />
            </div>
            <ListEditor
              legend="Samples"
              hint="Paste a paragraph or two of on-brand copy the model can learn the voice from."
              items={samples}
              onChange={setSamples}
              placeholder="A short sample of the brand’s writing…"
              multiline
              addLabel="Add sample"
            />
          </Section>

          <Section title="Logo & likeness" description={logoCopy}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="logo-url" className="text-xs">Logo URL</Label>
              <Input
                id="logo-url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://…/logo.svg"
                autoComplete="off"
                inputMode="url"
              />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <ListEditor
                legend="Higgsfield reference IDs"
                items={higgs}
                onChange={setHiggs}
                placeholder="element id"
                addLabel="Add Higgsfield ID"
              />
              <ListEditor
                legend="Motion reference IDs"
                items={motion}
                onChange={setMotion}
                placeholder="element id"
                addLabel="Add Motion ID"
              />
            </div>
          </Section>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
            <p className="text-xs text-muted">
              {accentMissing
                ? "Add a brand color to continue."
                : "Review builds a preview — nothing is saved until you lock it."}
            </p>
            <Button type="submit" disabled={!canReview}>
              {busy ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden />
              ) : (
                <ArrowRightIcon aria-hidden />
              )}
              Review
            </Button>
          </div>
        </form>
      ) : null}

      {phase === "review" && report ? (
        <ReviewPanel
          mode={mode}
          clientName={clientName}
          nextVersion={nextVersion}
          report={report}
          resolved={resolved}
          headingRef={reviewHeadingRef}
          entered={<EnteredSummary
            colors={colors}
            faces={faces}
            logoUrl={logoUrl}
            voiceCounts={{
              descriptors: itemValues(descriptors).length,
              samples: itemValues(samples).length,
              do: itemValues(dos).length,
              dont: itemValues(donts).length,
            }}
            likenessCounts={{
              higgsfield: itemValues(higgs).length,
              motion: itemValues(motion).length,
            }}
          />}
          busy={busy}
          confirmOpen={confirmOpen}
          onConfirmOpenChange={setConfirmOpen}
          onConfirm={handleConfirm}
          onBack={backToEdit}
          confirmLabel={reviewLabel}
          submitError={submitError}
        />
      ) : null}

      {phase === "refused" && report ? (
        <div className="flex flex-col gap-5">
          <ContrastRefusalPanel report={report} headingRef={refusalHeadingRef} />
          <div className="flex items-center gap-3 border-t border-border pt-5">
            <Button type="button" variant="outline" onClick={backToEdit}>
              <ArrowLeftIcon aria-hidden /> Back to edit
            </Button>
            <p className="text-xs text-muted">
              Adjust the surface or background color, then review again.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review panel                                                        */
/* ------------------------------------------------------------------ */

function ReviewPanel({
  mode,
  clientName,
  nextVersion,
  report,
  resolved,
  headingRef,
  entered,
  busy,
  confirmOpen,
  onConfirmOpenChange,
  onConfirm,
  onBack,
  confirmLabel,
  submitError,
}: {
  mode: "create" | "revise";
  clientName: string;
  /** EXPECTED next version (prior + 1 at load). The server assigns the real
   * number — a concurrent revision can shift it, so copy never asserts it as fact. */
  nextVersion: number;
  report: IngestionReport;
  /** The resolved token set this lock will persist (engine-computed). */
  resolved: ResolvedPreviewTokens | null;
  /** Focus target on entering the review phase. */
  headingRef: React.Ref<HTMLHeadingElement>;
  entered: React.ReactNode;
  busy: boolean;
  confirmOpen: boolean;
  onConfirmOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onBack: () => void;
  confirmLabel: string;
  submitError: { message: string; recover?: { href: string; label: string } } | null;
}) {
  const noChanges =
    report.contrastCorrections.filter((c) => c.resolved).length === 0 &&
    report.notes.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-xl font-bold tracking-tight text-ink outline-none"
          >
            Review before locking
          </h2>
          <StatusPill tone="accent">
            {mode === "create" ? "Version 1" : "Next version"}
          </StatusPill>
        </div>
        <p className="text-xs leading-5 text-muted">
          {mode === "create"
            ? `This becomes ${clientName}’s locked brand kit. Locking is immutable — a later change creates a new version.`
            : `This creates the next version for ${clientName} (expected v${nextVersion} — the server assigns the final number). The current version stays immutable — its history is preserved.`}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4">
        <span className="text-[11px] tracking-wide text-muted uppercase">You entered</span>
        {entered}
      </div>

      {/* What locking will PERSIST — the engine-resolved system: merged with
          carried-forward values (revise), defaults filled (create), contrast
          corrections applied. Never less than what the lock stores. */}
      {resolved ? (
        <div className="flex flex-col gap-4 rounded-lg border border-border px-4 py-4">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] tracking-wide text-muted uppercase">
              What will lock
            </span>
            <p className="text-xs leading-5 text-muted">
              {mode === "revise"
                ? "The resolved system this lock persists — your changes merged onto the current version, with contrast corrections applied."
                : "The resolved system this lock persists — your inputs plus filled defaults, with contrast corrections applied."}
            </p>
          </div>
          <PaletteSwatches colors={resolved.colors} />
          <TypographySummary typography={resolved.typography} />
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        {noChanges ? <ContrastClean /> : null}
        <ReportCorrections corrections={report.contrastCorrections} />
        <ReportNotes notes={report.notes} />
      </div>

      {submitError ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-negative/40 bg-negative/5 px-4 py-3 text-sm text-ink"
        >
          <span>{submitError.message}</span>
          {submitError.recover ? (
            <Button asChild variant="outline" size="sm" className="self-start">
              <Link href={submitError.recover.href}>{submitError.recover.label}</Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon aria-hidden /> Back to edit
        </Button>

        {/* While the lock write is in flight the dialog must not LOOK cancellable:
            no X, and Escape / overlay-click are inert (the write is already on
            the server — dismissing the dialog would not stop it). */}
        <Dialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (busy) return;
            onConfirmOpenChange(open);
          }}
        >
          <Button type="button" onClick={() => onConfirmOpenChange(true)} disabled={busy}>
            <LockIcon aria-hidden /> {confirmLabel}
          </Button>
          <DialogContent
            showCloseButton={!busy}
            onEscapeKeyDown={(e) => {
              if (busy) e.preventDefault();
            }}
            onPointerDownOutside={(e) => {
              if (busy) e.preventDefault();
            }}
            onInteractOutside={(e) => {
              if (busy) e.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>{confirmLabel}?</DialogTitle>
              <DialogDescription>
                Locked kits are immutable — changes after locking create a new
                version. {mode === "create"
                  ? "This locks version 1 as the enforced brand system."
                  : "This locks the next version; the current version stays as history."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onConfirmOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm} disabled={busy}>
                {busy ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <LockIcon aria-hidden />}
                {confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "You entered" summary — the operator's own inputs (not engine output)*/
/* ------------------------------------------------------------------ */

function EnteredSummary({
  colors,
  faces,
  logoUrl,
  voiceCounts,
  likenessCounts,
}: {
  colors: Record<ColorKey, string>;
  faces: { display: string; body: string; mono: string };
  logoUrl: string;
  voiceCounts: { descriptors: number; samples: number; do: number; dont: number };
  likenessCounts: { higgsfield: number; motion: number };
}) {
  const providedColors = (Object.entries(colors) as Array<[ColorKey, string]>).filter(
    ([, v]) => v.trim() !== "",
  );
  const providedFaces = [
    ["Display", faces.display],
    ["Body", faces.body],
    ["Mono", faces.mono],
  ].filter(([, v]) => v.trim() !== "") as Array<[string, string]>;

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap gap-2">
        {providedColors.map(([key, value]) => (
          <span
            key={key}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
          >
            <span
              aria-hidden
              className="size-3.5 rounded-sm border border-border"
              style={{ backgroundColor: swatchFill(value) }}
            />
            <span className="font-mono text-[11px] text-ink uppercase">{value.trim()}</span>
          </span>
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-muted">
        {providedFaces.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <dt>Fonts</dt>
            <dd className="text-ink">{providedFaces.map(([, v]) => v.trim()).join(" · ")}</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <dt>Voice</dt>
          <dd className="text-ink">
            {voiceCounts.descriptors} descriptors · {voiceCounts.samples} samples ·{" "}
            {voiceCounts.do + voiceCounts.dont} rules
          </dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Likeness</dt>
          <dd className="text-ink">{likenessCounts.higgsfield + likenessCounts.motion} refs</dd>
        </div>
        {logoUrl.trim() ? (
          <div className="flex items-center gap-1.5">
            <dt>Logo</dt>
            <dd className="max-w-[16rem] truncate text-ink" title={logoUrl.trim()}>
              {logoUrl.trim()}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
