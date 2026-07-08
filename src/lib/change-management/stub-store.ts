/**
 * In-memory ChangeStore — for tests and until the real Supabase repo lands in
 * 1.3 (doc 04 §6: the layer is built BEFORE any write method).
 *
 * This stub is a FAITHFUL emulation of the `site_changes` RLS + CHECK backstops,
 * so tests exercise the real safety net, not a permissive fake:
 *  - RLS tenant isolation: a row is invisible outside its tenant (get → null),
 *    and cross-tenant / non-writer mutations are refused.
 *  - CHECK constraints: every composed row is validated by the same
 *    state-machine assertions Postgres enforces (status graph + field presence).
 *
 * Deterministic: ids are a sequence; timestamps come from an injected Clock.
 */

import type { SiteChangeRow } from "@/lib/types/db";
import { isWriter } from "./automation";
import { AuthorizationError, ChangeNotFoundError, TenantScopeError } from "./errors";
import type {
  ChangePatch,
  ChangeStore,
  Clock,
  NewPreviewedChange,
} from "./ports";
import {
  assertLegalTransition,
  assertRowSatisfiesConstraints,
} from "./status-machine";
import type { TenantContext } from "./types";

export interface InMemoryChangeStoreOptions {
  clock: Clock;
  /** Id prefix for deterministic, readable ids (default "sc-"). */
  idPrefix?: string;
}

function clone(row: SiteChangeRow): SiteChangeRow {
  return structuredClone(row);
}

export class InMemoryChangeStore implements ChangeStore {
  private readonly rows = new Map<string, SiteChangeRow>();
  private readonly clock: Clock;
  private readonly idPrefix: string;
  private seq = 0;

  constructor(opts: InMemoryChangeStoreOptions) {
    this.clock = opts.clock;
    this.idPrefix = opts.idPrefix ?? "sc-";
  }

  async insertPreviewed(
    input: NewPreviewedChange,
    ctx: TenantContext,
  ): Promise<SiteChangeRow> {
    // RLS: only a writer may INSERT (mirrors site_changes_insert with_check
    // app.is_writer()). client_viewer is refused here as well as at the manager.
    this.assertWriterCtx(ctx, "insert");
    const now = this.clock.now();
    const id = `${this.idPrefix}${++this.seq}`;
    const row: SiteChangeRow = {
      id,
      tenant_id: ctx.tenantId,
      client_id: input.clientId,
      property_id: input.propertyId,
      method: input.method,
      change_type: input.changeType,
      automation_level: input.automationLevel,
      diff: input.diff,
      applied_by: null,
      approved_by: null,
      status: "previewed",
      reverted_reason: null,
      applied_at: null,
      reverted_at: null,
      created_at: now,
      updated_at: now,
    };
    assertRowSatisfiesConstraints(row);
    this.rows.set(id, row);
    return clone(row);
  }

  async insertPreviewedBatch(
    inputs: NewPreviewedChange[],
    ctx: TenantContext,
  ): Promise<SiteChangeRow[]> {
    const out: SiteChangeRow[] = [];
    for (const input of inputs) {
      out.push(await this.insertPreviewed(input, ctx));
    }
    return out;
  }

  async getById(id: string, ctx: TenantContext): Promise<SiteChangeRow | null> {
    const row = this.rows.get(id);
    // Fail closed: a row outside the caller's tenant is INVISIBLE (RLS), never
    // leaked. This is the tenant-isolation backstop the QA suite probes.
    if (!row || row.tenant_id !== ctx.tenantId) return null;
    return clone(row);
  }

  async update(
    id: string,
    patch: ChangePatch,
    ctx: TenantContext,
  ): Promise<SiteChangeRow> {
    this.assertWriterCtx(ctx, "update");
    const row = this.rows.get(id);
    if (!row || row.tenant_id !== ctx.tenantId) {
      // Cross-tenant or missing → not visible; RLS would update zero rows.
      throw new ChangeNotFoundError(
        `update: change ${id} not found in tenant scope`,
      );
    }

    const next: SiteChangeRow = {
      ...row,
      status: patch.status ?? row.status,
      approved_by: patch.approvedBy ?? row.approved_by,
      applied_by: patch.appliedBy ?? row.applied_by,
      applied_at: patch.appliedAt ?? row.applied_at,
      reverted_at: patch.revertedAt ?? row.reverted_at,
      reverted_reason: patch.revertedReason ?? row.reverted_reason,
      diff: patch.diff ?? row.diff,
      updated_at: this.clock.now(),
    };

    // Enforce the DB backstops on the RESULT: legal status edge + all CHECKs.
    if (patch.status !== undefined) {
      assertLegalTransition(row.status, patch.status);
    }
    assertRowSatisfiesConstraints(next);

    this.rows.set(id, next);
    return clone(next);
  }

  /** Test/inspection helper — a snapshot of a row regardless of caller scope. */
  peek(id: string): SiteChangeRow | undefined {
    const row = this.rows.get(id);
    return row ? clone(row) : undefined;
  }

  private assertWriterCtx(ctx: TenantContext, op: string): void {
    if (!isWriter(ctx.actor.role)) {
      throw new AuthorizationError(
        `role '${ctx.actor.role}' may not ${op} site_changes (RLS is_writer)`,
      );
    }
    if (!ctx.tenantId) {
      // Empty tenant → zero rows everywhere (fail closed, doc 03 §4).
      throw new TenantScopeError(`${op}: empty tenant context is refused`);
    }
  }
}
