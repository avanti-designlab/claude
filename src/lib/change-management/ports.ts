/**
 * Ports (injected interfaces) for the change-management layer (doc 04 §2).
 *
 * The pipeline core is pure orchestration; everything that touches the outside
 * world is an INTERFACE injected at construction. This is what lets Phase 1.3's
 * real write methods (WordPress / Webflow / Wix / Cloudflare edge worker) and
 * the real Supabase repo plug in WITHOUT editing this core — and is why the
 * layer "wraps ALL methods identically".
 *
 * Two ports carry the safety contract:
 *  - {@link WriteMethodAdapter}: apply + revert TOGETHER, so rollback always
 *    restores prior state via the SAME method that applied it (doc 04 §2).
 *  - {@link ChangeStore}: RLS-scoped persistence. The manager persists a
 *    `site_changes` row BEFORE any write, so an APPLY cannot happen without an
 *    audit row (no silent writes).
 */

import type {
  Json,
  SiteChangeAutomationLevel,
  SiteChangeMethod,
  SiteChangeRow,
  SiteChangeStatus,
  SiteChangeType,
} from "@/lib/types/db";
import type {
  ChangeTarget,
  PersistedChangeDiff,
  TenantContext,
} from "./types";

/* ------------------------------------------------------------------ */
/* WriteMethodAdapter — the ONLY thing that touches a client site      */
/* ------------------------------------------------------------------ */

/** Property coordinates handed to an adapter (no tenant crossing possible). */
export interface AdapterContext {
  tenantId: string;
  clientId: string;
  propertyId: string;
}

/** A single write instruction: restore `before` OR install `after` at `target`. */
export interface AdapterWrite {
  target: ChangeTarget;
  before: Json;
  after: Json;
  ctx: AdapterContext;
}

/**
 * One implementation per method (wordpress | webflow | wix | edge_worker | pr),
 * built in 1.3. Carries BOTH directions:
 *  - `apply` installs the desired after-state.
 *  - `revert` writes a prior state back THROUGH THE SAME adapter.
 * Rollback is therefore "write the captured before-state back" — universal
 * across all four methods, needing no vendor-specific undo handle.
 * `readCurrent` reads without writing (PREVIEW drift check + §4 no-op verify).
 */
export interface WriteMethodAdapter {
  readonly method: SiteChangeMethod;
  readCurrent(target: ChangeTarget, ctx: AdapterContext): Promise<Json>;
  apply(write: AdapterWrite): Promise<void>;
  revert(write: AdapterWrite): Promise<void>;
}

/** Adapter lookup, filled by 1.3 as each write method ships. */
export interface AdapterRegistry {
  get(method: SiteChangeMethod): WriteMethodAdapter | undefined;
}

/* ------------------------------------------------------------------ */
/* ChangeStore port — RLS-scoped persistence of site_changes           */
/* ------------------------------------------------------------------ */

/**
 * Insert shape for a fresh PREVIEW row. `tenantId` comes from the
 * {@link TenantContext} on the call, never from here, so a change cannot be
 * smuggled into another tenant. There is deliberately NO `batchId` field: the
 * frozen schema has no such column — batch membership is correlated in-app
 * (see {@link BatchPreview}), so no schema change is needed.
 */
export interface NewPreviewedChange {
  clientId: string;
  propertyId: string;
  method: SiteChangeMethod;
  changeType: SiteChangeType;
  automationLevel: SiteChangeAutomationLevel;
  diff: PersistedChangeDiff;
}

/** A patch to an existing row. The store composes the row and MUST reject any
 * result that violates a site_changes CHECK (Postgres is the real backstop; the
 * in-memory stub replicates it so tests prove the layer never even attempts an
 * illegal transition). */
export interface ChangePatch {
  status?: SiteChangeStatus;
  approvedBy?: string;
  appliedBy?: string;
  appliedAt?: string;
  revertedAt?: string;
  revertedReason?: string;
  diff?: PersistedChangeDiff;
}

/**
 * Persistence port. Every method is tenant-scoped: the implementation resolves
 * RLS from `ctx` and must return/patch ONLY rows in that tenant. A lookup for a
 * row outside scope returns null (fail closed), never another tenant's row.
 */
export interface ChangeStore {
  insertPreviewed(
    input: NewPreviewedChange,
    ctx: TenantContext,
  ): Promise<SiteChangeRow>;
  insertPreviewedBatch(
    inputs: NewPreviewedChange[],
    ctx: TenantContext,
  ): Promise<SiteChangeRow[]>;
  getById(id: string, ctx: TenantContext): Promise<SiteChangeRow | null>;
  update(
    id: string,
    patch: ChangePatch,
    ctx: TenantContext,
  ): Promise<SiteChangeRow>;
}

/* ------------------------------------------------------------------ */
/* Clock — determinism (inject, never Date.now inside)                 */
/* ------------------------------------------------------------------ */

/** Injected time source. Returns ISO-8601. Mirrors the plan generator's `now`. */
export interface Clock {
  now(): string;
}
