/**
 * ChangeManager — the unified change-management pipeline (doc 04 §2).
 *
 * ONE safety pipeline wraps ALL write methods identically:
 *
 *   PREVIEW  → persist a `previewed` site_changes row + a reviewable diff
 *   APPLY    → (human-approved) write via the method adapter; row → 'applied'
 *   MONITOR  → evaluate regression signals against the client's policy
 *   ROLLBACK → one-click manual revert; or AUTO-revert on a threshold breach
 *
 * The whole class is pure ORCHESTRATION over injected ports — the real site
 * write (WriteMethodAdapter) and the real DB (ChangeStore) are supplied by 1.3
 * and by Supabase respectively, so this core never changes when a method ships.
 *
 * Enforced invariants (doc 04 §2 hard requirements):
 *  - No silent write: a `previewed` row is persisted BEFORE any site write, and
 *    `apply` only accepts a change id — which only `preview`/`previewBatch`
 *    mint. There is no path to the adapter that skips the store.
 *  - Reversible by exactly one action: `rollback(id, ...)` reverts via the SAME
 *    adapter that applied (matched on `row.method`), restoring the before-state
 *    captured at apply time.
 *  - automation_level 'auto' is rejected at the seam (never clamped here).
 *  - Bulk requires an explicit human approver AND a batch preview; it never
 *    fires unattended.
 *  - Every status change goes through the state machine → only DB-legal rows.
 *  - Tenant context is threaded, asserted, and never mixed.
 */

import type { Json, SiteChangeRow } from "@/lib/types/db";
import {
  assertRowInScope,
  assertTenantMatch,
  assertWriter,
  resolveWriteAutomationLevel,
} from "./automation";
import {
  autoRollbackReason,
  describeBreach,
  evaluateBreaches,
} from "./auto-rollback";
import { buildStructuredDiff } from "./diff";
import {
  ApprovalRequiredError,
  ChangeNotFoundError,
  ConstraintViolationError,
  MethodNotRegisteredError,
} from "./errors";
import { jsonEqual } from "./json";
import type {
  AdapterContext,
  AdapterRegistry,
  ChangeStore,
  Clock,
  NewPreviewedChange,
  WriteMethodAdapter,
} from "./ports";
import { assertLegalTransition } from "./status-machine";
import type {
  ApplyOptions,
  ApplyOutcome,
  AutoRollbackPolicyResolver,
  BatchApplyReport,
  BatchPreview,
  ChangePreview,
  ChangeTarget,
  ConnectionVerification,
  DesiredChange,
  MonitorEvaluation,
  MonitoringSignal,
  PersistedChangeDiff,
  PipelineWarning,
  RollbackOptions,
  RollbackOutcome,
  StructuredDiff,
  TenantContext,
} from "./types";
import { DEFAULT_AUTO_ROLLBACK_POLICY } from "./types";
import type { AlertSink } from "./types";

export interface ChangeManagerDeps {
  store: ChangeStore;
  adapters: AdapterRegistry;
  clock: Clock;
  /** Resolves each client's auto-rollback policy. Defaults to flag-mode launch policy. */
  policyResolver?: AutoRollbackPolicyResolver;
  /** M17 Alerting hook; auto-rollback fires an alert here when wired. */
  alertSink?: AlertSink;
}

/** A no-op onboarding request (doc 04 §4): read access, no write. */
export interface ConnectionCheck {
  clientId: string;
  propertyId: string;
  method: SiteChangeRow["method"];
  target: ChangeTarget;
}

const defaultPolicyResolver: AutoRollbackPolicyResolver = () =>
  DEFAULT_AUTO_ROLLBACK_POLICY;

export class ChangeManager {
  private readonly store: ChangeStore;
  private readonly adapters: AdapterRegistry;
  private readonly clock: Clock;
  private readonly resolvePolicy: AutoRollbackPolicyResolver;
  private readonly alertSink?: AlertSink;

  constructor(deps: ChangeManagerDeps) {
    this.store = deps.store;
    this.adapters = deps.adapters;
    this.clock = deps.clock;
    this.resolvePolicy = deps.policyResolver ?? defaultPolicyResolver;
    this.alertSink = deps.alertSink;
  }

  /* ---------------------------------------------------------------- */
  /* PREVIEW                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Turn a DesiredChange into a persisted `previewed` row + reviewable diff.
   * No site write happens; the before-state comes from the change (crawl/audit
   * value). For `ai_draft_human_approve` this is the diff a human approves next.
   */
  async preview(
    desired: DesiredChange,
    ctx: TenantContext,
  ): Promise<ChangePreview> {
    assertWriter(ctx.actor, "preview");
    assertTenantMatch(desired.tenantId, ctx, "preview");
    const input = this.toPreviewInput(desired);
    const structured = this.diffOf(desired);
    const change = await this.store.insertPreviewed(input, ctx);
    return { change, diff: structured };
  }

  /* ---------------------------------------------------------------- */
  /* APPLY                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Apply a previously-previewed change. Requires `options.approvedBy` (a human
   * approver) — no write occurs without it. Captures the FRESH live before-state
   * (authoritative rollback baseline), writes `after` via the method adapter,
   * then records the row as 'applied'. A drift between the previewed and live
   * before-state is surfaced as a non-fatal warning.
   */
  async apply(
    changeId: string,
    options: ApplyOptions,
    ctx: TenantContext,
  ): Promise<ApplyOutcome> {
    assertWriter(ctx.actor, "apply");
    const row = await this.load(changeId, ctx, "apply");
    // Defense-in-depth: never apply a row whose level is (somehow) not a legal
    // site-write level — 'auto' is rejected here even if it reached the store.
    resolveWriteAutomationLevel(row.automation_level);
    // Only a previewed change may be applied (also blocks double-apply).
    assertLegalTransition(row.status, "applied");

    const approvedBy = options.approvedBy;
    if (!approvedBy) {
      throw new ApprovalRequiredError(
        `apply ${changeId}: a human approver (approvedBy) is required before any write`,
      );
    }

    const adapter = this.adapterFor(row.method);
    const target = this.targetOf(row);
    const adapterCtx = this.adapterCtx(row);
    const previewedBefore = this.persistedDiff(row).before;
    const after = this.persistedDiff(row).after;

    const warnings: PipelineWarning[] = [];
    // Re-read the live before-state at write time; it, not the (possibly stale)
    // preview value, is the authoritative baseline a rollback restores.
    const liveBefore = await adapter.readCurrent(target, adapterCtx);
    if (!jsonEqual(liveBefore, previewedBefore)) {
      warnings.push({
        code: "drift_detected",
        message: `live before-state changed since preview at ${target.url} — applying the approved 'after' and re-baselining rollback to the live state`,
      });
    }

    await adapter.apply({ target, before: liveBefore, after, ctx: adapterCtx });

    const change = await this.store.update(
      changeId,
      {
        status: "applied",
        approvedBy,
        appliedBy: options.appliedBy ?? ctx.actor.id,
        appliedAt: this.clock.now(),
        // Persist the fresh before as the authoritative rollback baseline.
        diff: { before: liveBefore, after, target },
      },
      ctx,
    );
    return { change, warnings };
  }

  /* ---------------------------------------------------------------- */
  /* ROLLBACK (manual, one-click)                                     */
  /* ---------------------------------------------------------------- */

  /**
   * One-click manual revert of an applied change. Restores the captured
   * before-state via the SAME adapter that applied it; row → 'reverted' with a
   * recorded reason. This is the single action that reverses a change.
   */
  async rollback(
    changeId: string,
    options: RollbackOptions,
    ctx: TenantContext,
  ): Promise<RollbackOutcome> {
    assertWriter(ctx.actor, "rollback");
    const row = await this.load(changeId, ctx, "rollback");
    assertLegalTransition(row.status, "reverted");

    await this.revertOnSite(row);
    const change = await this.store.update(
      changeId,
      {
        status: "reverted",
        revertedAt: this.clock.now(),
        revertedReason: options.reason,
      },
      ctx,
    );
    return { change, warnings: [] };
  }

  /* ---------------------------------------------------------------- */
  /* BULK — previewBatch / applyBatch                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Preview a bulk edit as ONE batch diff (doc 04 §2: bulk = highest risk).
   * All members are persisted `previewed`; nothing applies until an explicit
   * `applyBatch` with a human approver. A batch targets a single client.
   */
  async previewBatch(
    desired: readonly DesiredChange[],
    ctx: TenantContext,
  ): Promise<BatchPreview> {
    assertWriter(ctx.actor, "preview");
    const clientIds = new Set(desired.map((d) => d.clientId));
    if (clientIds.size > 1) {
      throw new ConstraintViolationError(
        "a bulk batch must target a single client",
      );
    }
    const inputs: NewPreviewedChange[] = [];
    const diffs: StructuredDiff[] = [];
    for (const d of desired) {
      assertTenantMatch(d.tenantId, ctx, "previewBatch");
      inputs.push(this.toPreviewInput(d));
      diffs.push(this.diffOf(d));
    }
    const rows = await this.store.insertPreviewedBatch(inputs, ctx);
    const members: ChangePreview[] = rows.map((change, i) => ({
      change,
      diff: diffs[i],
    }));

    const byChangeType: Partial<Record<SiteChangeRow["change_type"], number>> =
      {};
    for (const m of members) {
      const t = m.change.change_type;
      byChangeType[t] = (byChangeType[t] ?? 0) + 1;
    }

    return {
      batchId: `batch:${rows.map((r) => r.id).join("|")}`,
      tenantId: ctx.tenantId,
      clientId: desired[0]?.clientId ?? "",
      members,
      summary: {
        memberCount: members.length,
        byChangeType,
        label: `bulk edit: ${members.length} change${members.length === 1 ? "" : "s"} across ${Object.keys(byChangeType).length} type${Object.keys(byChangeType).length === 1 ? "" : "s"}`,
      },
    };
  }

  /**
   * Apply a previewed batch. Requires a human approver (`options.approvedBy`) —
   * the explicit batch approval. Applies members in order and STOPS at the
   * first failure; members applied before the failure remain individually
   * revertible, and members already applied by an earlier partial run are
   * reported, not re-applied.
   */
  async applyBatch(
    batch: BatchPreview,
    options: ApplyOptions,
    ctx: TenantContext,
  ): Promise<BatchApplyReport> {
    assertWriter(ctx.actor, "apply");
    if (!options.approvedBy) {
      throw new ApprovalRequiredError(
        `applyBatch ${batch.batchId}: a human approver (approvedBy) is required — bulk changes never fire unattended`,
      );
    }

    const applied: ApplyOutcome[] = [];
    const previouslyApplied: string[] = [];
    const warnings: PipelineWarning[] = [];
    let failed: BatchApplyReport["failed"];
    const notAttempted: string[] = [];

    const ids = batch.members.map((m) => m.change.id);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (failed) {
        notAttempted.push(id);
        continue;
      }
      const current = await this.store.getById(id, ctx);
      if (current && current.status === "applied") {
        previouslyApplied.push(id);
        continue;
      }
      try {
        const outcome = await this.apply(id, options, ctx);
        applied.push(outcome);
        warnings.push(...outcome.warnings);
      } catch (err) {
        failed = { changeId: id, error: asError(err) };
      }
    }

    const complete =
      failed === undefined &&
      applied.length + previouslyApplied.length === ids.length;
    return {
      batchId: batch.batchId,
      applied,
      previouslyApplied,
      failed,
      notAttempted,
      complete,
      warnings,
    };
  }

  /* ---------------------------------------------------------------- */
  /* MONITOR + AUTO-ROLLBACK                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Evaluate regression signals for an applied change against the client's
   * per-client auto-rollback policy. In `flag` mode a breach is reported for a
   * human to one-click revert; in `execute` mode the revert fires here
   * (status → 'auto_reverted', reason recorded, alert emitted). `off` mode and
   * non-applied rows evaluate to no action.
   */
  async monitor(
    changeId: string,
    signals: readonly MonitoringSignal[],
    ctx: TenantContext,
  ): Promise<MonitorEvaluation> {
    assertWriter(ctx.actor, "monitor");
    const row = await this.load(changeId, ctx, "monitor");
    const policy = await Promise.resolve(
      this.resolvePolicy({ tenantId: row.tenant_id, clientId: row.client_id }),
    );

    // Only a live (applied) change is monitored; policy 'off' records-only.
    if (row.status !== "applied" || policy.mode === "off") {
      return {
        changeId,
        status: row.status,
        policy,
        breaches: [],
        action: "none",
        warnings: [],
      };
    }

    const breaches = evaluateBreaches(signals, policy);
    if (breaches.length === 0) {
      return {
        changeId,
        status: row.status,
        policy,
        breaches,
        action: "none",
        warnings: [],
      };
    }

    if (policy.mode === "flag") {
      // Surface for a human to one-click revert (doc 04 §2 conservative default).
      return {
        changeId,
        status: row.status,
        policy,
        breaches,
        action: "flagged",
        warnings: [],
      };
    }

    // policy.mode === "execute": fire the auto-rollback.
    const warnings: PipelineWarning[] = [];
    try {
      await this.revertOnSite(row);
      const change = await this.store.update(
        changeId,
        {
          status: "auto_reverted",
          revertedAt: this.clock.now(),
          revertedReason: autoRollbackReason(breaches),
        },
        ctx,
      );
      await this.emitAutoRollbackAlert(change, breaches, warnings);
      return {
        changeId,
        status: change.status,
        policy,
        breaches,
        action: "auto_reverted",
        change,
        warnings,
      };
    } catch (err) {
      // Auto-revert failed — the row stays 'applied' and retryable; never crash
      // the monitoring loop. The failure is reported for the caller/alerting.
      return {
        changeId,
        status: row.status,
        policy,
        breaches,
        action: "auto_revert_failed",
        error: asError(err),
        warnings,
      };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Connection verification (doc 04 §4 no-op test)                   */
  /* ---------------------------------------------------------------- */

  /**
   * Verify write access to a property WITHOUT applying anything — the §4
   * onboarding "no-op test change (previewed, not applied)". Reads current
   * state via the adapter; success proves the method can reach the property.
   */
  async verifyConnection(
    check: ConnectionCheck,
    ctx: TenantContext,
  ): Promise<ConnectionVerification> {
    assertWriter(ctx.actor, "verify");
    try {
      const adapter = this.adapterFor(check.method);
      await adapter.readCurrent(check.target, {
        tenantId: ctx.tenantId,
        clientId: check.clientId,
        propertyId: check.propertyId,
      });
      return { method: check.method, ok: true, detail: "read access verified" };
    } catch (err) {
      return { method: check.method, ok: false, detail: asError(err).message };
    }
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                        */
  /* ---------------------------------------------------------------- */

  private toPreviewInput(desired: DesiredChange): NewPreviewedChange {
    const automationLevel = resolveWriteAutomationLevel(desired.automationLevel);
    const diff: PersistedChangeDiff = {
      before: desired.before,
      after: desired.after,
      target: desired.target,
    };
    return {
      clientId: desired.clientId,
      propertyId: desired.propertyId,
      method: desired.method,
      changeType: desired.changeType,
      automationLevel,
      diff,
    };
  }

  private diffOf(desired: DesiredChange): StructuredDiff {
    return buildStructuredDiff(
      desired.changeType,
      desired.target,
      desired.before,
      desired.after,
    );
  }

  private async load(
    changeId: string,
    ctx: TenantContext,
    operation: string,
  ): Promise<SiteChangeRow> {
    const row = await this.store.getById(changeId, ctx);
    if (!row) {
      throw new ChangeNotFoundError(
        `${operation}: change ${changeId} not found in tenant scope`,
      );
    }
    assertRowInScope(row, ctx, operation);
    return row;
  }

  /** Revert a change on the live site via the SAME adapter that applied it. */
  private async revertOnSite(row: SiteChangeRow): Promise<void> {
    const adapter = this.adapterFor(row.method);
    const target = this.targetOf(row);
    const pd = this.persistedDiff(row);
    await adapter.revert({
      target,
      before: pd.before,
      after: pd.after,
      ctx: this.adapterCtx(row),
    });
  }

  private adapterFor(method: SiteChangeRow["method"]): WriteMethodAdapter {
    const adapter = this.adapters.get(method);
    if (!adapter) {
      throw new MethodNotRegisteredError(
        `no write method adapter registered for '${method}' — cannot apply or roll back`,
      );
    }
    return adapter;
  }

  private adapterCtx(row: SiteChangeRow): AdapterContext {
    return {
      tenantId: row.tenant_id,
      clientId: row.client_id,
      propertyId: row.property_id,
    };
  }

  private persistedDiff(row: SiteChangeRow): PersistedChangeDiff {
    return row.diff as PersistedChangeDiff;
  }

  private targetOf(row: SiteChangeRow): ChangeTarget {
    const target = this.persistedDiff(row).target;
    if (!target) {
      throw new ConstraintViolationError(
        `change ${row.id} has no diff.target — cannot locate the write`,
      );
    }
    return target;
  }

  private async emitAutoRollbackAlert(
    change: SiteChangeRow,
    breaches: ReturnType<typeof evaluateBreaches>,
    warnings: PipelineWarning[],
  ): Promise<void> {
    if (!this.alertSink) return;
    const payload: Json = {
      changeId: change.id,
      method: change.method,
      changeType: change.change_type,
      revertedReason: change.reverted_reason,
      breaches: breaches.map((b) => describeBreach(b)),
      at: change.reverted_at,
    };
    try {
      await Promise.resolve(
        this.alertSink.emit({
          tenantId: change.tenant_id,
          clientId: change.client_id,
          type: "auto_rollback_fired",
          severity: "critical",
          payload,
        }),
      );
    } catch (err) {
      warnings.push({
        code: "alert_emit_failed",
        message: `auto-rollback fired but the alert sink threw: ${asError(err).message}`,
      });
    }
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
