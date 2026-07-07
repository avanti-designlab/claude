# Data Model & Multi-Tenancy Contract (F1)

| | |
|---|---|
| **Version** | 1.0.0 |
| **Status** | **Published (F1 freeze candidate)** |
| **Date** | 2026-07-07 |
| **Published by** | `documentation` agent, per doc 03 §7 freeze criterion 4 |
| **Authored by** | `lead-backend-data-architect` (build step 0.3), corrected per the F1 Code Review gate |

> **This contract is binding.** Frontend and all module agents consume it
> exactly as documented — build against this document, not against the SQL
> directly. Published after a line-by-line sync verification against the
> migrations, with the QA isolation suite and smoke suite green.
> **Post-freeze changes require Orchestrator + Code Review sign-off
> (CLAUDE.md rule 1)** and are recorded in the `docs/BUILD-STATE.md` freeze
> log. Full version history: [Changelog](#changelog) below.

Source migrations: `supabase/migrations/0001–0006`. Shared TS mirror:
`src/lib/types/db.ts`. Spec: `docs/03-data-model-and-multi-tenancy.md`.

**The one rule:** every row belongs to a tenant; no query, route, or policy may
ever let one tenant see another tenant's data. Enforced in the database (RLS on
every table, FORCED) *and* structurally (composite FKs) — application code is
never trusted alone.

---

## 1. Tenancy model

Shared database, shared schema, row-level isolation (doc 03 §1). Hierarchy:
`tenants → tenant_users / clients → properties, brand_kits, plans, tasks,
audits, content_items, site_changes, visibility_results, metrics, alerts`.

## 2. JWT claim contract

Claims are set at auth time and read in policies via `auth.jwt()` (Supabase-
provided; the test harness installs an exact local shim — migrations never
create the `auth` schema). Helpers live in the `app` schema (migration 0001).

| Claim | Type | Semantics |
|---|---|---|
| `tenant_id` | uuid-as-text | Caller's tenant. Missing/empty ⇒ every policy is not-true ⇒ zero rows / no writes. **Fail closed.** |
| `role` | text | `platform_owner` \| `agency_admin` \| `operator` \| `client_viewer`. Unknown/missing ⇒ fail closed. |
| `client_id` | uuid-as-text | Present **iff** `role = client_viewer`. |
| `sub` | uuid-as-text | Supabase auth user id (`auth.users.id`). |

TS shape: `JwtClaims` in `src/lib/types/db.ts`.

## 3. Role model & RLS behavior

Postgres request roles are Supabase's `authenticated` / `anon`; the app role
travels in the JWT. **`anon` has zero grants on tenant data.** Policies exist
per command (SELECT/INSERT/UPDATE/DELETE) — write policies are explicit, never
implied.

| App role | Read | Write |
|---|---|---|
| `platform_owner` | **No rows via tenant-facing policies** (doc 03 §2: never bypasses tenant isolation). Platform tooling runs server-side under `service_role` (BYPASSRLS) with its own audit. | none via policies |
| `agency_admin` | everything in own tenant | everything in own tenant, incl. the admin-only surfaces: `tenants` (update), `tenant_users`, `clients` |
| `operator` | everything in own tenant | all module tables (`properties`, `brand_kits`, `plans`, `tasks`, `audits`, `content_items`, `site_changes`, `visibility_results`, `metrics`, `alerts`); **not** `tenants` / `tenant_users` / `clients` |
| `client_viewer` | **read-only, own `client_id` only**, on every client-scoped table, plus own tenant row (white-label theme) and own `tenant_users` row | **nothing** — no write policy anywhere matches it |

Per-table summary (all policies additionally pin `tenant_id = app.tenant_id()`;
UPDATE policies re-check the pin in `WITH CHECK` so rows cannot be re-homed):

| Table | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `tenants` | own row, all three tenant roles | UPDATE admin only; INSERT/DELETE **service_role only** (provisioning) |
| `tenant_users` | staff: whole tenant; viewer: own row (`auth_user_id = sub`) | admin only |
| `clients` | staff: whole tenant; viewer: own client row | admin only |
| all module tables | staff: whole tenant; viewer: rows with own `client_id` | admin + operator |

The `client_viewer` read set intentionally covers everything its dashboard
(M19) renders: visibility, metrics, work-done log (`site_changes`), content
calendar (`content_items`), plans/tasks/audits/alerts — always pinned to its
`client_id`. Sibling clients are invisible by policy AND tested.

**Claim-minting obligation (upstream, binding on the 1.x auth layer):** the
auth/JWT-minting layer MUST source the `client_id` claim from
`tenant_users.client_id` — a `client_viewer` must never influence its own
`client_id` claim. The schema fails closed on mismatched claims (verified by
test), but claim-minting integrity is an upstream obligation the database
cannot supply.

## 4. Tenant-consistency strategy (structural, below RLS)

Every cross-table reference travels through a **composite FK carrying
`tenant_id`**, anchored by matching UNIQUE constraints on the parent. It is
impossible — even for a bug in app code, even for the superuser — to point a
row at another tenant's client/property/plan/kit/user:

- `(tenant_id, client_id) → clients (tenant_id, id)` — properties, brand_kits,
  plans, content_items, visibility_results, metrics, alerts, tenant_users.
- `(tenant_id, client_id, plan_id) → plans (tenant_id, client_id, id)` — tasks.
  Three-column form: the task's plan must belong to the **same client**, too.
- `(tenant_id, client_id, property_id) → properties (tenant_id, client_id, id)`
  — audits, site_changes (same-client guarantee).
- `(tenant_id, client_id, brand_kit_id) → brand_kits (tenant_id, client_id, id)`
  — content_items.
- `(tenant_id, assigned_to|applied_by|approved_by) → tenant_users (tenant_id, id)`
  — tasks (SET NULL on the single column), site_changes (RESTRICT — audit
  trail actors are never erased).

All FKs are `ON DELETE RESTRICT` (except the column-targeted
`tasks.assigned_to` SET NULL): destructive cleanup is an explicit platform
operation, never a cascade.

## 5. Table reference

Common: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null`
(indexed — always the leading column of at least one index; on `tenants`
itself the row's own `id` is the tenant id), `created_at timestamptz not null
default now()` — **except** `visibility_results` and `metrics`, whose sole
timestamp is `captured_at timestamptz not null default now()` (point-in-time
captures; no `created_at`). Mutable tables add trigger-maintained
`updated_at`. TS row types: `src/lib/types/db.ts`.

### tenants
| Column | Notes |
|---|---|
| `name` | agency display name |
| `theme` | white-label jsonb — shape in §7; CHECK-constrained |
| `plan_tier` | free text; value set is post-F1 billing work |

### tenant_users
| Column | Notes |
|---|---|
| `auth_user_id` | Supabase `auth.users.id`. **No FK** — migrations must not depend on Supabase-managed schemas; the harness shim only provides `auth.jwt()` |
| `role` | CHECK: `agency_admin`\|`operator`\|`client_viewer` (`platform_owner` is never a tenant membership) |
| `client_id` | CHECK: non-null **iff** `client_viewer`; composite FK to same-tenant client |
| unique | `(tenant_id, auth_user_id)`, `(tenant_id, id)` anchor |

### clients
| Column | Notes |
|---|---|
| `name` | client display name (`text not null`) |
| `vertical` | open set — seed five or any M1b-generated vertical (no CHECK, matches `Vertical` type) |
| `locations` | jsonb array `[{name, address, geo}]`; `geo` shape deferred to M14 |
| `status` | CHECK: `onboarding`\|`active`\|`paused`\|`archived`, default `onboarding` (doc-silent; §9) |

### properties
| Column | Notes |
|---|---|
| `type` | `website`\|`gbp`\|`instagram`\|`linkedin`\|... — open set per doc 03 |
| `platform` | nullable; CHECK against the six doc platforms; **required when `type='website'`** |
| `url` | property URL |
| `auth_ref` | **vault reference only** (doc 03 §5) — raw credentials never in any table; nullable (`connection_method='none'`) |
| `connection_method` | CHECK: `api`\|`edge_worker`\|`pr`\|`none`, default `none` |

### brand_kits
| Column | Notes |
|---|---|
| `tokens` | `DesignTokenSet` jsonb (§7 — TS camelCase keys) |
| `voice_profile` | `VoiceProfile` jsonb |
| `likeness_refs` | `LikenessRefs` jsonb, defaults to empty id lists |
| `assets` | **F1 addition** (§8 item 4): `{logo_url, ...}` client brand assets |
| `locked`, `version` | version ≥ 1; unique `(tenant_id, client_id, version)` |

### plans
`playbook_version text`, `generated_roadmap jsonb` (Playbook Engine + audit
output; shape owned by M1 at 1.1).

### tasks
`plan_id` (same-tenant **and same-client** plan — three-column FK, §4),
`module` (open set), `automation_level` (§6), `status` CHECK
`todo|in_progress|in_review|approved|published|reverted` default `todo`,
`assigned_to` (same-tenant user, nullable), `payload jsonb` default `{}` — payload
conventions are per-module and published by each module owner at 1.x; the data
layer stores them opaquely. Hot indexes: `(tenant_id, plan_id, status)`,
`(tenant_id, client_id, status)`, partial on `assigned_to`.

### audits
Immutable captures: `score jsonb`, `fixes jsonb` (aeo-audit skill output).
Property FK is same-client composite. Indexes: `(tenant_id, property_id,
created_at desc)`, `(tenant_id, client_id, created_at desc)`.

### content_items
`type` CHECK `blog|faq|caption|pillar|schema_copy`; `brand_kit_id` (same-client
kit — composite FK, §4; all content is brand-forced); `automation_level` (§6);
`body text not null` (the generated content itself);
`humanization` `{humanized, detection_score, passes}`; `quality_review` /
`compliance_review` — independent agent verdicts, NULL until reviewed;
`status` CHECK `draft|in_review|approved|published`, **default `draft`**.
**Structural review gate:** CHECK forbids `approved`/`published` unless BOTH
verdicts are non-null — publishing without review is impossible by
construction (doc 00 §7.3).

### site_changes
`method` CHECK `wordpress|webflow|wix|edge_worker|pr`; `change_type` CHECK
`h1|title|meta|schema|alt|content|canonical`; `automation_level` (**F1
addition**, §9 items 3 + 11) CHECK `ai_draft_human_approve|human_only` —
**`auto` is not representable on this table** (§6); `diff` `{before, after}`;
`applied_by` / `approved_by` — nullable same-tenant `tenant_users` actors;
`status` CHECK `previewed|applied|reverted|auto_reverted` default `previewed`;
`reverted_reason text` nullable; `applied_at` / `reverted_at` nullable
timestamps. Lifecycle CHECKs: past-preview ⇒ `applied_at` set; reverted
states ⇒ `reverted_at` set. **Structural approval gate**
(`site_changes_requires_approval`): NO change leaves `previewed` without
`approved_by` — there is no automation-level exemption. Actor FKs RESTRICT —
the audit trail keeps its humans. Indexes: `(tenant_id, property_id,
applied_at desc)`, `(tenant_id, client_id, created_at desc)`.

### visibility_results
`engine` CHECK `chatgpt|perplexity|gemini|claude|copilot|google_aio`;
`prompt text not null` (the query posed to the engine); `cited
boolean`; `position` nullable ≥ 1; `sentiment` free text (doc-silent, §9);
`cited_source` nullable (M4 input); `captured_at` — history is append-only, hot index
`(tenant_id, client_id, engine, captured_at desc)`.

### metrics
`source` CHECK `gsc|ga4|call_tracking|local_rank|reviews`; `data jsonb`;
index `(tenant_id, client_id, source, captured_at desc)`.

### alerts
`type` CHECK — doc 03's six + `auto_rollback_fired` (doc 07 §1.8 superset,
§9); `severity` CHECK `info|warning|critical` (doc-silent, §9);
`payload jsonb` default `{}` (shape owned by M17, §7);
`acknowledged` default false; partial index on unacknowledged.

## 6. automation_level semantics (doc 03 §6)

Carried by `tasks`, `content_items`, and `site_changes` (every task + every
generative action). Default everywhere: `ai_draft_human_approve`. The allowed
value set is **per-table** — CHECK-enforced, not conventional:

- **`tasks`, `content_items`** — `auto | ai_draft_human_approve | human_only`.
  Their legitimate `auto` uses are **non-publishing** (schema validation, rank
  tracking, reporting, freshness detection). An `auto` content_item still
  cannot reach `approved`/`published` without both review verdicts (gate
  below) — `auto` never shortcuts the review gate.
- **`site_changes`** — `ai_draft_human_approve | human_only` **only**.
  `auto` is structurally impossible: every `change_type` on this table is an
  on-page write, and fully autonomous publishing is prohibited (doc 00 §2,
  CLAUDE.md rule 5, doc 04 §6). Auto-rollback needs no `auto` level — it is
  expressed as `status = 'auto_reverted'`.

Value meanings (doc 03 §6): `auto` — no human needed; `ai_draft_human_approve`
— AI drafts, a human approves before anything ships (content, schema
generation, review responses, social, on-page fixes); `human_only` — genuine
community participation, compliance sign-off, strategy. Set per module per
vertical, overridable per client.

Enforcement teeth in the schema: the narrowed `site_changes` automation-level
CHECK + `site_changes_requires_approval` (**every** site change needs a
recorded `approved_by` to leave `previewed` — no automation-level exemption
exists) + the `content_items` review-verdict gate. A fully autonomous on-page
publish or unreviewed content publish cannot be represented in this schema.

> Note: the `content_items` review gate enforces verdict **presence**
> (non-null `quality_review` + `compliance_review` before
> `approved`/`published`), not verdict **pass** — pass/fail semantics are
> enforced by the reviewing agents at the app layer (lands at 1.5). Do not
> mistake the CHECK for a pass-gate.

## 7. jsonb shapes

- **`tenants.theme`** *(F1-ratified, CHECK-enforced)*:
  `{logo_url, colors, font, custom_domain}` with **snake_case** color keys
  (`surface, surface_raised, ink, muted, accent, positive, negative`) and
  `font = {display, body, mono}`. Canonical producer/declaration:
  `toTenantTheme()` / `TenantTheme` in `src/lib/skills/brand-kit/serialize.ts`
  (re-exported from `src/lib/types/db.ts`).
- **`brand_kits.tokens` / `voice_profile` / `likeness_refs`**: verbatim jsonb
  of the TS shapes in `src/lib/types/brand.ts` (`DesignTokenSet`,
  `VoiceProfile`, `LikenessRefs`) — **camelCase inside `tokens`**
  (e.g. `colors.surfaceRaised`). Do not confuse with the theme projection:
  `tenants.theme` is the snake_case *projection* of a kit; `brand_kits.tokens`
  stores the kit itself.
- **`brand_kits.assets`**: `{logo_url, ...}` (`BrandAssets`).
- **`clients.locations`**: array of `{name, address, geo}`.
- **`content_items.humanization`**: `{humanized, detection_score, passes}`.
- **`content_items.quality_review` / `compliance_review`**: opaque verdicts
  owned by the reviewing agents.
- **`site_changes.diff`**: `{before, after}`.
- **`tasks.payload`, `plans.generated_roadmap`, `audits.score/fixes`,
  `metrics.data`, `alerts.payload`**: opaque to the data layer; shape owned by
  the producing module, to be published as each module lands in 1.x.

## 8. Ratification dispositions (BUILD-STATE "pending ratification" items 1–5)

1. **`tenants.theme.font` sub-shape — RATIFIED as `{display, body, mono}`.**
   Doc 03's singular `font` is finalized as the three-face object doc 06
   requires; matches `toTenantTheme()` exactly. CHECK-enforced
   (`tenants_theme_font_shape`).
2. **`tenants.theme.colors` snake_case keys — RATIFIED.** `surface_raised`
   et al., matching `toTenantTheme()` exactly. CHECK-enforced
   (`tenants_theme_colors_shape`). No disagreement with the library's shape.
3. **Shared `AutomationLevel` — RATIFIED, created** in `src/lib/types/db.ts`
   (with `AUTOMATION_LEVELS`, role/status/value-set types, `JwtClaims`, and
   row types). aeo-audit's local copy (`src/lib/skills/aeo-audit/types.ts:19`,
   textually identical) is unified onto the shared type by its owner
   (`aeo-seo-logic-engineer`) **post-freeze** — no behavior change.
4. **`SchemaBrandContext` identity mapping — RESOLVED with one addition.**
   `SchemaBrandContext` (schema-generation) needs `{organizationName,
   websiteUrl?, logoUrl?}`; `brand_kits` carries no organization identity.
   Mapping: `organizationName ← clients.name`; `websiteUrl ← url` of the
   client's `properties` row with `type='website'`; `logoUrl ←
   brand_kits.assets->>'logo_url'` — **`brand_kits.assets` is the F1 addition**
   closing the gap (backed by doc 05 M7, which ingests the logo into the kit;
   doc 03's sketch had no home for it). The skill's own context type stays;
   callers hydrate it from these columns.
5. **Compliance-registry tenant scoping — carried as a 1.x integration
   contract line:** the compliance-ruleset registry and regex caches are
   module-level state in the 0.2 library. When wired into the app (1.5), they
   MUST be instantiated per-request or keyed by tenant — module-level mutable
   state must never leak rulesets or cached patterns across tenants. Flagged
   for the 1.x integration review; the integrating agent owns compliance
   with this line.

## 9. Doc-silent decisions made at F1 (explicit — for Orchestrator/Code Review
ratification with the freeze; none contradict docs 00–07)

1. **`platform_owner` gets zero rows via tenant-facing policies.** Doc 03 §2
   says it never bypasses tenant isolation; the conservative reading is
   implemented — platform operations go through `service_role` server-side.
   Widening later is a policy addition; narrowing later would be a breach.
2. **Write-rights split:** `clients` (and `tenants`/`tenant_users`) writes are
   `agency_admin`-only ("manage users, clients, billing"); all module tables
   are writable by `agency_admin` + `operator` ("run modules"). Doc 03 §2 does
   not enumerate per-table rights.
3. **`site_changes.automation_level` column added** so the "approval required
   for non-auto" rule is structurally enforceable (doc 03 §6 "every generative
   action"; also on `content_items`). Default `ai_draft_human_approve`
   everywhere. Value set on `site_changes` narrowed at F1 Code Review — see
   item 11.
4. **`brand_kits.assets` column added** (see §8 item 4).
5. **`alerts.type` includes `auto_rollback_fired`** — doc 03 lists six, doc 07
   §1.8 lists seven; superset taken.
6. **Value sets chosen where the doc was silent:** `clients.status`
   (`onboarding|active|paused|archived`), `alerts.severity`
   (`info|warning|critical`). `visibility_results.sentiment` and
   `tenants.plan_tier` left unconstrained (owning modules define them).
7. **No FK to `auth.users`** for `tenant_users.auth_user_id` — migrations
   never depend on Supabase-managed schemas (and the local shim provides only
   `auth.jwt()`). Uniqueness `(tenant_id, auth_user_id)` still enforced.
8. **`ON DELETE RESTRICT` everywhere** (except column-targeted SET NULL for
   `tasks.assigned_to`); site-change actor FKs RESTRICT to preserve the audit
   trail. Tenant deletion is a service-role operation with explicit cleanup.
9. **`client_viewer` uniform read rule:** read-only on ALL rows pinned to its
   `client_id` (everything its M19 dashboard needs), own tenant row, own
   membership row. Nothing else.
10. **`properties.platform` nullable** (meaningless for gbp/social), required
    for websites. **Telemetry tables** (`audits`, `visibility_results`,
    `metrics`) have no `updated_at` — they are append-only captures by
    convention (policies still allow staff corrections).
11. **F1 Code Review remediation (MAJOR 1): `site_changes.automation_level`
    narrowed to `ai_draft_human_approve | human_only`.** As first built, the
    schema permitted `automation_level='auto'` on `site_changes`, and the
    approval CHECK exempted `auto` rows from needing an approver — together a
    representable fully-autonomous on-page publish, prohibited by doc 00 §2 /
    CLAUDE.md rule 5 / doc 04 §6 (every `change_type` on this table is an
    on-page write; doc 03 §6's legitimate `auto` examples are all non-writes).
    Fix: `site_changes_automation_level_allowed` no longer admits `auto`, and
    the approval gate simplified — `site_changes_non_auto_requires_approval`
    (`status='previewed' OR automation_level='auto' OR approved_by IS NOT
    NULL`) became `site_changes_requires_approval` (`status='previewed' OR
    approved_by IS NOT NULL`): every row now requires `approved_by` to leave
    `previewed`. Auto-rollback remains fully expressible via
    `status='auto_reverted'`. Column default unchanged
    (`ai_draft_human_approve`). `tasks`/`content_items` keep `auto` — their
    `auto` uses are non-publishing (§6).

## 10. Grants, secrets, environments

- `authenticated`: per-table grants exactly matching the policy surface
  (`tenants` select+update only; everything else full CRUD, filtered by RLS).
- `anon`: **nothing** on tenant data (schema usage only).
- `service_role` (Supabase, BYPASSRLS): provisioning/deprovisioning tenants,
  platform tooling, cross-tenant ops — server-side only, never in a browser.
- Secrets: `properties.auth_ref` is a vault pointer (Supabase Vault / external
  manager, DevOps-owned). No credential-shaped columns exist anywhere.
  Third-party platform keys are environment secrets
  (`docs/ops/environments.md`).

## 11. Verification surface

- Harness + smoke suite: `supabase/tests/` (README there). `npm run
  test:isolation`; CI `isolation` job runs it against `postgres:16`.
- RLS enabled **and forced** on all 13 tables is asserted by test, not by
  convention. tenant_id NOT NULL + leading-indexed asserted per table.
- The QA agent's adversarial isolation suite (doc 03 §7 criterion 2) builds on
  `helpers/harness.ts` + `helpers/seed.ts` — every role × every table ×
  read/write, incl. sibling-client blindness for `client_viewer`.

## Changelog

- **1.0.0 — 2026-07-07 — Published (F1 freeze candidate)** by the
  `documentation` agent per doc 03 §7 freeze criterion 4, after a line-by-line
  contract ↔ SQL sync verification against `supabase/migrations/0001–0006`
  (QA isolation suite + smoke suite green at publication). Documentation-only
  sync fixes folded in — **no SQL changed**: §5 column completeness
  (`clients.name`; `tasks.plan_id`; `content_items.body` + `brand_kit_id`;
  `site_changes.applied_by` / `approved_by` / `reverted_reason`;
  `visibility_results.prompt`; `alerts.payload`) and the §5 preamble
  timestamp correction (`visibility_results` / `metrics` carry `captured_at`,
  not `created_at`). From this version, changes require Orchestrator +
  Code Review sign-off (CLAUDE.md rule 1) and a `docs/BUILD-STATE.md`
  freeze-log entry.
- **0.2 draft — 2026-07-07** — corrected by `lead-backend-data-architect`
  per the F1 Code Review gate (security + isolation, PASS with 1 major):
  **[CR-MAJOR 1]** `site_changes` can no longer carry
  `automation_level='auto'` — `site_changes_automation_level_allowed`
  narrowed, `site_changes_non_auto_requires_approval` replaced by the
  unconditional `site_changes_requires_approval`, §6 rewritten, §9 decision
  log item 11 added. Minors: §6 verdict-presence-not-pass note; §3
  claim-minting obligation on the 1.x auth layer.
- **0.1 draft — 2026-07-07** — authored by `lead-backend-data-architect` at
  build step 0.3 alongside migrations 0001–0006.
