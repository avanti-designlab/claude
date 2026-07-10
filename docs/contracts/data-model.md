# Data Model & Multi-Tenancy Contract (F1)

| | |
|---|---|
| **Version** | 1.3.0 |
| **Status** | **Published (F1 FROZEN 2026-07-08 · + governed post-freeze batch 2026-07-10, §13)** |
| **Date** | 2026-07-10 |
| **Published by** | `documentation` agent, per doc 03 §7 freeze criterion 4 |
| **Authored by** | `lead-backend-data-architect` (build step 0.3 + the 0007–0011 governed changes), corrected per the F1 + batch Code Review gates |

> **This contract is binding.** Frontend and all module agents consume it
> exactly as documented — build against this document, not against the SQL
> directly. Published after a line-by-line sync verification against the
> migrations, with the QA isolation suite and smoke suite green.
> **Post-freeze changes require Orchestrator + Code Review sign-off
> (CLAUDE.md rule 1)** and are recorded in the `docs/BUILD-STATE.md` freeze
> log. Full version history: [Changelog](#changelog) below.

Source migrations: `supabase/migrations/0001–0006` (frozen F1) + `0007/0008`
(auth claim-minting layer, §12) + `0009–0011` (governed post-freeze batch,
2026-07-10 — §13). Shared TS mirror: `src/lib/types/db.ts`. Spec:
`docs/03-data-model-and-multi-tenancy.md`.

**The one rule:** every row belongs to a tenant; no query, route, or policy may
ever let one tenant see another tenant's data. Enforced in the database (RLS on
every table, FORCED) *and* structurally (composite FKs) — application code is
never trusted alone.

---

## 1. Tenancy model

Shared database, shared schema, row-level isolation (doc 03 §1). Hierarchy:
`tenants → tenant_users / clients → properties, brand_kits, plans, tasks,
audits, content_items, site_changes, visibility_results, metrics, alerts,
competitors, runs` (the last two added by the governed post-freeze batch, §13).

## 2. JWT claim contract

Claims are set at auth time and read in policies via `auth.jwt()` (Supabase-
provided; the test harness installs an exact local shim — migrations never
create the `auth` schema). Helpers live in the `app` schema (migration 0001;
`app.user_role()` re-pointed to the `user_role` claim by migration 0008 — §12).

| Claim | Type | Semantics |
|---|---|---|
| `tenant_id` | uuid-as-text | Caller's tenant. Missing/empty ⇒ every policy is not-true ⇒ zero rows / no writes. **Fail closed.** |
| `user_role` | text | **The app role** — read by `app.user_role()`: `platform_owner` \| `agency_admin` \| `operator` \| `client_viewer`. Unknown/missing ⇒ fail closed. Carried in **`user_role`, not `role`**, because `role` is reserved (next row + §12). |
| `client_id` | uuid-as-text | Present **iff** `user_role = client_viewer`. |
| `role` | text | **PostgREST's RESERVED DB-role claim** — GoTrue sets it to `authenticated` and PostgREST does `SET ROLE <role>` off it. **Not** the app role; RLS never reads it for authorization. The auth hook leaves it untouched. |
| `sub` | uuid-as-text | Supabase auth user id (`auth.users.id`). |

TS shape: `JwtClaims` in `src/lib/types/db.ts` (app role in `user_role`; `role`
documented as the reserved DB-role claim).

## 3. Role model & RLS behavior

Postgres request roles are Supabase's `authenticated` / `anon`; the app role
travels in the JWT's `user_role` claim (never the reserved `role` claim — §2,
§12). Every signed-in tenant user hits the DB as the `authenticated` request
role. **`anon` has zero grants on tenant data.** Policies exist per command
(SELECT/INSERT/UPDATE/DELETE) — write policies are explicit, never implied.

| App role | Read | Write |
|---|---|---|
| `platform_owner` | **No rows via tenant-facing policies** (doc 03 §2: never bypasses tenant isolation). Platform tooling runs server-side under `service_role` (BYPASSRLS) with its own audit. | none via policies |
| `agency_admin` | everything in own tenant | everything in own tenant, incl. the admin-only surfaces: `tenants` (update), `tenant_users`, `clients` |
| `operator` | everything in own tenant | all module tables (`properties`, `brand_kits`, `plans`, `tasks`, `audits`, `content_items`, `site_changes`, `visibility_results`, `metrics`, `alerts`, `competitors`, `runs`); **not** `tenants` / `tenant_users` / `clients` |
| `client_viewer` | **read-only, own `client_id` only**, on every client-scoped table **except `runs`** (writer-only SELECT — ratified restriction, §13.3), plus own tenant row (white-label theme) and own `tenant_users` row | **nothing** — no write policy anywhere matches it |

Per-table summary (all policies additionally pin `tenant_id = app.tenant_id()`;
UPDATE policies re-check the pin in `WITH CHECK` so rows cannot be re-homed):

| Table | SELECT | INSERT/UPDATE/DELETE |
|---|---|---|
| `tenants` | own row, all three tenant roles | UPDATE admin only; INSERT/DELETE **service_role only** (provisioning) |
| `tenant_users` | staff: whole tenant; viewer: own row (`auth_user_id = sub`) | admin only |
| `clients` | staff: whole tenant; viewer: own client row | admin only |
| all module tables | staff: whole tenant; viewer: rows with own `client_id` | admin + operator |
| `competitors` *(0010)* | follows the module-table rule above (viewer: own client — M19 share-of-voice) | admin + operator |
| `runs` *(0011)* | **writer-only** (admin + operator) — `client_viewer` intentionally EXCLUDED (ratified, §13.3) | admin + operator |

The `client_viewer` read set intentionally covers everything its dashboard
(M19) renders: visibility, metrics, work-done log (`site_changes`), content
calendar (`content_items`), plans/tasks/audits/alerts, and (since 0010) its own
`competitors` — always pinned to its `client_id`. Sibling clients are invisible
by policy AND tested. `runs` is the one deliberate exception: the dashboard
reads finished artifacts, never the raw queue (§13.3).

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
  plans, content_items, visibility_results, metrics, alerts, tenant_users,
  competitors *(0010)*, runs *(0011)*.
- `(tenant_id, client_id, plan_id) → plans (tenant_id, client_id, id)` — tasks.
  Three-column form: the task's plan must belong to the **same client**, too.
- `(tenant_id, client_id, property_id) → properties (tenant_id, client_id, id)`
  — audits, site_changes (same-client guarantee), runs *(0011 — `property_id`
  nullable; the FK binds only when set: property-scoped kinds carry it,
  client-scoped kinds leave it NULL)*.
- `(tenant_id, client_id, brand_kit_id) → brand_kits (tenant_id, client_id, id)`
  — content_items.
- `(tenant_id, assigned_to|applied_by|approved_by|requested_by) → tenant_users
  (tenant_id, id)` — tasks (SET NULL on the single column), site_changes
  (RESTRICT — audit trail actors are never erased), content_items
  `approved_by` *(0009 — RESTRICT: approval history keeps its humans)*, runs
  `requested_by` *(0011 — SET NULL on the single column: a transient work-order
  actor, not an audit trail)*.

All FKs are `ON DELETE RESTRICT` (except the column-targeted SET NULLs on
`tasks.assigned_to` and `runs.requested_by`): destructive cleanup is an
explicit platform operation, never a cascade.

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
`todo|in_progress|in_review|approved|published|reverted|done` default `todo`
(`done` *(0013)* is legal ONLY on `automation_level='human_only'` — CHECK
`tasks_done_is_human_only`; the honest completion word, never a pipeline
terminal — §13.7), `assigned_to` (same-tenant user, nullable), `payload jsonb`
default `{}` — payload conventions are per-module and published by each module
owner at 1.x; the data layer stores them opaquely. Hot indexes:
`(tenant_id, plan_id, status)`, `(tenant_id, client_id, status)`, partial on
`assigned_to`.

### audits
Immutable captures: `score jsonb`, `fixes jsonb` (aeo-audit skill output).
Property FK is same-client composite. Indexes: `(tenant_id, property_id,
created_at desc)`, `(tenant_id, client_id, created_at desc)`.

### content_items
`type` CHECK `blog|faq|caption|pillar|schema_copy`; `brand_kit_id` (same-client
kit — composite FK, §4; all content is brand-forced); `automation_level` (§6);
`title` *(0009)* nullable, CHECK ≤200 — **no backfill**: pre-0009 rows stay
NULL and the UI renders an honest **"Untitled"**, never a title fabricated
from the body; `body text not null` (the generated content itself);
`body_hash` *(0009)* `text not null` — SHA-256 over `{title, body}`,
maintained by a BEFORE INSERT/UPDATE trigger and **never caller-set** (the
trigger is the SOLE hash producer — binding condition, §13.1);
`humanization` `{humanized, detection_score, passes}`; `quality_review` /
`compliance_review` — independent agent verdicts, NULL until reviewed (the R3
recorded shape is in §7); `approved_by` / `approved_at` *(0009)* — the named
human approver (composite FK `(tenant_id, approved_by) → tenant_users`,
RESTRICT) + server-clock stamp set by the approve action, never a caller;
`status` CHECK `draft|in_review|needs_revision|approved|published`, **default
`draft`** (`needs_revision` *(0009)* is the send-back target).
**Structural review gate (strengthened by 0009):** `approved`/`published`
requires BOTH verdicts present, **passed** (JSON boolean `true`, type-exact),
and **bound to the row's CURRENT `body_hash`**; a humanization pass for
machine prose (`schema_copy` and `human_only` exempt); and a named approver
(`content_items_approver_present`). Full CHECK semantics + the legal
transition table: §13.1. Publishing without a passed, hash-bound review is
impossible by construction (doc 00 §7.3).

### site_changes
`method` CHECK `wordpress|webflow|wix|edge_worker|pr`; `change_type` CHECK
`h1|title|meta|schema|alt|content|canonical`; `automation_level` (**F1
addition**, §9 items 3 + 11) CHECK `ai_draft_human_approve|human_only` —
**`auto` is not representable on this table** (§6); `diff` `{before, after, target}`;
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

### competitors *(0010 — governed post-freeze batch, §13.2)*
| Column | Notes |
|---|---|
| `name` | display name, CHECK 1–120 chars; **case-insensitive-unique per client** — unique index `(tenant_id, client_id, lower(name))` (a unique CONSTRAINT can't carry `lower()`; the index also serves the M4/M19 list read and satisfies the tenant_id-leading assertion) |
| `domain` | nullable **bare hostname** ("example.com" — no scheme/path/port; the real grammar is enforced at the write seam), CHECK ≤253 |
| unique | `(tenant_id, id)` anchor; composite FK `(tenant_id, client_id) → clients` |

`created_at` only — no `updated_at` (the authorized shape; the app surface is
add/list/remove, no edit). RLS enabled + forced. SELECT: staff whole-tenant,
`client_viewer` own-client via `app.client_scope` (M19 share-of-voice renders
it); writes at the `is_writer` floor. **Per-client cap 10 is APP-ENFORCED ⚑**
(`src/lib/competitors/`) — a CHECK cannot count sibling rows; test-pinned; on
the ratify list (§13.2).

### runs *(0011 — governed post-freeze batch, §13.3)*
The read-only scan work-order queue (ARCHITECTURE RULING 2026-07-10). **Table
only** — processor / `lease_next_run()` / sweeper are a separately-gated block.

| Column | Notes |
|---|---|
| `property_id` | nullable — property-scoped kinds (`audit|monitor|decay|local`) carry it; client-scoped kinds (`visibility|entity`) leave it NULL; composite FK binds only when set (§4) |
| `kind` | CHECK `audit|monitor|decay|local|entity|visibility` — one per intelligence scan module |
| `status` | CHECK `queued|running|succeeded|failed|canceled`, default `queued`; legal transitions in §13.3 |
| `attempts` | `int not null default 0`, CHECK ≥ 0 (retry counter; cap is app policy, ⚑ A6) |
| `progress` | jsonb object (CHECK), bounded + **content-free** frontier — never crawled URLs/page content (§7) |
| `heartbeat_at` | nullable — processor liveness; staleness drives the sweeper |
| `requested_by` | enqueuing operator; NULL for system/sweeper re-queues; SET NULL FK (§4) |
| `result_ref` | nullable jsonb object (CHECK) — content-free pointer to the produced artifact; NULL until succeeded (§7) |
| `error_code` | **CLOSED enum** CHECK `crawl_refused|budget_exhausted_total|engine_error|orphaned|misconfigured` — never raw error text/URLs; a second CHECK allows it **only when `status='failed'`** |

Trigger-maintained `updated_at`. Index `(tenant_id, client_id, created_at
desc)`; the cross-tenant lease index lands WITH `lease_next_run()` in the
queue-infra block. RLS enabled + forced; **SELECT is writer-only** (ratified —
§13.3); INSERT/UPDATE/DELETE at the `is_writer` floor.

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
exists) + the `content_items` review-verdict gate (0009-strengthened — §13.1) +
the `tasks` done⇒human_only coupling (0013 — the honest completion word can only
land on genuine human work, never on a machine/pipeline task; §13.7). A fully
autonomous on-page publish or unreviewed content publish cannot be represented
in this schema.

> **Note (SUPERSEDED 2026-07-10 — migration 0009, §13.1):** the
> `content_items` review gate originally enforced verdict **presence** only
> (with pass/fail semantics left to the app layer). It is now a **pass-gate
> AND a version binding**: `approved`/`published` requires both verdicts to
> CONTAIN `passed: true` (JSON boolean, type-exact — string `"true"`, number
> `1`, JSON `null` all reject) **and** the row's current `body_hash`, plus a
> humanization pass where required and a named approver. The reviewing agents
> still own verdict *production*; the DB now refuses unpassed or stale
> verdicts structurally. One thing the CHECK still does NOT gate: `automation_level='human_only'`
> exempts only the humanization leg, never the two verdicts or the approver.

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
- **`content_items.humanization`**: `{humanized, detection_score, passes}` —
  since 0009 the approval CHECK consults `passes` (must be the JSON boolean
  `true` for machine prose; `schema_copy`/`human_only` exempt — §13.1).
- **`content_items.quality_review` / `compliance_review`**: owned by the
  reviewing agents, but since 0009 no longer fully opaque — the approval CHECK
  requires each to CONTAIN `{passed: true, body_hash: <row's body_hash>}`
  (jsonb containment; extra keys are fine, subset-match is intended). The R3
  actions record `ContentReviewVerdict` (`src/lib/types/db.ts`):
  `{passed, body_hash, reviewed_by?, reviewed_at?, note?}` — `body_hash` is
  COPIED from the row as read, never recomputed (trigger-sole-producer binding
  condition, §13.1); `note` carries the send-back reason (§13.5).
- **`runs.progress`**: bounded, **content-free** progress frontier (e.g.
  `{crawled, total, phase}`) — NEVER crawled URLs or page content (honesty
  rule; `error_code` carries the only failure signal).
- **`runs.result_ref`**: content-free pointer to the produced artifact (e.g.
  `{"kind": "audit", "id": "<uuid>"}`); NULL until a run succeeds; the
  concrete shape is ratified with the queue-infra block — never raw output.
- **`site_changes.diff`**: `{before, after, target}` — `before`/`after` are the
  change payload; `target` (added by the 1.2 change-management layer, ratified
  2026-07-08 — Orchestrator + Code Review, schema-safe: the `diff_is_object`
  CHECK only requires a jsonb object) identifies the write target (URL + field)
  so a one-click rollback is executable from the audit row alone, no external
  lookup. Still opaque to the data layer.
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
- RLS enabled **and forced** on all 15 tables (13 frozen + `competitors` /
  `runs`, §13) is asserted by test, not by convention. tenant_id NOT NULL +
  leading-indexed asserted per table. The suite's all-roles future-table
  tripwire caught both new tables by design; the isolation suite stands at
  **468 tests** after the 0009–0011 extension (batch gate record, 2026-07-10).
- The QA agent's adversarial isolation suite (doc 03 §7 criterion 2) builds on
  `helpers/harness.ts` + `helpers/seed.ts` — every role × every table ×
  read/write, incl. sibling-client blindness for `client_viewer`.

## 12. Claim-minting layer (auth hook) — migrations 0007 + 0008

The upstream claim-minting obligation flagged in §3 is now **implemented** by
the Supabase Custom Access Token hook,
`auth_hooks.custom_access_token_hook(event jsonb) returns jsonb`
(`supabase/migrations/0007_custom_access_token_hook.sql`), with the app role
carried in the non-reserved `user_role` claim (migration 0008 — see the RESOLVED
note below). This is an authorized change to the frozen foundation (0001–0006
untouched), subject to the Code Review security + tenant-isolation gate.

**Contract.** On every token mint, GoTrue calls the hook with
`{ user_id, claims, ... }`. The hook:

- keys off `event->>'user_id'` (the authenticated user id — the ONLY trusted
  input) and looks up `public.tenant_users` by `auth_user_id`;
- **discards** any incoming `tenant_id` / `user_role` / `client_id` before
  deriving — so a forged/replayed/stale token can carry no app claim through
  (proven by test); it **never touches** the reserved `role` claim;
- membership found ⇒ injects `tenant_id` + `user_role` (uuid/text as JSON
  strings so the `app.*` readers' casts work), plus `client_id` **iff**
  `user_role = client_viewer` (sourced from `tenant_users.client_id`);
- **no membership ⇒ mints NO app claims** (no `user_role`/`tenant_id`/
  `client_id`) and leaves GoTrue's `role = authenticated` in place — authenticate,
  but see nothing (fail closed). A `client_viewer` therefore cannot influence its
  own tenant_id / user_role / client_id (the §3 obligation, now structural).

Multiple memberships for one user are resolved **deterministically** (oldest
`created_at`, then lowest `id`); true multi-tenant membership / tenant-switching
(a token that selects an active tenant) is a **future capability**, not yet
supported.

**Security posture.** `SECURITY DEFINER`, `search_path = ''`, in the locked-down
`auth_hooks` schema; `EXECUTE` granted to `supabase_auth_admin` only (revoked
from `authenticated` / `anon` / `public`). It reads `tenant_users` as its owner
(bypassing FORCE-RLS during minting, when there is no JWT context) — so **no**
`tenant_users` RLS policy for `supabase_auth_admin` is added, preserving the
"every policy targets `authenticated` only" invariant. **Operator action:** the
hook must be enabled in Dashboard → Authentication → Hooks; it is not
auto-enabled. See `docs/ops/environments.md`.

**App-side reading.** The verified claims are read server-side via
`src/lib/auth` (`getClaims()` / `getSession()` over supabase `getClaims()` —
verified, never `auth.getSession()`), shaped by the pure `parseSessionClaims`
into `SessionClaims { tenantId, role, clientId?, sub }` — where `role` is the
app role read from the `user_role` claim (the reserved `role` claim is ignored),
re-applying the same fail-closed rules (viewer without `client_id` ⇒ null).
Guards (`requireAuth` / `requireRole` / `requireOperator`) and `src/middleware.ts`
(refresh-only) are convenience layers **above** RLS, never a substitute for it.

> ✅ **RESOLVED — reserved `role` claim vs. PostgREST (Orchestrator +
> Code Review, 2026-07-08).** The frozen RLS originally read the app role from
> the JWT `role` claim (`app.user_role()`), which is **also PostgREST's reserved
> database-role claim** — so a logged-in supabase-js data query would
> `SET ROLE <app role>` and fail (the app roles are not grantable Postgres
> roles). **Chosen resolution — Option 2:** move the app role to the
> **non-reserved `user_role` claim**. Migration 0008 does a full
> `CREATE OR REPLACE` of `app.user_role()` to read `user_role` (no fallback to
> `role` — one source of truth); the hook (migration 0007) mints the app role
> into `user_role` and **leaves GoTrue's `role = authenticated` untouched**.
> PostgREST keeps `SET ROLE authenticated` — the request role every RLS policy
> targets and the full **399-test isolation suite** (385 frozen + 14 hook)
> exercises. **Rationale:** production stays in the `authenticated` role the
> suite proves — test fidelity was the deciding factor over introducing
> untested grantable app roles. `app.tenant_id()` / `app.client_id()` are
> unchanged. This unblocks the first logged-in data-querying UI slice. Also
> recorded in `docs/ops/environments.md` and the migration-0007/0008 headers.

## 13. Governed post-freeze schema batch — 2026-07-10 (migrations 0009–0011 + write-path contracts)

Authorized by the 2026-07-10 SCOPE AUTHORIZATION, ruled in part by the
2026-07-10 ARCHITECTURE RULING, and LANDED per the "GOVERNED POST-FREEZE
SCHEMA BATCH LANDED" gate record (all in `docs/BUILD-STATE.md`). Gate cycle:
Code Review REJECT (1 Blocker — the strengthened CHECK originally failed OPEN
on absent/JSON-null `body_hash`) and QA FAIL (same defect found
independently, proven reachable by any `is_writer` via PostgREST) →
remediated in one move (presence conjuncts + jsonb **containment**, two-valued
and type-exact) → **both PASS**; isolation 468/468, unit 2635. Frozen
migrations 0001–0008 untouched. This section is the binding contract for
everything the batch added; §§1–5 above are already synced to it.

### 13.1 content_items lifecycle (migration 0009)

One file because every item alters the SAME `content_items` CHECK set
(independent rollback of the whole content-lifecycle change; a commented
manual DOWN block reverses to the frozen 0005 shape).

- **`title`** — `text` nullable, CHECK ≤200 (`content_items_title_len`).
  **No backfill**: existing rows stay NULL; the UI renders an honest
  **"Untitled"**, never a title fabricated from the body. Title is shipped
  client-facing text (M8 compliance pre-screen input when generated; M19
  jargon rule at render) and **participates in the hash binding** — a
  post-verdict title edit invalidates verdicts exactly like a body edit.
- **`body_hash`** — `text not null`, maintained by the
  `content_items_set_body_hash` BEFORE INSERT/UPDATE trigger
  (`app.content_body_hash`). Digest — RATIFIED (Orchestrator, 2026-07-10):
  the built-in `pg_catalog.sha256(bytea)`, NOT pgcrypto's `digest()` (same
  SHA-256, no extension dependency, callable under `search_path = ''`, so
  portable across the local harness and Supabase). Input is
  `jsonb_build_object('title', title, 'body', body)::text` — NOT raw
  concatenation: JSON unambiguously separates the fields (a body can never
  impersonate the boundary) and distinguishes NULL title from empty-string
  title. Backfilled via the same function before NOT NULL took effect.
  **BINDING CONDITION of the ratification: THE TRIGGER IS THE SOLE HASH
  PRODUCER.** Application code never recomputes this hash — the verdict
  actions (`src/lib/production/review/actions.ts`) copy the row's STORED
  `body_hash` exactly as read into each verdict. A second producer would
  silently fork the binding; adding one requires the governed path.
- **`needs_revision`** — status gains EXACTLY ONE new state (the send-back
  target): `draft → in_review → {needs_revision | approved} → published`.
- **Strengthened approval CHECK** (`content_items_reviewed_before_approval`,
  replacing the frozen presence-only constraint UNDER THE SAME NAME).
  `approved`/`published` requires, ALL structurally, fail-closed:
  - `quality_review is not null` AND
    `quality_review @> jsonb_build_object('passed', true, 'body_hash', body_hash)`;
  - the same pair for `compliance_review`;
  - humanization matrix: `humanization is not null AND humanization @>
    '{"passes": true}'` for machine-produced prose
    (`blog | faq | caption | pillar`); **EXEMPT for `type='schema_copy'` and
    for `automation_level='human_only'`** (the exemption covers ONLY the
    humanization leg — never the verdicts or the approver).
  - `draft | in_review | needs_revision` are unconstrained by this gate.

  **Why containment (the Blocker remediation + Orchestrator-directed type
  tightening):** a Postgres CHECK passes on TRUE **or NULL**, and plain `=`
  propagates NULL — so the first draft failed OPEN on hashless verdicts.
  jsonb `@>` over non-null operands is two-valued and TYPE-EXACT: `passed`
  must be the JSON boolean `true` (string `"true"`/`"t"`/`"1"`, number `1`,
  JSON `null` all FAIL); `body_hash` must be PRESENT and equal (an omitted
  key or JSON null yields FALSE, never NULL — an absent hash is not a bound
  hash); no `::boolean` text-cast anywhere (casts accept truthy strings and
  can raise). Extra verdict keys are fine — subset-match is intended.
  **Consequence for verdict writers:** any body OR title edit re-hashes the
  row and structurally invalidates prior verdicts; re-review is required to
  re-approve.
- **`approved_by` / `approved_at`** — the named human approver (CLAUDE.md
  rule 5; the `site_changes.approved_by` precedent). Composite FK
  `(tenant_id, approved_by) → tenant_users (tenant_id, id)` ON DELETE
  RESTRICT (approval history keeps its humans). Separate CHECK
  `content_items_approver_present`: no `approved`/`published` row without
  `approved_by`. `approved_at` is set by the approve action from the server
  clock, never by a caller.

**The full legal transition table** (engine:
`src/lib/production/review/transitions.ts` — pure, mirrors the CHECK
one-for-one, pinned by tests; the DB CHECK stays authoritative):

| From | To | Driver | Notes |
|---|---|---|---|
| `draft` | `in_review` | producer submit (M8/M9 path, pre-existing) | |
| `in_review` | `needs_revision` | **send-back** (R3) | reason REQUIRED, recorded as the failing gate verdict's `note` (§13.5) |
| `in_review` | `approved` | **approve** (R3) | every gate condition + the named approver |
| `needs_revision` | `in_review` | **resubmit** (R3) | prior verdicts left in place — stale by hash, structurally unable to approve |
| `approved` | `published` | **NOT WIRED** | publish stays behind change management (rule 4); no publish wiring authorized in this batch — and see the §13.6 linkage precondition |
| edit while `draft` | `draft` | revise (R3) | |
| edit while `in_review` / `needs_revision` / `approved` | `needs_revision` | revise (R3) — **demote-before-edit** | the trigger re-hashes; prior verdicts go structurally stale |
| edit while `published` | — | **illegal** — revise refuses | re-publishing is a change-management concern |

Verdicts may be recorded ONLY while `in_review`.

### 13.2 competitors (migration 0010) — NEW table

Shape, keys, and RLS posture in §5. Contract highlights:

- **Why a table:** jsonb-on-`clients` was REJECTED — write-floor mismatch
  (competitor management is operator work at the `is_writer` floor; `clients`
  writes are admin-only) and both consumers (M4 share-of-voice, M19
  dashboard) need queryable rows.
- **Unique key:** one competitor NAME per client, case-insensitive — unique
  index `(tenant_id, client_id, lower(name))`; duplicate inserts surface as
  23505 → the app's `duplicate` refusal.
- **Cap 10 per client — APP-ENFORCED ⚑** at the write seam
  (`src/lib/competitors/actions.ts`, `COMPETITORS_PER_CLIENT_CAP`): a CHECK
  cannot count sibling rows. Test-pinned; known accepted race (two
  truly-concurrent adds can both pass the count — same class as `ensurePlan`);
  the value is on the ⚑ ratify list.
- **RLS:** enabled + forced; `client_viewer` reads its OWN client's
  competitors (`app.client_scope` — M19 renders share-of-voice); writes
  (insert/update/delete) at the `is_writer` floor. Write seam guards with
  `requireOperator()`, reads with `requireAuth()` — RLS is the real gate.
- **Domain grammar** (write seam, `src/lib/competitors/validate.ts`): bare
  hostname only — full http(s) URLs are reduced to their hostname; anything
  with a path/port/space refuses; trailing FQDN dot tolerated; the DB CHECK
  (≤253) is the backstop.

### 13.3 runs (migration 0011) — NEW table

Shape in §5. Contract highlights:

- **SCOPE INVARIANT (ruling):** a `runs` row is a READ-ONLY scan work-order.
  It must NEVER vehicle a client-site write — writes stay behind
  change-management (`site_changes`, rule 4). Nothing in the migration
  references or enables a write path.
- **Writer-only SELECT — RATIFIED (Orchestrator, 2026-07-10):**
  `client_viewer` is intentionally EXCLUDED — the client dashboard reads
  finished artifacts (`audits`, `visibility_results`, `metrics`), not the raw
  queue; `runs` carries `client_id` for tenant-consistency + filtering, like
  `tenant_users` carries it without being a viewer surface. This is a
  ratified **deviation-by-restriction** from the §9-item-9 uniform viewer
  read rule (more restrictive — cannot leak). Widening to `app.client_scope`
  requires the governed post-freeze path.
- **Closed `error_code` enum** (`crawl_refused | budget_exhausted_total |
  engine_error | orphaned | misconfigured`) — never raw error text or URLs;
  CHECK-limited to `status='failed'` (no failure signal may hide on a
  non-failed row).
- **Legal transitions** (pinned in `src/lib/runs/transitions.ts` + test;
  enforced by the future queue actions — the DB stores states honestly, the
  graph is app-logic): `queued → running` (processor lease);
  `queued → canceled` (operator cancel, CAS on queued — the only cancel until
  a real mid-run cancel exists); `running → succeeded | failed` (processor);
  `running → failed` **by the sweeper only** for the stale-heartbeat case;
  retry re-queues the SAME row (`failed → queued`, `attempts+1`, to a cap ⚑
  A6); an operator re-run is a NEW row, never a terminal reopen;
  `succeeded`/`canceled` are terminal and immutable, `failed` terminal except
  the bounded retry.
- **Deferred to the separately-gated queue-infra block (ruling A8):** the
  processor, `SECURITY DEFINER lease_next_run()` (the ONLY permitted
  service-role-class op on the run path, per A1), the sweeper, the
  cross-tenant lease index (`FOR UPDATE SKIP LOCKED` support), and the
  concrete `result_ref` shape. Gate: Code Review + a QA adversarial
  concurrency/recovery suite.

### 13.4 properties write-path contract (NO schema change)

The frozen 0003 shape was verified sufficient — no migration. Two seams:

- **`ensureWebsiteProperty`** (`src/lib/clients/properties.ts`) — the
  onboarding property-row half, idempotent on BOTH the fresh and the
  23505-replay path. Replay semantics (CRITICAL scope condition,
  test-pinned): read the client's existing website properties oldest-first →
  **none** ⇒ INSERT (`connection_method='none'`, no `auth_ref`); **exact
  url+platform match** ⇒ return it untouched; **diverged** ⇒ UPDATE-THROUGH
  the oldest (onboarding) row to the resubmitted values — a divergent replay
  never strands a stale URL. Known accepted race: no per-client unique
  constraint, so two truly-concurrent submits can double-insert; sequential
  lost-response retries (the case idempotency closes) are fully idempotent.
  Any failure returns `ok:false` → the caller surfaces an honest
  partial-success warning (client saved, property not), never silent success.
- **Workspace seam** (`src/lib/properties/`) — operator create/edit of a
  client's website property (`type` pinned to `'website'`, so the frozen
  `properties_website_has_platform` CHECK requires the validated platform).
  **NO DELETE v1** — properties are ON DELETE RESTRICT FK parents (audits,
  site_changes, runs); deletion is deferred to the Connections/lifecycle
  block. Guard `requireOperator()` mirrors the `is_writer` RLS floor.
- **`connection_method` locked to `'none'`** at every seam — never written
  connected-looking without a real connection; `auth_ref` is NEVER written by
  these seams (doc 03 §5). The Connections block owns transitions to
  connected values, alongside a real vault `auth_ref`.
- **Terminology correction — BINDING (Orchestrator REDIRECT, 2026-07-10):**
  **`'pr'` in `properties.connection_method` (and `site_changes.method`) is
  the Git/pull-request write method of doc 04** — one of the four auto-fix
  write methods, alongside `api` and `edge_worker`. It is **NOT
  press-release outreach** (that is M12 and has nothing to do with this
  column). The press-release misreading was scrubbed from the batch;
  hand-setting `'pr'` is refused like every connected value until its wiring
  block lands. Do not re-propagate the misreading — cite this section.

### 13.5 R3 review-lifecycle action contracts (`src/lib/production/review/`)

Server actions (the HUMAN approval seam — AI drafts, humans approve). Shared
posture: tenant scoping is CLAIM-SOURCED (browser sends only ids + the
verdict/reason/edit); guard `requireOperator()` mirrors the `is_writer` RLS
floor; **reviewer/approver identity is resolved from the verified `sub` via
`tenant_users` — never caller-supplied**; every action returns
`ReviewActionResult` (`ok` + new status, or a named refusal reason with
interface-voice copy); the transitions engine gives honest pre-write refusals
and the DB CHECKs stay the authoritative gate (a lost race surfaces as
`write_failed`, never a bypass).

| Action | Transition | Contract |
|---|---|---|
| `recordQualityVerdict` / `recordComplianceVerdict` | none (verdict write, `in_review` only) | Persists the GATE's decision (`passed: boolean` is passed in — never synthesized here); records `{passed, body_hash, reviewed_by, reviewed_at, note?}` with `body_hash` **copied from the row as read** (trigger-sole-producer binding condition); `note` ≤2000 |
| `approveContentItem` | `in_review → approved` | Pre-checks the full gate (mirrors the CHECK, names the first blocker: missing/not-passed/stale per gate, humanization); stamps claim-resolved `approved_by` + server-clock `approved_at` |
| `sendBackContentItem` | `in_review → needs_revision` | `gate` (`quality`\|`compliance`) + **`reason` REQUIRED** (bounded ≤2000) — RATIFIED: no dedicated send-back column; the send-back IS a real **failing verdict** (bound to the reviewed hash) with the reason as its `note`, plus the demotion, in ONE write |
| `resubmitContentItem` | `needs_revision → in_review` | Prior verdicts left in place — stale by hash, structurally unable to approve until fresh verdicts land |
| `reviseContentDraft` | demote-before-edit (table in §13.1) | The one legal body/title edit path; `title: null` clears to "Untitled"; body ≤200k seam cap (column uncapped — flagged); refuses on `published` |

**Gate conditions attached to R3 (binding):** the Review & Approvals UI must
RENDER the send-back note(s) bound to `needs_revision` rows (Orchestrator
binding condition). Publish is NOT wired (§13.1 + §13.6).

### 13.6 Carried preconditions (data-model relevant)

- **Publish wiring must add change-management linkage:** `'published'` is
  app-unreachable today but NOT DB-gated on change-management linkage — when
  the publish path is wired, rule-4 linkage (change-log/diff/rollback) MUST
  be enforced (QA observation; joins the R3/publish precondition set).
- **Reviews home DEFERRED — explicit ruling:** no raw-reviews schema before
  vendor semantics are known (rule 7). Aggregate signal stays in
  `metrics(source='reviews')`; the reviews-home decision is a **named
  prerequisite of the review-platform vendor-wiring block**, and no
  reply-send wiring passes review until a persisted status-bearing gate
  record exists (M15 Compliance precondition).
- **⚑ Ratify at wiring:** competitors per-client cap 10 (§13.2); runs queue
  thresholds (heartbeat/orphan/attempt-cap — ruling A6) at the queue-infra
  wiring review.
- **CR minors (optional hardening, non-gating):** control-char stripping in
  the competitors/properties validators; M19 "In revision" label copy → next
  Design Review.

### 13.7 tasks status lifecycle (migration 0013)

Authorized by the 2026-07-10 "PLAN TAB DEEP BUILD SHIPPED" gate record
(ORCHESTRATOR RULINGS 1 + 2, `docs/BUILD-STATE.md`). Governed post-freeze change
(CLAUDE.md rule 1); frozen migrations 0001–0012 untouched. doc 03 §3/§6.

- **`done` joins the status enum** — the ONLY change to the value set:
  `todo | in_progress | in_review | approved | published | reverted | done`. It
  is an honest, human-owned completion word (a plain "I finished this task"),
  NOT a pipeline terminal: `approved`/`published` stay the load-bearing AUDIT
  vocabulary (the content-review + change-management terminals, rules 3–5), and
  `done` must never overload them.
- **`done` is legal ONLY on `automation_level='human_only'`** — narrow
  structural CHECK `tasks_done_is_human_only`
  (`status <> 'done' OR automation_level = 'human_only'`). A machine-owned
  (`auto`) or pipeline (`ai_draft_human_approve`) task can never be `done`.
  Two-valued/fail-closed (both columns NOT NULL, so the CHECK is never NULL).
  Enforced on the INSERT **and** UPDATE routes, below RLS — QA blessing tests
  (`supabase/tests/isolation/structural-gates.test.ts`), the F1
  automation-CHECK precedent.
- **NO transition trigger** (contrast `runs_transition_guard`, 0012 — the
  Orchestrator ruled the FSM treatment unwarranted here). `done` is REVERSIBLE
  work-tracking (done ⇄ in_progress, "Reopen"), not a verdict; edge legality is
  app-logic (`src/lib/plans/task-status.ts` — ONE edge table drives both the UI
  and the `updateTaskStatus` CAS). The migration constrains only the value SET
  and the done⇒human_only coupling — exactly what must hold regardless of app
  code.

**The legal MANUAL transition table** (pure engine
`src/lib/plans/task-status.ts`, re-enforced by the `updateTaskStatus` CAS; the DB
constrains the value set + the done⇒human_only coupling, never the edges):

| From | To | Levels | Control | Notes |
|---|---|---|---|---|
| `todo` | `in_progress` | human_only, ai_draft_human_approve | "Start task" | gate-free work-tracking |
| `in_progress` | `todo` | human_only, ai_draft_human_approve | "Move back to to-do" | reversible |
| `in_progress` | `done` | **human_only ONLY** | "Mark done" | completion; never a review approval |
| `done` | `in_progress` | **human_only ONLY** | "Reopen" | reversible — `done` is not a terminal |

`auto` tasks offer NO manual control. `in_review | approved | published |
reverted` are NEVER a manual target for any level — pipeline/gate words are never
a free-form task write, refused pre-DB by `isLegalManualTarget`. **ai_draft
work-tracking is bounded** (ruling 2): no pipeline writer moves these tasks off
`todo` yet, so hand-tracking `todo ⇄ in_progress` is honest; `done` stays
structurally excluded; and a recorded **wiring-time condition** stands — when the
pipeline→task writer lands, its gate must define how this manual state reconciles
with the pipeline's own status writes. The `updateTaskStatus` CAS re-pins
`automation_level IN (levels)` + `status IN (sources)` per target; the level union
for the `in_progress` target is sound because `done` is human_only-only in the DB
(an ai_draft row can never occupy the `done` source), with the 0013 CHECK the
authoritative backstop.

## Changelog

- **1.4.0 — 2026-07-10 — tasks `done` status (migration 0013) — governed
  post-freeze change (Orchestrator ruling; gates: Code Review + QA isolation
  blessing tests + this contract sync).** `done` joins the tasks status enum
  (the ONLY value-set change) fenced by `tasks_done_is_human_only`
  (`status <> 'done' OR automation_level = 'human_only'`) so the honest
  completion word can never bypass the approved/published pipeline terminals; NO
  transition trigger (reversible work-tracking, ruled). The manual action
  (`updateTaskStatus`, `src/lib/plans/task-status.ts`) extends: `human_only`
  gains `in_progress ⇄ done`; `ai_draft_human_approve` gains `todo ⇄ in_progress`
  (bounded work-tracking, recorded pipeline-reconcile condition); `auto`
  immovable. New §13.7 (value-set change + the coupling CHECK + the manual
  transition table); `### tasks` synced; `TASK_STATUSES` mirror + the plan/
  dashboard status labels gained `done`. Isolation 536 (530 + 6 blessing tests);
  unit 2793. Frozen migrations 0001–0012 untouched.
- **1.3.0 — 2026-07-10 — Governed post-freeze schema batch (migrations
  0009–0011 + write-path contracts) — SIGNED OFF (Orchestrator + Code Review
  PASS + QA PASS 468/468).** New §13 (the binding contract for the batch);
  §§1, 3, 4, 5, 6, 7, 11 synced. **0009 content_items:** `title` (≤200,
  nullable, no backfill — "Untitled" render rule), trigger-maintained
  `body_hash` (pg_catalog.sha256 over `jsonb_build_object('title','body')`;
  **the trigger is the SOLE hash producer** — binding condition),
  `needs_revision` status, the strengthened fail-closed approval CHECK (jsonb
  containment: boolean-true + exact hash binding; humanization matrix with
  `schema_copy` + `human_only` exemptions — supersedes the §6
  presence-not-pass note), `approved_by`/`approved_at` + approver-present
  CHECK + composite FK. **0010 competitors** (new table; cap-10
  app-enforced ⚑). **0011 runs** (new table; writer-only SELECT ratified;
  closed `error_code` enum; lease/processor/sweeper deferred to the
  queue-infra block). **Properties write path** (no schema change:
  `ensureWebsiteProperty` replay semantics, workspace create/edit, no delete
  v1, `connection_method` locked to `'none'`; **`'pr'` = the Git/pull-request
  write method, NOT press-release** — Orchestrator REDIRECT encoded in
  §13.4). **R3 lifecycle actions** documented (§13.5) incl. the full legal
  transition table with demote-before-edit; publish NOT wired. Carried
  preconditions recorded in §13.6 (publish→change-management linkage;
  reviews-home deferred to the review-platform vendor block). Authored by
  `lead-backend-data-architect`; synced by the `documentation` agent per the
  batch gate record ("required before batch declared fully done").
- **1.2.0 — 2026-07-08 — Reserved-`role`-claim collision RESOLVED (Option 2),
  pending Code Review gate.** The app role now travels in the **non-reserved
  `user_role` claim** instead of PostgREST's reserved `role` claim. Migration
  **0008** re-points `app.user_role()` to read `user_role` (full switch, no
  `role` fallback — one source of truth); migration **0007** (same in-flight
  auth layer, edited in lockstep) mints the app role into `user_role`, strips any
  incoming `user_role`/`tenant_id`/`client_id`, and leaves GoTrue's
  `role = authenticated` untouched; no-membership mints no app claims (fail
  closed). PostgREST keeps `SET ROLE authenticated` — the request role every RLS
  policy targets and the whole isolation suite exercises; no grantable app
  Postgres roles introduced (test fidelity was the deciding factor). Updated §2
  (claim table now distinguishes `user_role` from the reserved `role`), §3, §12
  (⚠️ OPEN item → ✅ RESOLVED). Coordinated rename across `app.user_role()`, the
  hook, the harness `claimsFor`, `PgChangeStore`, `JwtClaims`, `parse-claims`,
  and their tests; **all 399 isolation tests (385 frozen + 14 hook) pass on the
  new claim**, `npm test` green. Authored by `lead-backend-data-architect` per
  the Orchestrator's escalation resolution; to be synced/ratified by the
  `documentation` agent on Code Review sign-off. `app.tenant_id()` /
  `app.client_id()` and migrations 0001–0006 unchanged.
- **1.1.0 — 2026-07-08 — Auth claim-minting layer (migration 0007), pending
  Code Review gate.** Added §12 documenting
  `auth_hooks.custom_access_token_hook` — the server-side implementation of the
  §3 claim-minting obligation: tenant claims are minted from `tenant_users`
  keyed off the authenticated user id, forged input is discarded/re-derived,
  no-membership fails closed. Authored by `lead-backend-data-architect` as an
  authorized additive change (0001–0006 unchanged); the existing 385 isolation
  tests stay green, +14 hook security tests added. Carries one OPEN item
  escalated to Orchestrator + Code Review (reserved `role` claim vs. PostgREST).
  To be synced/ratified by the `documentation` agent on Code Review sign-off.
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
