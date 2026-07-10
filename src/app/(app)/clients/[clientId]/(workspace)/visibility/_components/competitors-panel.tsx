"use client";

/**
 * The Competitors management surface on the Visibility tab — the natural home,
 * since share of voice (M4) renders here and these are the named competitors it
 * measures the client against. Deliberately quiet (utilitarian operator surface,
 * doc 06 §4): no motion, tokens only.
 *
 * BUILT TO THE LANDED CONTRACT (src/lib/competitors/*), nothing more:
 *  - LIST: seeded from the page's RLS-scoped read (server truth); after a write,
 *    rows update from the ACTION'S returned values — never an optimistic
 *    fabrication. An unconfirmed round-trip triggers router.refresh() and the
 *    fresh read re-seeds the list (compare-before-set, the house pattern).
 *  - ADD: `addCompetitor` (name required ≤120, optional bare-hostname domain).
 *    Field refusals are the LANDED validator's own messages, rendered verbatim —
 *    the same grammar the server re-checks (defence in depth, never a fork).
 *  - REMOVE: `removeCompetitor` (a landed, tested action). Two-step inline confirm
 *    so a permanent delete is never a single misclick.
 *  - NO EDIT: the contract ships NO editCompetitor action, so there is no edit
 *    affordance. To correct a competitor, remove it and add it again (both landed).
 *  - CAP: the app-enforced per-client cap (COMPETITORS_PER_CLIENT_CAP) is shown
 *    live ("N of 10"); the Add affordance is withheld at the cap, and if a
 *    concurrent add crosses it the action's own refusal renders verbatim.
 *  - WRITER FLOOR: writes admit any writer (RLS `app.is_writer()`); a client_viewer
 *    sees the list read-only, with no controls (the server action would refuse
 *    anyway — this just doesn't offer what it can't do).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, UsersRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addCompetitor,
  removeCompetitor,
  type CompetitorSummary,
} from "@/lib/competitors/actions";
import {
  COMPETITORS_PER_CLIENT_CAP,
  validateCompetitorInput,
} from "@/lib/competitors/validate";
import { EmptyState, StatusPill } from "../../../../../_components/surface";
import {
  NEGATIVE_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
} from "../../../../../_components/tone";

/**
 * Honest fallback when the action call itself fails to round-trip. Neither seam
 * carries an idempotency key, so a lost response may or may not have landed; the
 * recovery instruction is REAL — the catch path calls router.refresh(), the
 * page's server read re-runs, and the compare-before-set sync re-seeds the list.
 */
const SEAM_UNREACHABLE =
  "We couldn’t confirm that. We’ve refreshed the list below — check it before trying again.";

/* ------------------------------------------------------------------ */
/* Add form (client-side mirror of the landed validator's grammar)     */
/* ------------------------------------------------------------------ */

function CompetitorForm({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  /** The seam's interface-voice error (or the unreachable fallback), verbatim. */
  error: string | null;
  onSubmit: (name: string, domain: string | undefined) => void;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");

  const trimmedName = name.trim();
  const trimmedDomain = domain.trim();

  // Field refusals are the LANDED validator's own messages — extracted, never
  // hardcoded. Name is checked with an empty domain (so any refusal is the name's);
  // domain with a guaranteed-valid placeholder name (so any refusal is the domain's).
  // Each is surfaced only once its field has content, so a pristine form is quiet.
  const nameCheck = validateCompetitorInput({ name, domain: "" });
  const nameProblem = trimmedName !== "" && !nameCheck.ok ? nameCheck.error : null;
  const domainCheck = validateCompetitorInput({ name: "placeholder", domain });
  const domainProblem =
    trimmedDomain !== "" && !domainCheck.ok ? domainCheck.error : null;

  const canSubmit =
    trimmedName !== "" &&
    nameProblem === null &&
    domainProblem === null &&
    !busy;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="competitor-name" className="text-muted">
            Name
          </Label>
          <Input
            id="competitor-name"
            autoFocus
            value={name}
            placeholder="Competitor name"
            disabled={busy}
            // 200, not the 120 cap — deliberate headroom so an over-long paste
            // renders the validator's verbatim too-long refusal instead of
            // being silently truncated at the boundary.
            maxLength={200}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={nameProblem ? "competitor-name-problem" : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameProblem ? (
            <p
              id="competitor-name-problem"
              role="alert"
              className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}
            >
              {nameProblem}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="competitor-domain" className="text-muted">
            Domain <span className="text-muted/70">(optional)</span>
          </Label>
          <Input
            id="competitor-domain"
            inputMode="url"
            value={domain}
            placeholder="competitor.com"
            disabled={busy}
            aria-invalid={domainProblem ? true : undefined}
            aria-describedby={
              domainProblem ? "competitor-domain-problem" : undefined
            }
            onChange={(event) => setDomain(event.target.value)}
          />
          {domainProblem ? (
            <p
              id="competitor-domain-problem"
              role="alert"
              className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}
            >
              {domainProblem}
            </p>
          ) : null}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted">
        A domain lets share of voice match this competitor in AI answers. Name
        only is fine — it just can’t be matched until a domain is added.
      </p>

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
          onClick={() =>
            onSubmit(trimmedName, trimmedDomain === "" ? undefined : trimmedDomain)
          }
        >
          {busy ? "Saving…" : "Save competitor"}
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

type Mode = { kind: "idle" } | { kind: "add" };
/** Where focus returns when a transient control unmounts (managed focus). */
type FocusWant = { target: "add" } | { target: "remove"; id: string };

export function CompetitorsPanel({
  clientId,
  initial,
  canManage,
  hasRun,
}: {
  clientId: string;
  initial: CompetitorSummary[];
  /** True for agency staff (the is_writer floor); a client_viewer gets a read-only list. */
  canManage: boolean;
  /**
   * True when a stored tracker run exists. SOV recomputes against the latest
   * STORED run at read time, so post-run a change here shows on the next
   * render — the footer states whichever truth applies (never "waiting on
   * tracking" once a run has landed).
   */
  hasRun: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<CompetitorSummary[]>(initial);
  const [mode, setMode] = React.useState<Mode>({ kind: "idle" });
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // COMPARE-BEFORE-SET prop sync (the house pattern): a fresh RLS-scoped read —
  // router.refresh() after an unconfirmed write is the trigger — supersedes local
  // state, so the "check the list below" instruction inspects server truth.
  const [seededFrom, setSeededFrom] = React.useState(initial);
  if (seededFrom !== initial) {
    setSeededFrom(initial);
    setRows(initial);
  }

  const atCap = rows.length >= COMPETITORS_PER_CLIENT_CAP;

  // MANAGED FOCUS: a control that unmounts (the form on cancel/save, a row's
  // Remove button after a confirm) hands focus to a stable target instead of
  // dropping to <body>. The handler arms the ref; the effect reads-and-clears it
  // after the target has re-rendered.
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const removeButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const wantFocusRef = React.useRef<FocusWant | null>(null);
  React.useEffect(() => {
    const want = wantFocusRef.current;
    if (!want) return;
    wantFocusRef.current = null;
    if (want.target === "add") {
      addButtonRef.current?.focus();
    } else {
      removeButtonRefs.current.get(want.id)?.focus();
    }
  }, [mode, confirmingId, rows]);

  const openAdd = () => {
    setMode({ kind: "add" });
    setConfirmingId(null);
    setFormError(null);
    setRowError(null);
    setNotice(null);
  };
  const closeAdd = () => {
    wantFocusRef.current = { target: "add" };
    setMode({ kind: "idle" });
    setFormError(null);
  };

  const submitAdd = async (name: string, domain: string | undefined) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await addCompetitor({ clientId, name, domain });
      if (result.ok) {
        // Server truth: the action's returned row (canonical name + bare domain).
        setRows((prev) => [...prev, result.competitor]);
        // Focus returns to the Add button — unless this add HIT the cap, which
        // withholds that button; then hand focus to the new row's Remove control
        // instead of dropping to <body>.
        wantFocusRef.current =
          rows.length + 1 >= COMPETITORS_PER_CLIENT_CAP
            ? { target: "remove", id: result.competitor.id }
            : { target: "add" };
        setMode({ kind: "idle" });
        setNotice("Competitor added.");
      } else {
        // Every refusal (invalid_input / cap_reached / duplicate / forbidden /
        // not_found / write_failed) is already interface-voice — rendered verbatim.
        setFormError(result.error);
      }
    } catch {
      router.refresh();
      setFormError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const askRemove = (id: string) => {
    setConfirmingId(id);
    setRowError(null);
    setNotice(null);
  };
  const cancelRemove = (id: string) => {
    wantFocusRef.current = { target: "remove", id };
    setConfirmingId(null);
  };
  const confirmRemove = async (competitor: CompetitorSummary) => {
    setBusy(true);
    setRowError(null);
    setNotice(null);
    try {
      const result = await removeCompetitor({ competitorId: competitor.id });
      if (result.ok) {
        setRows((prev) => prev.filter((row) => row.id !== competitor.id));
        wantFocusRef.current = { target: "add" };
        setConfirmingId(null);
        setNotice(`Removed ${competitor.name}.`);
      } else {
        if (result.reason === "not_found") {
          // Ghost row: it was already removed elsewhere. Same standard as the
          // catch path — refresh the server read so the stale row clears, arm
          // the return-focus target first (the confirm controls are about to
          // unmount), and drop the confirm so no stale id pins the other
          // Remove buttons disabled.
          wantFocusRef.current = { target: "add" };
          setConfirmingId(null);
          router.refresh();
        }
        setRowError(result.error);
      }
    } catch {
      // Arm the return-focus target BEFORE the refresh: if the write actually
      // landed, the re-seed unmounts this row's confirm controls — focus lands
      // on Add instead of stranding on <body>. Clearing the confirm keeps the
      // list operable either way (no stale id disabling the other rows).
      wantFocusRef.current = { target: "add" };
      setConfirmingId(null);
      router.refresh();
      setRowError(SEAM_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const showEmpty = rows.length === 0 && mode.kind !== "add";

  return (
    <div className="flex flex-col gap-4">
      {showEmpty ? (
        canManage ? (
          <EmptyState
            icon={UsersRoundIcon}
            title="No competitors tracked yet"
            description="Add the rivals you want share of voice measured against. Each needs a name; a domain lets us match them in AI answers."
            action={
              <Button
                ref={addButtonRef}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={openAdd}
              >
                <PlusIcon aria-hidden /> Add a competitor
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={UsersRoundIcon}
            title="No competitors tracked yet"
            description="Your agency sets the competitors this client’s share of voice is measured against."
          />
        )
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const confirming = confirmingId === row.id;
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-ink">
                    {row.name}
                  </span>
                  {row.domain ? (
                    <span className="truncate font-mono text-xs text-muted">
                      {row.domain}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">
                      {/* The correction path is remove + re-add (no edit action
                          exists) — but only name it to callers who hold the
                          controls; a viewer gets the plain fact. */}
                      {canManage
                        ? "No domain — remove and re-add with one to enable matching"
                        : "No domain — can’t be matched in AI answers yet"}
                    </span>
                  )}
                </div>

                {canManage ? (
                  confirming ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">Remove?</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        aria-label={`Confirm removing ${row.name}`}
                        onClick={() => confirmRemove(row)}
                      >
                        {busy ? "Removing…" : "Confirm"}
                      </Button>
                      {/* Focus lands on CANCEL, never the destructive control:
                          a held Enter (key-repeat) from the Remove click must
                          not be able to complete a permanent delete. Confirm
                          stays one deliberate Tab/click away. */}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        autoFocus
                        disabled={busy}
                        aria-label={`Cancel removing ${row.name}`}
                        onClick={() => cancelRemove(row.id)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      ref={(el: HTMLButtonElement | null) => {
                        if (el) removeButtonRefs.current.set(row.id, el);
                        else removeButtonRefs.current.delete(row.id);
                      }}
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || confirmingId !== null || mode.kind === "add"}
                      aria-label={`Remove ${row.name}`}
                      onClick={() => askRemove(row.id)}
                    >
                      Remove
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rowError ? (
        <p role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
          {rowError}
        </p>
      ) : null}

      {canManage && mode.kind === "add" ? (
        <CompetitorForm
          busy={busy}
          error={formError}
          onSubmit={submitAdd}
          onCancel={closeAdd}
        />
      ) : null}

      {canManage && mode.kind !== "add" && rows.length > 0 ? (
        atCap ? (
          <p className="text-xs leading-5 text-muted">
            Tracking the maximum of {COMPETITORS_PER_CLIENT_CAP} competitors.
            Remove one to add another.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              ref={addButtonRef}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || confirmingId !== null}
              onClick={openAdd}
            >
              <PlusIcon aria-hidden /> Add a competitor
            </Button>
            <span className="font-mono text-[11px] tracking-wide text-muted uppercase">
              {rows.length} of {COMPETITORS_PER_CLIENT_CAP}
            </span>
          </div>
        )
      ) : null}

      {notice ? (
        <p role="status" className={`text-sm ${POSITIVE_TEXT_CLASS}`}>
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {hasRun ? (
          // Post-run truth: SOV recomputes against the latest stored run at
          // read time, so a competitor change re-attributes without a new run.
          <p className="text-xs leading-5 text-muted">
            Matched against the latest tracking run — changes here re-attribute
            on refresh.
          </p>
        ) : (
          <>
            <StatusPill tone="warm">Waiting on tracking</StatusPill>
            <p className="text-xs leading-5 text-muted">
              Share of voice compares these once tracking runs — competitors
              added now simply wait for the next run.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
