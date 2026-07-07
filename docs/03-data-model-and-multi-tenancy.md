# 03 — Data Model & Multi-Tenancy
### The foundation. Built first, security-reviewed, frozen before any feature work.

> **Purpose.** Defines the multi-tenant data model, Supabase Row-Level Security strategy, role model, white-label theming foundation, and the core schema every module reads. Owned by the `lead-backend-data-architect` agent. **This is Phase 0 and it blocks everything.**

> **The one rule that governs this entire document:** every row belongs to a tenant, and no query, route, or policy may ever let one tenant see another tenant's data. This is enforced at the database level (RLS), not just the application level.

---

## 1. Tenancy model

**Shared-database, shared-schema, row-level isolation.** One Postgres database; every tenant-owned table carries a `tenant_id`; Supabase RLS policies enforce isolation. This is the right model for "build multi-tenant, deploy single-tenant" — we run as one tenant now, but the isolation is real from day one, so onboarding a second tenant (an external agency) is a data operation, not a rewrite.

**Hierarchy:**
```
Tenant (an agency — us first, external agencies later)
  └── Users (agency staff: admin / operator; and client-viewers)
  └── Clients (the agency's clients — GG, Jungle Boys, etc.)
        └── Properties (a client's websites / GBP / social accounts)
        └── Brand Kit (locked brand system for the client)
        └── Playbook binding (which vertical playbook is active)
        └── Plans, Tasks, Audits, Content, Changes, Metrics...
```

**White-label note:** the `tenant` carries theming (logo, colors, domain). The client-viewer sees the agency's brand, never ours. Even while we're the only tenant, the client dashboard renders our agency brand via this same mechanism — so the white-label path is exercised from day one.

---

## 2. Role model

| Role | Scope | Can |
|---|---|---|
| `platform_owner` | across tenants (us, internal) | manage tenants, global config — **never** used to bypass tenant isolation in tenant-facing queries |
| `agency_admin` | one tenant | manage users, clients, billing, all modules within the tenant |
| `operator` | one tenant | run modules, generate/review content, approve changes (per the team's 30 operators) |
| `client_viewer` | one client within a tenant | read-only dashboard for their own client record only |

RLS policies key off `tenant_id` and, for `client_viewer`, additionally off `client_id`. A `client_viewer` can never see sibling clients.

---

## 3. Core schema (illustrative — the Backend agent finalizes types/indexes)

```sql
-- TENANT
tenants (
  id uuid pk,
  name text,
  theme jsonb,              -- {logo_url, colors, font, custom_domain}  (white-label)
  plan_tier text,
  created_at timestamptz
)

-- USERS  (Supabase auth.users linked)
tenant_users (
  id uuid pk,
  tenant_id uuid fk -> tenants,
  auth_user_id uuid,        -- supabase auth
  role text,                -- agency_admin | operator | client_viewer
  client_id uuid null fk -> clients,   -- set only for client_viewer
  created_at timestamptz
)

-- CLIENTS
clients (
  id uuid pk,
  tenant_id uuid fk -> tenants,
  name text,
  vertical text,            -- cannabis | real-estate | restaurants | health-life-insurance | ecommerce
  locations jsonb,          -- [{name, address, geo}]  drives local module
  status text,
  created_at timestamptz
)

-- PROPERTIES  (a client's connected assets)
properties (
  id uuid pk,
  tenant_id uuid fk,
  client_id uuid fk -> clients,
  type text,                -- website | gbp | instagram | linkedin | ...
  platform text,            -- wordpress | webflow | wix | framer | nextjs | custom
  url text,
  auth_ref text,            -- reference to secrets vault, NEVER raw creds in table
  connection_method text,   -- api | edge_worker | pr | none
  created_at timestamptz
)

-- BRAND KIT  (locked brand system — feeds production + white-label)
brand_kits (
  id uuid pk,
  tenant_id uuid fk,
  client_id uuid fk -> clients,
  tokens jsonb,             -- colors/type/spacing (from brand-kit-design-token skill)
  voice_profile jsonb,      -- tone descriptors + samples
  likeness_refs jsonb,      -- Higgsfield/Motion reference element ids
  locked boolean,
  version int
)

-- PLAYBOOK BINDING + generated plan
plans (
  id uuid pk,
  tenant_id uuid fk,
  client_id uuid fk,
  playbook_version text,
  generated_roadmap jsonb,  -- prioritized tasks from Playbook Engine + audit
  created_at timestamptz
)

tasks (
  id uuid pk,
  tenant_id uuid fk,
  client_id uuid fk,
  plan_id uuid fk,
  module text,              -- which module (audit/content/schema/local/...)
  automation_level text,    -- auto | ai_draft_human_approve | human_only
  status text,              -- todo | in_progress | in_review | approved | published | reverted
  assigned_to uuid null,
  payload jsonb,
  created_at timestamptz
)

-- AUDITS
audits (
  id uuid pk, tenant_id uuid fk, client_id uuid fk, property_id uuid fk,
  score jsonb,              -- rubric results from aeo-audit skill
  fixes jsonb,              -- prioritized fix list w/ impact estimates
  created_at timestamptz
)

-- CONTENT  (blogs, FAQ rewrites, captions, schema copy)
content_items (
  id uuid pk, tenant_id uuid fk, client_id uuid fk,
  type text,               -- blog | faq | caption | pillar | schema_copy
  brand_kit_id uuid fk,
  body text,
  humanization jsonb,      -- {humanized:bool, detection_score, passes:bool}
  quality_review jsonb,    -- content-quality agent verdict
  compliance_review jsonb, -- compliance-review agent verdict
  status text,             -- draft | in_review | approved | published
  created_at timestamptz
)

-- CHANGES  (every write to a client site — the audit trail for auto-fix)
site_changes (
  id uuid pk, tenant_id uuid fk, client_id uuid fk, property_id uuid fk,
  method text,             -- wordpress | webflow | wix | edge_worker | pr
  change_type text,        -- h1 | title | meta | schema | alt | content | canonical
  diff jsonb,              -- before/after
  applied_by uuid,         -- operator/agent
  approved_by uuid,        -- human approval (required for non-auto)
  status text,             -- previewed | applied | reverted | auto_reverted
  reverted_reason text,
  applied_at timestamptz,
  reverted_at timestamptz
)

-- VISIBILITY / METRICS
visibility_results (
  id uuid pk, tenant_id uuid fk, client_id uuid fk,
  engine text,             -- chatgpt | perplexity | gemini | claude | copilot | google_aio
  prompt text,
  cited boolean,
  position int null,
  sentiment text,
  cited_source text,       -- what was cited instead (for M4 reverse-engineering)
  captured_at timestamptz  -- history matters — churn is high
)

metrics (
  id uuid pk, tenant_id uuid fk, client_id uuid fk,
  source text,             -- gsc | ga4 | call_tracking | local_rank | reviews
  data jsonb,
  captured_at timestamptz
)

-- ALERTS
alerts (
  id uuid pk, tenant_id uuid fk, client_id uuid fk,
  type text,               -- visibility_drop | competitor_overtook | schema_broke |
                           -- crawler_blocked | negative_review_spike | site_down
  severity text, payload jsonb, acknowledged boolean, created_at timestamptz
)
```

**Every tenant-owned table has:** `tenant_id` (indexed), an RLS policy scoping to the caller's tenant, and — where relevant — `client_id` scoping for `client_viewer`.

---

## 4. RLS policy pattern (the Code Review agent verifies this on every table)

```sql
-- Example: clients table
alter table clients enable row level security;

create policy tenant_isolation on clients
  using (tenant_id = auth.jwt() ->> 'tenant_id');

-- Example: client_viewer restriction (read-only, own client only)
create policy client_viewer_scope on clients
  for select
  using (
    tenant_id = auth.jwt() ->> 'tenant_id'
    and (
      (auth.jwt() ->> 'role') <> 'client_viewer'
      or id = (auth.jwt() ->> 'client_id')::uuid
    )
  );
```

`tenant_id` and `role` and `client_id` are carried in the JWT claims (set at auth time). **No application code is trusted to enforce isolation alone — RLS is the backstop.**

---

## 5. Secrets & credentials

- Client site/API credentials (WordPress app passwords, Webflow/Wix tokens, social tokens) are **never stored raw in tables**. `properties.auth_ref` points to a secrets vault (Supabase Vault or an external secrets manager managed by the DevOps agent).
- All third-party platform keys (engines, Ayrshare, humanizer, GA4) are environment secrets, per-tenant where the tenant supplies their own.

---

## 6. Automation-level flag (the human/AI orchestration, in data)

Every `task` and every generative action carries `automation_level`:
- `auto` — schema validation, rank tracking, reporting, freshness detection (no human needed)
- `ai_draft_human_approve` — content, schema generation, review responses, social posts, on-page fixes (default for anything that publishes)
- `human_only` — genuine Reddit/Quora participation, compliance sign-off, strategy

This flag is how the platform delivers "AI where we can, humans where needed to build real authority and not spam." It is set per module per vertical and can be overridden per client.

---

## 7. Freeze criteria (Phase 0 exit)

The data model is frozen only when:
1. Every tenant-owned table has RLS enabled + tested.
2. `qa-testing` tenant-isolation suite passes (no cross-tenant read/write possible under any role).
3. Role model verified (client_viewer cannot see sibling clients).
4. API contracts published by the Documentation agent.
5. `code-review` signs off on security + isolation.

Only then does the Orchestrator open Phase 1 feature work.
