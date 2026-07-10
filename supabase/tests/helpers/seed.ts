/**
 * Two-tenant seed for isolation testing. Inserted via the superuser admin
 * connection (bypasses RLS by design — the tests then attack the seeded data
 * through queryAs()). Every F1 table gets at least one row per tenant so
 * cross-tenant canaries can sweep the whole schema.
 */

import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export interface SeededTenant {
  tenantId: string;
  adminUserId: string;
  operatorUserId: string;
  viewerUserId: string;
  adminSub: string;
  operatorSub: string;
  viewerSub: string;
  clientId: string;
  /** Second client in the same tenant — the "sibling client" for viewer tests. */
  siblingClientId: string;
  propertyId: string;
  brandKitId: string;
  planId: string;
  taskId: string;
  auditId: string;
  contentItemId: string;
  siteChangeId: string;
  visibilityResultId: string;
  metricId: string;
  alertId: string;
  competitorId: string;
  runId: string;
}

const THEME = {
  logo_url: "https://example.com/logo.svg",
  colors: {
    surface: "#0b0b0f",
    surface_raised: "#15151c",
    ink: "#f4f4f6",
    muted: "#9a9aa6",
    accent: "#5865f2",
    positive: "#3dd68c",
    negative: "#f2555a",
  },
  font: { display: "Sora", body: "Inter", mono: "JetBrains Mono" },
  custom_domain: null,
};

const TOKENS = {
  colors: {
    surface: "#0b0b0f",
    surfaceRaised: "#15151c",
    ink: "#f4f4f6",
    muted: "#9a9aa6",
    accent: "#5865f2",
    positive: "#3dd68c",
    negative: "#f2555a",
  },
  typography: { display: "Sora", body: "Inter", mono: "JetBrains Mono", scale: {} },
  spacing: { unit: 4, steps: [1, 2, 4, 6, 8] },
};

const VOICE_PROFILE = {
  descriptors: ["confident"],
  samples: ["We know this market."],
  do: ["be direct"],
  dont: ["overpromise"],
};

async function insertReturningId(
  admin: Client,
  sql: string,
  params: unknown[]
): Promise<string> {
  const res = await admin.query<{ id: string }>(sql, params);
  return res.rows[0].id;
}

export async function seedTenant(
  admin: Client,
  label: string
): Promise<SeededTenant> {
  const adminSub = randomUUID();
  const operatorSub = randomUUID();
  const viewerSub = randomUUID();

  const tenantId = await insertReturningId(
    admin,
    `insert into tenants (name, theme, plan_tier) values ($1, $2, 'agency') returning id`,
    [`Tenant ${label}`, JSON.stringify(THEME)]
  );

  const clientId = await insertReturningId(
    admin,
    `insert into clients (tenant_id, name, vertical, locations, status)
     values ($1, $2, 'real-estate', $3, 'active') returning id`,
    [
      tenantId,
      `Client ${label}`,
      JSON.stringify([{ name: "HQ", address: "1 Main St", geo: null }]),
    ]
  );

  const siblingClientId = await insertReturningId(
    admin,
    `insert into clients (tenant_id, name, vertical, status)
     values ($1, $2, 'restaurants', 'active') returning id`,
    [tenantId, `Sibling Client ${label}`]
  );

  const adminUserId = await insertReturningId(
    admin,
    `insert into tenant_users (tenant_id, auth_user_id, role)
     values ($1, $2, 'agency_admin') returning id`,
    [tenantId, adminSub]
  );
  const operatorUserId = await insertReturningId(
    admin,
    `insert into tenant_users (tenant_id, auth_user_id, role)
     values ($1, $2, 'operator') returning id`,
    [tenantId, operatorSub]
  );
  const viewerUserId = await insertReturningId(
    admin,
    `insert into tenant_users (tenant_id, auth_user_id, role, client_id)
     values ($1, $2, 'client_viewer', $3) returning id`,
    [tenantId, viewerSub, clientId]
  );

  const propertyId = await insertReturningId(
    admin,
    `insert into properties (tenant_id, client_id, type, platform, url, auth_ref, connection_method)
     values ($1, $2, 'website', 'wordpress', $3, $4, 'api') returning id`,
    [
      tenantId,
      clientId,
      `https://client-${label.toLowerCase()}.example.com`,
      `vault://properties/${label.toLowerCase()}-website`,
    ]
  );

  const brandKitId = await insertReturningId(
    admin,
    `insert into brand_kits (tenant_id, client_id, tokens, voice_profile, assets, locked, version)
     values ($1, $2, $3, $4, $5, true, 1) returning id`,
    [
      tenantId,
      clientId,
      JSON.stringify(TOKENS),
      JSON.stringify(VOICE_PROFILE),
      JSON.stringify({ logo_url: "https://example.com/client-logo.svg" }),
    ]
  );

  const planId = await insertReturningId(
    admin,
    `insert into plans (tenant_id, client_id, playbook_version, generated_roadmap)
     values ($1, $2, 'real-estate@1', '{"tasks": []}') returning id`,
    [tenantId, clientId]
  );

  const taskId = await insertReturningId(
    admin,
    `insert into tasks (tenant_id, client_id, plan_id, module, assigned_to, payload)
     values ($1, $2, $3, 'audit', $4, '{}') returning id`,
    [tenantId, clientId, planId, operatorUserId]
  );

  const auditId = await insertReturningId(
    admin,
    `insert into audits (tenant_id, client_id, property_id, score, fixes)
     values ($1, $2, $3, '{"total": 61}', '[]') returning id`,
    [tenantId, clientId, propertyId]
  );

  const contentItemId = await insertReturningId(
    admin,
    `insert into content_items (tenant_id, client_id, type, brand_kit_id, body)
     values ($1, $2, 'blog', $3, 'Draft body.') returning id`,
    [tenantId, clientId, brandKitId]
  );

  const siteChangeId = await insertReturningId(
    admin,
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff)
     values ($1, $2, $3, 'wordpress', 'title', '{"before": "a", "after": "b"}') returning id`,
    [tenantId, clientId, propertyId]
  );

  const visibilityResultId = await insertReturningId(
    admin,
    `insert into visibility_results (tenant_id, client_id, engine, prompt, cited, position, sentiment)
     values ($1, $2, 'chatgpt', 'best real estate advisor', true, 2, 'positive') returning id`,
    [tenantId, clientId]
  );

  const metricId = await insertReturningId(
    admin,
    `insert into metrics (tenant_id, client_id, source, data)
     values ($1, $2, 'gsc', '{"clicks": 10}') returning id`,
    [tenantId, clientId]
  );

  const alertId = await insertReturningId(
    admin,
    `insert into alerts (tenant_id, client_id, type, severity, payload)
     values ($1, $2, 'visibility_drop', 'warning', '{}') returning id`,
    [tenantId, clientId]
  );

  // competitors (0010) — under the PRIMARY client, so client_viewer own-client
  // reads find a row and the sibling-blindness test has something to be blind to.
  const competitorId = await insertReturningId(
    admin,
    `insert into competitors (tenant_id, client_id, name, domain)
     values ($1, $2, $3, 'rival.example.com') returning id`,
    [tenantId, clientId, `Rival ${label}`]
  );

  // runs (0011) — a property-scoped audit work-order under the primary client.
  const runId = await insertReturningId(
    admin,
    `insert into runs (tenant_id, client_id, property_id, kind, requested_by)
     values ($1, $2, $3, 'audit', $4) returning id`,
    [tenantId, clientId, propertyId, operatorUserId]
  );

  return {
    tenantId,
    adminUserId,
    operatorUserId,
    viewerUserId,
    adminSub,
    operatorSub,
    viewerSub,
    clientId,
    siblingClientId,
    propertyId,
    brandKitId,
    planId,
    taskId,
    auditId,
    contentItemId,
    siteChangeId,
    visibilityResultId,
    metricId,
    alertId,
    competitorId,
    runId,
  };
}

/** Seed two fully-populated tenants (A and B) for cross-tenant attacks. */
export async function seedTenantPair(
  admin: Client
): Promise<{ a: SeededTenant; b: SeededTenant }> {
  const a = await seedTenant(admin, "A");
  const b = await seedTenant(admin, "B");
  return { a, b };
}

/**
 * Row ids seeded onto a tenant's SIBLING client (a second client in the same
 * tenant). Used by the client_viewer suite to prove sibling-client blindness:
 * a viewer scoped to `clientId` must never see any of these — they live in the
 * same tenant but under a different client_id (doc 03 §2).
 */
export interface SiblingClientRows {
  propertyId: string;
  brandKitId: string;
  planId: string;
  taskId: string;
  auditId: string;
  contentItemId: string;
  siteChangeId: string;
  visibilityResultId: string;
  metricId: string;
  alertId: string;
  competitorId: string;
}

/**
 * Populate every client-scoped module table with one row under the tenant's
 * SIBLING client (`t.siblingClientId`). Superuser insert (bypasses RLS) — the
 * viewer tests then attack visibility through queryAs(). Additive: does not
 * touch the primary-client rows seeded by seedTenant().
 */
export async function seedSiblingClientRows(
  admin: Client,
  t: SeededTenant
): Promise<SiblingClientRows> {
  const propertyId = await insertReturningId(
    admin,
    `insert into properties (tenant_id, client_id, type, platform, url, connection_method)
     values ($1, $2, 'website', 'webflow', $3, 'api') returning id`,
    [t.tenantId, t.siblingClientId, `https://sibling-${t.siblingClientId}.example.com`]
  );

  const brandKitId = await insertReturningId(
    admin,
    `insert into brand_kits (tenant_id, client_id, tokens, voice_profile, locked, version)
     values ($1, $2, $3, $4, true, 1) returning id`,
    [t.tenantId, t.siblingClientId, JSON.stringify(TOKENS), JSON.stringify(VOICE_PROFILE)]
  );

  const planId = await insertReturningId(
    admin,
    `insert into plans (tenant_id, client_id, playbook_version, generated_roadmap)
     values ($1, $2, 'restaurants@1', '{"tasks": []}') returning id`,
    [t.tenantId, t.siblingClientId]
  );

  const taskId = await insertReturningId(
    admin,
    `insert into tasks (tenant_id, client_id, plan_id, module, assigned_to, payload)
     values ($1, $2, $3, 'content', $4, '{}') returning id`,
    [t.tenantId, t.siblingClientId, planId, t.operatorUserId]
  );

  const auditId = await insertReturningId(
    admin,
    `insert into audits (tenant_id, client_id, property_id, score, fixes)
     values ($1, $2, $3, '{"total": 42}', '[]') returning id`,
    [t.tenantId, t.siblingClientId, propertyId]
  );

  const contentItemId = await insertReturningId(
    admin,
    `insert into content_items (tenant_id, client_id, type, brand_kit_id, body)
     values ($1, $2, 'faq', $3, 'Sibling draft.') returning id`,
    [t.tenantId, t.siblingClientId, brandKitId]
  );

  const siteChangeId = await insertReturningId(
    admin,
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff)
     values ($1, $2, $3, 'webflow', 'meta', '{"before": "x", "after": "y"}') returning id`,
    [t.tenantId, t.siblingClientId, propertyId]
  );

  const visibilityResultId = await insertReturningId(
    admin,
    `insert into visibility_results (tenant_id, client_id, engine, prompt, cited)
     values ($1, $2, 'perplexity', 'sibling prompt', false) returning id`,
    [t.tenantId, t.siblingClientId]
  );

  const metricId = await insertReturningId(
    admin,
    `insert into metrics (tenant_id, client_id, source, data)
     values ($1, $2, 'ga4', '{"sessions": 3}') returning id`,
    [t.tenantId, t.siblingClientId]
  );

  const alertId = await insertReturningId(
    admin,
    `insert into alerts (tenant_id, client_id, type, severity, payload)
     values ($1, $2, 'schema_broke', 'critical', '{}') returning id`,
    [t.tenantId, t.siblingClientId]
  );

  // competitors under the SIBLING client — the viewer must be BLIND to these.
  const competitorId = await insertReturningId(
    admin,
    `insert into competitors (tenant_id, client_id, name)
     values ($1, $2, 'Sibling Rival') returning id`,
    [t.tenantId, t.siblingClientId]
  );

  return {
    propertyId,
    brandKitId,
    planId,
    taskId,
    auditId,
    contentItemId,
    siteChangeId,
    visibilityResultId,
    metricId,
    alertId,
    competitorId,
  };
}
