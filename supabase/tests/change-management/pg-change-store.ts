/**
 * PgChangeStore — the change-management `ChangeStore` port backed by the REAL
 * F1 Postgres schema, executed through RLS exactly as PostgREST would
 * (Phase 1.2; doc 04 §2; contract §5 site_changes).
 *
 * Every statement runs via the isolation harness's `queryAs(...)`: claims into
 * `request.jwt.claims`, SET ROLE authenticated, run — so this store is subject
 * to the SAME row-level security and CHECK constraints as production. It is
 * the proof that the pipeline's transitions are contract-legal against the
 * frozen schema, not just against the in-memory stub.
 *
 * The app has no live DB connection in 1.2 (BUILD-STATE provisioning note);
 * this store lives with the test harness. The production Supabase-backed
 * store lands at 1.3 with the first real write method — implementing the same
 * `ChangeStore` port this file proves out.
 */

import type { Client } from "pg";
import { ChangeNotFoundError, ConstraintViolationError } from "@/lib/change-management/errors";
import type {
  ChangePatch,
  ChangeStore,
  NewPreviewedChange,
} from "@/lib/change-management/ports";
import { LEGAL_TRANSITIONS } from "@/lib/change-management/status-machine";
import type { TenantContext } from "@/lib/change-management/types";
import type { JwtClaims, SiteChangeRow, SiteChangeStatus } from "@/lib/types/db";
import { queryAs } from "../helpers/harness";

/** pg returns Date for timestamptz; the contract mirror uses ISO strings. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(raw: Record<string, any>): SiteChangeRow {
  return {
    id: raw.id,
    tenant_id: raw.tenant_id,
    client_id: raw.client_id,
    property_id: raw.property_id,
    method: raw.method,
    change_type: raw.change_type,
    automation_level: raw.automation_level,
    diff: raw.diff,
    applied_by: raw.applied_by,
    approved_by: raw.approved_by,
    status: raw.status,
    reverted_reason: raw.reverted_reason,
    applied_at: isoOrNull(raw.applied_at),
    reverted_at: isoOrNull(raw.reverted_at),
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Wrap a Postgres CHECK/constraint rejection in the layer's typed error. */
function mapPgError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/violates check constraint|violates foreign key constraint/.test(message)) {
    throw new ConstraintViolationError(`postgres rejected the row: ${message}`);
  }
  throw err;
}

export class PgChangeStore implements ChangeStore {
  constructor(private readonly db: Client) {}

  /** PostgREST-exact claims for the operating context (RLS keys off these).
   *  The app role travels in `user_role` (app.user_role() reads it — migration
   *  0008); `role` stays GoTrue's reserved DB-role claim ('authenticated'). */
  private claims(ctx: TenantContext): JwtClaims {
    return {
      tenant_id: ctx.tenantId,
      role: "authenticated",
      user_role: ctx.actor.role,
    };
  }

  async insertPreviewed(
    input: NewPreviewedChange,
    ctx: TenantContext
  ): Promise<SiteChangeRow> {
    const rows = await this.insertPreviewedBatch([input], ctx);
    return rows[0];
  }

  async insertPreviewedBatch(
    inputs: NewPreviewedChange[],
    ctx: TenantContext
  ): Promise<SiteChangeRow[]> {
    if (inputs.length === 0) return [];
    // ONE multi-row INSERT → atomic: a batch preview persists whole or not at
    // all (a half-persisted batch could otherwise be half-applied later).
    const params: unknown[] = [];
    const tuples = inputs.map((input) => {
      params.push(
        ctx.tenantId,
        input.clientId,
        input.propertyId,
        input.method,
        input.changeType,
        input.automationLevel,
        JSON.stringify(input.diff)
      );
      const base = params.length - 7;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb)`;
    });
    try {
      const res = await queryAs(
        this.db,
        "authenticated",
        this.claims(ctx),
        `insert into site_changes
           (tenant_id, client_id, property_id, method, change_type, automation_level, diff)
         values ${tuples.join(", ")}
         returning *`,
        params
      );
      return res.rows.map(toRow);
    } catch (err) {
      mapPgError(err);
    }
  }

  async getById(id: string, ctx: TenantContext): Promise<SiteChangeRow | null> {
    const res = await queryAs(
      this.db,
      "authenticated",
      this.claims(ctx),
      // RLS pins tenant_id — a foreign tenant's row is invisible, not filtered
      // by app code. (Fail closed: empty claims ⇒ zero rows.)
      `select * from site_changes where id = $1`,
      [id]
    );
    return res.rows.length === 0 ? null : toRow(res.rows[0]);
  }

  async update(
    id: string,
    patch: ChangePatch,
    ctx: TenantContext
  ): Promise<SiteChangeRow> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      params.push(value);
      sets.push(`${fragment} $${params.length}`);
    };
    if (patch.status !== undefined) add("status =", patch.status);
    if (patch.approvedBy !== undefined) add("approved_by =", patch.approvedBy);
    if (patch.appliedBy !== undefined) add("applied_by =", patch.appliedBy);
    if (patch.appliedAt !== undefined) add("applied_at =", patch.appliedAt);
    if (patch.revertedAt !== undefined) add("reverted_at =", patch.revertedAt);
    if (patch.revertedReason !== undefined)
      add("reverted_reason =", patch.revertedReason);
    if (patch.diff !== undefined) add("diff =", JSON.stringify(patch.diff));
    if (sets.length === 0) {
      const current = await this.getById(id, ctx);
      if (!current) {
        throw new ChangeNotFoundError(`update: change ${id} not found in tenant scope`);
      }
      return current;
    }

    params.push(id);
    let where = `id = $${params.length}`;
    if (patch.status !== undefined) {
      // Optimistic status guard: only rows whose CURRENT status legally reaches
      // patch.status are updated (previewed→applied, applied→reverted, ...).
      // A concurrent double-apply therefore matches zero rows instead of
      // silently re-applying — same edge set as the state machine.
      const from = legalSources(patch.status);
      params.push(from);
      where += ` and status = any($${params.length}::text[])`;
    }

    try {
      const res = await queryAs(
        this.db,
        "authenticated",
        this.claims(ctx),
        `update site_changes set ${sets.join(", ")} where ${where} returning *`,
        params
      );
      if (res.rows.length === 0) {
        throw new ChangeNotFoundError(
          `update: change ${id} not found in tenant scope (or not in a status that may become '${patch.status}')`
        );
      }
      return toRow(res.rows[0]);
    } catch (err) {
      mapPgError(err);
    }
  }
}

/** Statuses from which `to` is legally reachable (state-machine edge inverse). */
function legalSources(to: SiteChangeStatus): SiteChangeStatus[] {
  return (Object.keys(LEGAL_TRANSITIONS) as SiteChangeStatus[]).filter((from) =>
    LEGAL_TRANSITIONS[from].includes(to)
  );
}
