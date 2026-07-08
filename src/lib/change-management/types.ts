/**
 * Unified change-management layer — shared types (Phase 1.2, doc 04 §2).
 *
 * The five pipeline stages, typed end-to-end:
 *
 *   GENERATE → `DesiredChange` (the input seam for audit/content/schema
 *              modules — they produce desired changes, never write anything)
 *   PREVIEW  → `ChangePreview` / `BatchPreview` (persisted `site_changes`
 *              row(s) with status 'previewed' + a structured before/after
 *              diff; nothing writes without a persisted preview)
 *   APPLY    → `ApplyOutcome` (through a WriteMethodAdapter ONLY; records
 *              approved_by / applied_by / applied_at per the F1 contract)
 *   MONITOR  → `MonitoringSignal` ingestion seam + the auto-rollback
 *              evaluator (`MonitorEvaluation`), per-client configurable
 *              (`AutoRollbackPolicy`)
 *   ROLLBACK → `RollbackOutcome` (one-click revert via the SAME adapter that
 *              applied; auto-rollback records `reverted_reason`)
 *
 * Value sets are imported from the F1 data-model mirror (`src/lib/types/db.ts`)
 * — never re-listed here. `automation_level` is `SiteChangeAutomationLevel`,
 * so 'auto' (a fully autonomous on-page publish) is unrepresentable at the
 * type level, exactly as the schema CHECK makes it unrepresentable in the DB.
 */

import type {
  Json,
  SiteChangeAutomationLevel,
  SiteChangeDiff,
  SiteChangeMethod,
  SiteChangeRow,
  SiteChangeStatus,
  SiteChangeType,
  TenantUserRole,
} from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Tenancy context + actor                                             */
/* ------------------------------------------------------------------ */

/**
 * The acting user for an operation. `id` is a `tenant_users.id` (the audit
 * trail — recorded to `applied_by` / `approved_by`, never reused). `role`
 * gates writes: only `operator` / `agency_admin` may write; `client_viewer`
 * is refused at the seam (doc 04 §5), in addition to the DB's RLS backstop.
 */
export interface Actor {
  id: string;
  role: TenantUserRole;
}

/**
 * Every pipeline operation is tenant-scoped (doc 04 §5). The store is handed
 * this on every call; a store backed by the real database is additionally
 * RLS-scoped, so app code is never trusted alone. The `actor` is the single
 * source of "who is doing this" — threaded through, never mixed across tenants.
 */
export interface TenantContext {
  tenantId: string;
  actor: Actor;
}

/* ------------------------------------------------------------------ */
/* GENERATE — the desired-change input seam                            */
/* ------------------------------------------------------------------ */

/**
 * Where on the property the change lands. `url` is the page; `locator` is a
 * method-specific handle (a selector, a CMS field id, an image src for alt
 * text, ...). Adapters interpret it; the pipeline treats it opaquely.
 */
export interface ChangeTarget {
  url: string;
  locator?: string;
}

/**
 * A change some module WANTS made — the GENERATE seam (doc 04 §2 step 1).
 * Producing one of these has zero side effects; only the pipeline can turn
 * it into a preview, and only an approved preview can ever be applied.
 */
export interface DesiredChange {
  tenantId: string;
  clientId: string;
  propertyId: string;
  method: SiteChangeMethod;
  changeType: SiteChangeType;
  /**
   * 'ai_draft_human_approve' | 'human_only' only — `auto` is not a member of
   * this type, mirroring CHECK `site_changes_automation_level_allowed`
   * (contract §6). Defaults to 'ai_draft_human_approve' when omitted.
   */
  automationLevel?: SiteChangeAutomationLevel;
  target: ChangeTarget;
  /** Current live value (from crawl/audit). `null` = absent today. */
  before: Json;
  /** Desired value. */
  after: Json;
  /** Optional provenance label (e.g. "audit:fix-42", "schema:FAQPage"). */
  source?: string;
}

/* ------------------------------------------------------------------ */
/* PREVIEW — structured diffs                                          */
/* ------------------------------------------------------------------ */

/** One contiguous run of diff lines. */
export interface DiffHunk {
  kind: "unchanged" | "removed" | "added";
  lines: string[];
}

/**
 * The reviewable before/after diff a human approves (doc 04 §2 step 2).
 * Derived deterministically from the persisted row — recomputable at any
 * time, so only the contract-shaped `{before, after}` payload is stored.
 */
export interface StructuredDiff {
  changeType: SiteChangeType;
  target: ChangeTarget;
  before: Json;
  after: Json;
  hunks: DiffHunk[];
  summary: {
    linesAdded: number;
    linesRemoved: number;
    /** True when before and after are identical (a no-op / test change). */
    identical: boolean;
    /** One human-readable sentence, e.g. `title @ /pricing: 1 line changed`. */
    label: string;
  };
}

/**
 * Persisted `site_changes.diff` payload. The contract shape is
 * `{before, after}` (docs/contracts/data-model.md §7); this layer includes
 * the page target alongside so a one-click rollback is executable from the
 * audit row alone (doc 04 §2 hard requirement: every write reversible by
 * exactly one action). The extra key is additive — anything reading
 * `{before, after}` is unaffected — and is FLAGGED for contract ratification
 * (see the 1.2 gate notes); the CHECK only requires a jsonb object.
 */
export interface PersistedChangeDiff extends SiteChangeDiff {
  target?: ChangeTarget;
}

/** PREVIEW output for a single change: the persisted row + its diff. */
export interface ChangePreview {
  change: SiteChangeRow;
  diff: StructuredDiff;
}

/**
 * PREVIEW output for a bulk change (doc 04 §2: bulk = highest risk). The
 * batch is reviewed as ONE batch diff and approved with ONE explicit human
 * action before ANY member applies.
 */
export interface BatchPreview {
  batchId: string;
  tenantId: string;
  clientId: string;
  members: ChangePreview[];
  summary: {
    memberCount: number;
    byChangeType: Partial<Record<SiteChangeType, number>>;
    label: string;
  };
}

/* ------------------------------------------------------------------ */
/* APPLY / ROLLBACK outcomes                                           */
/* ------------------------------------------------------------------ */

export interface ApplyOptions {
  /**
   * `tenant_users.id` of the approving human. REQUIRED before the adapter is
   * even attempted (typed `ApprovalRequiredError`); the schema CHECK
   * `site_changes_requires_approval` is the structural backstop.
   */
  approvedBy: string;
  /** `tenant_users.id` of the applying actor (may equal approvedBy). */
  appliedBy?: string;
}

/** Non-fatal observations surfaced to the caller (never swallowed). */
export interface PipelineWarning {
  code: "drift_detected" | "alert_emit_failed";
  message: string;
}

export interface ApplyOutcome {
  change: SiteChangeRow;
  warnings: PipelineWarning[];
}

/**
 * Bulk apply report (doc 04 §2: bulk partial-apply handling — a member
 * failure STOPS the batch and is reported; already-applied members remain
 * individually revertible).
 */
export interface BatchApplyReport {
  batchId: string;
  /** Members applied during THIS call, in order. */
  applied: ApplyOutcome[];
  /** Members already applied by an earlier (partially failed) call. */
  previouslyApplied: string[];
  /** The member that failed, if any — the batch stopped here. */
  failed?: { changeId: string; error: Error };
  /** Members never attempted because an earlier member failed. */
  notAttempted: string[];
  /** True iff every member of the batch is now applied. */
  complete: boolean;
  warnings: PipelineWarning[];
}

export interface RollbackOptions {
  /**
   * Why this change is being reverted — recorded to
   * `site_changes.reverted_reason`. Required by this layer for BOTH manual
   * and auto rollback (the audit trail explains itself).
   */
  reason: string;
}

export interface RollbackOutcome {
  change: SiteChangeRow;
  warnings: PipelineWarning[];
}

/* ------------------------------------------------------------------ */
/* MONITOR — signal ingestion + auto-rollback policy                   */
/* ------------------------------------------------------------------ */

export const MONITORED_METRICS = ["traffic", "ranking", "visibility"] as const;
export type MonitoredMetric = (typeof MONITORED_METRICS)[number];

/**
 * One post-apply observation for a change, normalized so the evaluator is
 * source-agnostic: `deltaPct` is the percentage movement where NEGATIVE is
 * WORSE (traffic down, ranking positions lost, visibility citations lost).
 * Producers (M16 metrics, M3 tracker, M17 alerting) normalize before
 * ingesting — this is the MONITOR seam, not a metrics store.
 */
export interface MonitoringSignal {
  metric: MonitoredMetric;
  /** Percentage delta since the change applied; negative = regression. */
  deltaPct: number;
  /** Observation window in days, if known. */
  windowDays?: number;
  /** ISO timestamp of the observation. */
  observedAt: string;
  /** Free-form source detail (e.g. "gsc:clicks", "tracker:chatgpt"). */
  detail?: string;
}

/**
 * Per-client auto-rollback configuration (doc 04 §2: thresholds are
 * configurable per client).
 *
 * - `off`:     signals are recorded, never evaluated.
 * - `flag`:    breaches are surfaced for a human to one-click revert
 *              (conservative default).
 * - `execute`: breaches trigger the auto-revert themselves
 *              (status 'auto_reverted', reason recorded, alert emitted).
 *
 * Thresholds are positive drop percentages: a signal breaches when
 * `deltaPct <= -threshold` for its metric. Metrics without a threshold are
 * never evaluated.
 */
export interface AutoRollbackPolicy {
  mode: "off" | "flag" | "execute";
  thresholds: Partial<Record<MonitoredMetric, number>>;
}

/**
 * Resolves the policy for a client — the per-client override seam. Backed by
 * client settings when those land; defaults apply until then.
 */
export type AutoRollbackPolicyResolver = (scope: {
  tenantId: string;
  clientId: string;
}) => AutoRollbackPolicy | Promise<AutoRollbackPolicy>;

/**
 * Launch defaults (BUILD-STATE ⚑: per-client tuning is the Phase 1.2 knob).
 * `flag` mode by default — executing reverts autonomously is per-client
 * OPT-IN, matching the platform's "AI drafts, humans approve" posture.
 */
export const DEFAULT_AUTO_ROLLBACK_POLICY: AutoRollbackPolicy = {
  mode: "flag",
  thresholds: { traffic: 25, ranking: 30, visibility: 30 },
};

/** One threshold breach found by the evaluator. */
export interface ThresholdBreach {
  metric: MonitoredMetric;
  deltaPct: number;
  threshold: number;
  signal: MonitoringSignal;
}

/** What the MONITOR stage decided for one ingested signal set. */
export interface MonitorEvaluation {
  changeId: string;
  /** Status of the row at evaluation time. */
  status: SiteChangeStatus;
  policy: AutoRollbackPolicy;
  breaches: ThresholdBreach[];
  /**
   * - `none`               — no breach, or row not in 'applied', or mode off
   * - `flagged`            — breach found; human revert recommended
   * - `auto_reverted`      — breach found; revert EXECUTED by this call
   * - `auto_revert_failed` — execute-mode revert attempted and failed
   *                          (row stays 'applied' and retryable; alert emitted)
   */
  action: "none" | "flagged" | "auto_reverted" | "auto_revert_failed";
  /** Updated row when action === 'auto_reverted'. */
  change?: SiteChangeRow;
  /** The adapter error when action === 'auto_revert_failed'. */
  error?: Error;
  warnings: PipelineWarning[];
}

/* ------------------------------------------------------------------ */
/* Alerting seam (M17 consumes; doc 04 §2: alerting surfaces the event)*/
/* ------------------------------------------------------------------ */

/** Draft alert matching the `alerts` table contract (type/severity/payload). */
export interface AlertDraft {
  tenantId: string;
  clientId: string;
  type: "auto_rollback_fired";
  severity: "warning" | "critical";
  payload: Json;
}

/** Where pipeline alerts go. M17 supplies the real sink at 1.8. */
export interface AlertSink {
  emit(alert: AlertDraft): void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Connection verification (doc 04 §4 onboarding no-op check)          */
/* ------------------------------------------------------------------ */

export interface ConnectionVerification {
  method: SiteChangeMethod;
  ok: boolean;
  detail?: string;
}
