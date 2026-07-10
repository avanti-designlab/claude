/**
 * Shared fixtures for the F1 adversarial tenant-isolation suite (doc 03 §7
 * freeze criterion 2; doc 07 §0.3 gate).
 *
 * These describe, per table, how to build a VALID row in a given tenant and
 * where an existing seeded row lives — so the read/write sweeps can attack
 * every table uniformly. The per-role claim builders below are the four app
 * roles the JWT can carry (doc 03 §2).
 *
 * NOTE ON EXECUTION MODEL: queryAs() runs statements on the superuser admin
 * connection via `SET LOCAL ROLE authenticated`. RLS is correctly enforced
 * after the role switch (a non-superuser current role does not bypass RLS),
 * which is what every policy test here relies on. The one thing this model
 * canNOT test is `SET ROLE` privilege escalation (the session authorization
 * stays superuser) — escalation.test.ts uses a dedicated NOSUPERUSER
 * `authenticator`-style login role for that, mirroring Supabase exactly.
 */

import { randomUUID } from "node:crypto";
import type { JwtRole } from "@/lib/types/db";
import { claimsFor } from "../helpers/harness";
import type { SeededTenant } from "../helpers/seed";

/** The four app roles a JWT can carry (doc 03 §2). */
export const APP_ROLES: readonly JwtRole[] = [
  "agency_admin",
  "operator",
  "client_viewer",
  "platform_owner",
];

/** Build the standard claim set for an app role scoped to tenant `t`. */
export function claimsForRole(role: JwtRole, t: SeededTenant) {
  switch (role) {
    case "agency_admin":
      return claimsFor("agency_admin", t.tenantId, { sub: t.adminSub });
    case "operator":
      return claimsFor("operator", t.tenantId, { sub: t.operatorSub });
    case "client_viewer":
      return claimsFor("client_viewer", t.tenantId, {
        clientId: t.clientId,
        sub: t.viewerSub,
      });
    case "platform_owner":
      // platform_owner never carries a tenant membership; it still presents a
      // tenant_id claim, and the tenant-facing policies must yield it nothing.
      return claimsFor("platform_owner", t.tenantId, { sub: t.adminSub });
  }
}

/** How a row's owning tenant is identified: the root uses `id`, else tenant_id. */
export function tenantColumnOf(table: string): "id" | "tenant_id" {
  return table === "tenants" ? "id" : "tenant_id";
}

export interface TableWriteSpec {
  table: string;
  /** App roles that SHOULD be able to write this table (contract §3 / §9). */
  writers: JwtRole[];
  /** A valid INSERT for a fresh row homed in tenant `t`. */
  buildInsert(t: SeededTenant): { text: string; params: unknown[] };
  /** An existing seeded row id in tenant `t`. */
  ownRowId(t: SeededTenant): string;
}

/**
 * The twelve tenant-scoped tables (everything but the `tenants` root). Each
 * INSERT homes its FK parents in the SAME tenant `t`, so when the sweep aims a
 * tenant-A row at a tenant-B caller the ONLY thing that can reject it is the
 * RLS WITH CHECK — a deterministic "row-level security policy" error, not an
 * incidental FK failure.
 */
export const WRITE_SPECS: TableWriteSpec[] = [
  {
    table: "tenant_users",
    writers: ["agency_admin"],
    buildInsert: (t) => ({
      text: `insert into tenant_users (tenant_id, auth_user_id, role) values ($1, $2, 'operator')`,
      params: [t.tenantId, randomUUID()],
    }),
    ownRowId: (t) => t.operatorUserId,
  },
  {
    table: "clients",
    writers: ["agency_admin"],
    buildInsert: (t) => ({
      text: `insert into clients (tenant_id, name, vertical) values ($1, 'Intruder Co', 'ecommerce')`,
      params: [t.tenantId],
    }),
    ownRowId: (t) => t.clientId,
  },
  {
    table: "properties",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into properties (tenant_id, client_id, type, platform, url, connection_method)
             values ($1, $2, 'website', 'wordpress', 'https://x.example.com', 'api')`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.propertyId,
  },
  {
    table: "brand_kits",
    writers: ["agency_admin", "operator"],
    // version 2: the seed already occupies version 1 for the primary client, so
    // a legitimate positive-control insert must not collide on the
    // (tenant_id, client_id, version) unique key.
    buildInsert: (t) => ({
      text: `insert into brand_kits (tenant_id, client_id, tokens, voice_profile, version)
             values ($1, $2, '{}'::jsonb, '{}'::jsonb, 2)`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.brandKitId,
  },
  {
    table: "plans",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into plans (tenant_id, client_id, playbook_version, generated_roadmap)
             values ($1, $2, 'v1', '{}'::jsonb)`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.planId,
  },
  {
    table: "tasks",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into tasks (tenant_id, client_id, plan_id, module)
             values ($1, $2, $3, 'audit')`,
      params: [t.tenantId, t.clientId, t.planId],
    }),
    ownRowId: (t) => t.taskId,
  },
  {
    table: "audits",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into audits (tenant_id, client_id, property_id, score, fixes)
             values ($1, $2, $3, '{}'::jsonb, '[]'::jsonb)`,
      params: [t.tenantId, t.clientId, t.propertyId],
    }),
    ownRowId: (t) => t.auditId,
  },
  {
    table: "content_items",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into content_items (tenant_id, client_id, type, brand_kit_id, body)
             values ($1, $2, 'blog', $3, 'body')`,
      params: [t.tenantId, t.clientId, t.brandKitId],
    }),
    ownRowId: (t) => t.contentItemId,
  },
  {
    table: "site_changes",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff)
             values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb)`,
      params: [t.tenantId, t.clientId, t.propertyId],
    }),
    ownRowId: (t) => t.siteChangeId,
  },
  {
    table: "visibility_results",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into visibility_results (tenant_id, client_id, engine, prompt, cited)
             values ($1, $2, 'chatgpt', 'p', true)`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.visibilityResultId,
  },
  {
    table: "metrics",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into metrics (tenant_id, client_id, source, data)
             values ($1, $2, 'gsc', '{}'::jsonb)`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.metricId,
  },
  {
    table: "alerts",
    writers: ["agency_admin", "operator"],
    buildInsert: (t) => ({
      text: `insert into alerts (tenant_id, client_id, type, severity)
             values ($1, $2, 'visibility_drop', 'info')`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.alertId,
  },
  {
    table: "competitors",
    writers: ["agency_admin", "operator"],
    // Distinct name from the seed's "Rival <label>" so the own-tenant positive
    // control never collides on the (tenant_id, client_id, lower(name)) index.
    buildInsert: (t) => ({
      text: `insert into competitors (tenant_id, client_id, name)
             values ($1, $2, 'Fixture Rival')`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.competitorId,
  },
  {
    table: "runs",
    writers: ["agency_admin", "operator"],
    // Client-scoped enqueue (property_id NULL) — valid for the positive control;
    // the is_writer INSERT policy is the enqueue floor.
    buildInsert: (t) => ({
      text: `insert into runs (tenant_id, client_id, kind)
             values ($1, $2, 'audit')`,
      params: [t.tenantId, t.clientId],
    }),
    ownRowId: (t) => t.runId,
  },
];

/** Roles that must be REJECTED as writers of a given spec (the complement). */
export function nonWritersOf(spec: TableWriteSpec): JwtRole[] {
  return APP_ROLES.filter((r) => !spec.writers.includes(r));
}

/** Rejections we accept for a cross-tenant / re-home write: RLS, or the
 *  structural composite-FK backstop when RLS lets a shape through. */
export const REJECT_WRITE = /row-level security|violates foreign key|foreign key constraint/;
/** A pure RLS WITH CHECK rejection (deterministic for same-tenant-FK inserts). */
export const REJECT_RLS = /new row violates row-level security policy/;
/** No grant at all for the (role, command) — anon everywhere, tenants ins/del. */
export const REJECT_NO_GRANT = /permission denied/;
