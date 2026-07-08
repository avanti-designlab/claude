/**
 * Seam guards: automation-level, role, and tenant-scope enforcement (doc 04 §5,
 * §6; doc 03 §6).
 *
 * These are the runtime backstops behind the type-level guarantees. The
 * DesiredChange type already forbids 'auto' at compile time (its
 * automationLevel is a {@link SiteChangeAutomationLevel}); these functions
 * re-check at runtime because values can arrive from untyped boundaries
 * (JSON, an M1b generated playbook, a hostile caller).
 *
 * Reference discipline: src/lib/plan/audit-merge.ts CLAMPS a hostile 'auto' on
 * a publishing module to 'ai_draft_human_approve' upstream. This layer is the
 * LAST line before the write and REJECTS instead of clamping — a site write
 * whose automation level cannot be trusted must not proceed silently.
 */

import {
  SITE_CHANGE_AUTOMATION_LEVELS,
  type SiteChangeAutomationLevel,
  type TenantUserRole,
} from "@/lib/types/db";
import {
  AuthorizationError,
  AutomationLevelError,
  TenantScopeError,
} from "./errors";
import type { Actor, TenantContext } from "./types";

/** Roles permitted to preview/approve/apply/rollback a site write (doc 04 §5). */
export const WRITER_ROLES: readonly TenantUserRole[] = [
  "agency_admin",
  "operator",
];

export function isWriter(role: TenantUserRole): boolean {
  return WRITER_ROLES.includes(role);
}

/**
 * Throw unless the actor may write. `client_viewer` (and any non-writer role)
 * NEVER writes — this gate fronts every mutating pipeline entry point,
 * including PREVIEW (which inserts a `site_changes` row).
 */
export function assertWriter(actor: Actor, operation: string): void {
  if (!isWriter(actor.role)) {
    throw new AuthorizationError(
      `role '${actor.role}' may not ${operation} a site change (writers: ${WRITER_ROLES.join(
        ", ",
      )})`,
    );
  }
}

/** Default site-write automation level when a change omits one (doc 03 §6). */
export const DEFAULT_SITE_CHANGE_AUTOMATION_LEVEL: SiteChangeAutomationLevel =
  "ai_draft_human_approve";

/**
 * Narrow an arbitrary automation level to a valid site-write level, or throw.
 * 'auto' and unknown values are rejected — never coerced silently. An omitted
 * level defaults to `ai_draft_human_approve` (doc 03 §6 default for publishes).
 */
export function resolveWriteAutomationLevel(
  level: string | undefined,
): SiteChangeAutomationLevel {
  if (level === undefined) return DEFAULT_SITE_CHANGE_AUTOMATION_LEVEL;
  if (
    !SITE_CHANGE_AUTOMATION_LEVELS.includes(level as SiteChangeAutomationLevel)
  ) {
    throw new AutomationLevelError(
      level === "auto"
        ? "automation_level 'auto' is prohibited on site writes: fully autonomous " +
          "on-page publishing is banned (doc 00 §2, CLAUDE.md rule 5, doc 04 §6)"
        : `automation_level '${level}' is not a valid site-write level ` +
          `(allowed: ${SITE_CHANGE_AUTOMATION_LEVELS.join(", ")})`,
    );
  }
  return level as SiteChangeAutomationLevel;
}

/**
 * Assert a to-be-persisted change agrees with the operating tenant. The store
 * is the primary RLS boundary; this closes the smuggling vector at the seam so
 * a change built for tenant A can never be persisted under a context for tenant
 * B — the layer never crosses tenants.
 */
export function assertTenantMatch(
  changeTenantId: string,
  ctx: TenantContext,
  operation: string,
): void {
  if (changeTenantId !== ctx.tenantId) {
    throw new TenantScopeError(
      `${operation}: change tenant does not match the operating tenant — refused`,
    );
  }
}

/**
 * Assert a persisted row belongs to the operating tenant. Defense-in-depth so a
 * bug that returned a foreign row can never be acted on.
 */
export function assertRowInScope(
  row: { tenant_id: string },
  ctx: TenantContext,
  operation: string,
): void {
  if (row.tenant_id !== ctx.tenantId) {
    throw new TenantScopeError(
      `${operation}: change belongs to a different tenant — refused`,
    );
  }
}
