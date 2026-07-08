# BUILD-STATE — live task board
### Maintained by: lead-architect-orchestrator (state) + documentation (freeze log)

> The Orchestrator drives from `07-build-sequence-and-execution-checklist.md`. This file records where the build actually is. Do not cross a 🔒 gate marked ⏸ below.

## Current stage: **PHASE 1 OPEN — Freeze Gate 0 passed 2026-07-08 (operator signed off F1 + F2). Foundation frozen. F1 schema APPLIED to the operator's live Supabase project (verified: 13/13 tables, RLS enabled + forced).**

> **Provisioning note (2026-07-08):** the frozen F1 foundation schema (migrations 0001–0006) was applied to the operator's live Supabase project via the SQL Editor (the remote build environment's network policy blocks direct DB access, so the operator ran a combined script). Verified live: all 13 public tables present with `relrowsecurity` AND `relforcerowsecurity` = true. App-runtime connection secrets (`NEXT_PUBLIC_SUPABASE_URL`, anon key, etc.) to be wired when the first data-backed screen is built. Network policy note: this environment blocks outbound to Supabase/Vercel/GitHub API; allowlisting `*.supabase.co` would let the orchestrator manage the DB directly (operator/admin change).

| Step | Item | Owner | Gate | Status |
|---|---|---|---|---|
| 0.0 | Agent team + 4 skills operationalized (doc 01) | operator + orchestrator | — | ✅ Done (2026-07-07) — 12 agents in `.claude/agents/`, 4 skills in `.claude/skills/` |
| 0.1 | Project scaffold (Next.js + Supabase + Vercel, CI/CD, staging/prod, secrets, CF Workers readiness) | devops-deployment | Code Review | ✅ Done (2026-07-07) — Code Review **PASS** (see gate record below); operator-side provisioning steps listed in `ops/environments.md` |
| 0.2 | 4 skills implemented + tested in isolation (gate tests the LIBRARY, per resolution 3) | build agents | Code Review + QA | ✅ Done (2026-07-07) — gate CLOSED after remediation + green re-verification (see gate record) |
| 0.3 | Multi-tenant data model (F1) | lead-backend-data-architect | Code Review (security+isolation) + QA isolation suite | ✅ Done (2026-07-07) — **GATE CLOSED**, doc 03 §7 criteria 1–5 all MET (see gate record); freeze declaration awaits operator at Freeze Gate 0 |
| 0.4 | Design system + theming (F2) | lead-ui-ux-designer | Design Review + **operator sign-off** (resolution 4b) | ✅ Done — Design Review passed, B1 blocker fixed + re-review CLEARED (369 tests), **operator signed off 2026-07-08. FROZEN.** |
| 🔒 | **FREEZE GATE 0** — foundation frozen | orchestrator | all of 0.2–0.4 passed; F1 + F2 presented to operator | ✅ **PASSED 2026-07-08** — operator signed off both F1 and F2 after a local walkthrough. Foundation FROZEN; changes now require Orchestrator + Code Review sign-off. |
| 1.1 | Industry Playbook Engine (M1) — build first | aeo-seo-logic-engineer | Code Review + Content Quality | ⏭️ Next up — Phase 1 open |
| 1.x | Remaining Phase 1 feature work | (per doc 07) | (per doc 07) | ▶️ Unblocked |
| 1.1 | Industry Playbook Engine (M1) + onboarding flow | aeo-seo-logic-engineer (+frontend/designer) | Code Review + Content Quality | ✅ Done (2026-07-08) — both gates PASS; M1b deferred to M18-infra availability (see gate record) |
| 1.2 | Change-management layer + provider-agnostic connector interfaces | integrations-engineer | Code Review (rollback safety) + QA (rollback suite) | 🔨 Opened 2026-07-08 |
| 🔒 | **GATE 1a** — single-vertical validation (real estate, GG as client zero, full loop end-to-end) | orchestrator | loop proven + case-study metrics | 🚫 Not reached |
| 🔒 | **GATE 1** — Phase 1 ships multi-vertical | orchestrator | validated loop across seed verticals + M1b active | 🚫 Not reached |

## Post-freeze foundation changes (require Orchestrator + Code Review sign-off — CLAUDE.md rule 1)

**2026-07-08 · F2 token-system extension: add a SECONDARY + WARM accent · Orchestrator AUTHORIZED · Code Review → PASS (0 blockers, 0 majors, 1 minor)**
Code Review CLOSED the change: confirmed truly additive (7 frozen tokens byte-unchanged; theming engine, 5 moments, component library untouched), B1 CSS-injection defense intact for the new token paths (14 hostile `accent_secondary`/`accent_warm` payloads — brace-breakout, `</style>`, `url()`, `expression()` — all caught by the hex gate → Signal fallback), accessibility gate correctly applied (Alachua `#f4a200`→`#c18000` real + reported; Core Orange `#fc4c14` genuinely at ~3.14:1, gated not waved through), backward-compatible (pre-existing tenant rows without the fields still resolve via Signal default). Minor (stale `serialize.ts` header comment) fixed. **The two-accent extension is signed off.** Note: this does NOT re-freeze F2 — the operator's brand look itself is still a first pass awaiting operator reaction; a re-freeze of the operator theme happens only on operator sign-off.
Original authorization:
Reason: the operator's real brand (tenant #1, `docs/design/operator-brand.md`) has **two** headline colors — Core Blue `#1B2FCE` (primary) and Core Orange `#FC4C14` (secondary/energy) — plus Alachua `#F4A200` (warm) and Dark Blue `#0A1C46`. The frozen F2 token set carries a single `--accent`. To represent the brand faithfully, the token system is extended **additively**: add `--accent-secondary` and `--accent-warm` to `ColorTokens`/`DesignTokenSet` + `buildBrandKit` (accessibility-gated like the existing accent) + `toCssVariables`. The existing 7 tokens, the theming engine, the 5 moments, and the component library are unchanged; this is purely additive. Owner: `lead-ui-ux-designer`. **Not "done" until Code Review signs off** (security + no-regression on the frozen brand-kit skill) — this is the sanctioned controlled-change path, not a re-opening of the freeze. Reconciliation: the operator's brand guide is authoritative; the earlier Webflow-blue proxy (`#146EF5`) is discarded.

## Gate records

**2026-07-08 · 1.1 Industry Playbook Engine + onboarding · Code Review → PASS (0 blockers, 0 majors, 7 minors) · Content Quality → PASS (gate cleared) · 1.1 CLOSED**
Scope: 5 seed playbooks (doc 02-faithful, test-pinned incl. Gate 1a `ACTIVE_VERTICALS=["real-estate"]`), real plan generator (proportional channel allocation, deterministic — 50-run byte-identity probed; doc 03 §6 automation clamp verified on M10/M13), onboarding flow (dormant-vertical gate enforces Gate 1a in code; truth-aligned copy), 557/557 tests. Frozen-file string touch (onboarding-plan-reveal default subheading) EXPLICITLY SIGNED OFF (verified one-line diff). Post-freeze additions confirmed contract-preserving: dualModeTenantCss (both-or-nothing fallback; 12 hostile payloads refused — B1 lineage holds, verified against React 19 raw <style> rendering), entrance choreography (SSR-identical by construction, dual reduced-motion gates), mode toggle. Two independent gates converged on the same stub-generator bug earlier in the cycle — governance working as designed.
**Carried open items (non-gating, owners assigned):** [aeo-seo-logic-engineer] broaden auto-clamp beyond M10/M13 to all non-detection modules; stale RED docblock in audit-merge.test.ts; asAuditResult element validation; duplicate impact wording on audit-merged tasks (MUST land before audit path is user-visible in 1.2); schema_profile in one evidence string; module codes in operator diagnostics (before client-visible audit UI); nap_directories provenance comments; vertical-tuned audience nouns when dormant verticals activate. [designer/frontend] newline in scope-id sanitization (fold into existing F2 defense-in-depth ticket); entrance.tsx header comment (box-shadow bloom); mode-toggle external-writer desync; optional "we'll flag you" → "we'll let you know".
**M1b Playbook Generator:** deliberately deferred within 1.1 — needs the M18 Claude+web-search stack (Anthropic API key not yet provisioned); built when M18 infrastructure lands, activated only after Gate 1a per doc 07.


**2026-07-08 · Operator brand v1 consolidated app-wide (dual-palette) + motion signature · post-freeze additions logged**
Operator decisions: pass-3 blue-depth look adopted; BOTH palettes kept as the app's light/dark modes; structure locked (roles: primary blue, highlight cyan, red = urgency, glow language, Geist, hero bubble), VALUES float (font/color changes remain cheap; additive-color path proven). Implemented via additive `dualModeTenantCss` formatter — frozen engine/token contract byte-untouched; Signal fallback preserved both modes. Pass-2 Core Orange/Alachua retained as available accents, not leading.
**Post-freeze motion addition (operator-directed):** entrance choreography as the brand motion signature, framed inside frozen moment #5 — rise 14px + fade 520ms cubic-bezier(0.22,1,0.36,1), 90ms sibling stagger, hero glow bloom 800ms @ +420ms, counters/gauge +400ms after tile entry; pure CSS, SSR-identical markup, transforms/opacity only, dual reduced-motion gates (verified: instant final states). Logged against the freeze record per governance; code-review coverage folds into the 1.1 gate.
Phase-1 flag (standing): dual-palette `tenants.theme` schema extension owned by lead-backend-data-architect at M7.


**2026-07-07 · 0.4 F2 design system · Code Review (code quality/security, per CLAUDE.md rule 3) → REJECT (1 blocker, 4 minors) → remediated → re-review CLEARED**
Design Review (self-owned) passed; re-skin/token-parity/reduced-motion all verified genuine. Hostile-input probing found **[B1 BLOCKER] stored CSS injection via tenant font stacks** — font strings reached the emitted `<style>` verbatim on the white-label production path; a `}` breaks out of the rule and injects app-wide CSS for every viewer of that tenant. Confirmed with three live payloads.
**Remediation:** font-grammar whitelist gate (`src/lib/skills/brand-kit/font-stack.ts`) in the shared `resolveAndValidateTokens` pipeline — hostile stacks throw → Signal fallback (matches malformed-color behavior), covering both the `<style>` string sink and the inline-style path, and both `buildBrandKit` + `reviseKit`. 17 regression tests + doc correction.
**Focused re-review 2026-07-07: B1 CLEARED.** All three original exploits + a broad bypass hunt (CSS `\7d` escapes, NBSP, zero-width, RTL override, fullwidth punctuation, `expression(`, 5000-char stack) defeated against the real bundled engine — no run emits a second `{`/`}`, `<`, or `url(`; legit stacks byte-unchanged. 369 unit tests green. Latent sibling (hostile `typography.scale` via future M7 direct `buildBrandKit`, unreachable via `tenants.theme`) confirmed out of scope → Phase-1 follow-up ticket. **F2 code side clear for operator sign-off; freeze awaits operator (resolution 4b).**
Minors carried to Phase 1: named-CSS-color test guard, id-sanitization defense-in-depth, logo_url/custom_domain untrusted-field note, typography.scale grammar gate before M7.

**2026-07-07 · 0.3 F1 data model · QA isolation suite → GREEN (360/360, zero successful attack vectors) · Code Review (security + isolation) → PASS (0 blockers, 1 major, 3 minors)**
Security/isolation core SIGNED OFF: no cross-tenant leak, no unforced RLS, under 360 suite tests + 13 independent reviewer probes (composite-FK attacks, re-homing, forged claims, verdict-nulling sneak-past — all blocked). Freeze criteria 1–3 MET; criterion 4 PARTIAL (contract must be corrected + published by documentation agent); criterion 5 security portion signed off.
**[CR-MAJOR 1]** Schema permitted `automation_level='auto'` on `site_changes` (a fully-autonomous on-page publish path), contradicting doc 00 §2 / CLAUDE.md rule 5 / doc 04 §6 — and the DRAFT contract overclaimed that the schema prevented it. Disposition: docs are not silent → CHECK constraint excluding 'auto' from site_changes + contract §6 correction, dispatched to lead-backend-data-architect 2026-07-07; QA updates its blessing test; documentation agent publishes corrected contract; focused re-review then closes the gate. Surfaced for operator ratification at Freeze Gate 0 regardless.
**Remediation complete 2026-07-07:** CHECK landed (`site_changes_automation_level_allowed` excludes 'auto'; approval gate simplified to `site_changes_requires_approval`, no exemptions); QA suite updated and green at **363/363** (supersedes the 360 pre-remediation count — the exemption blessing became four prohibition tests, future-table tripwire now sweeps all four roles); contract corrected + **published v1.0.0** by documentation agent (criterion 4 MET; sync-verified against SQL, two §5 drift items fixed); TS mirror narrowed (`SiteChangeAutomationLevel` excludes 'auto') per documentation escalation, applied by orchestrator.
**Focused re-review 2026-07-07: PASS — GATE CLOSED.** Zero findings remaining. Original MAJOR 1 construction re-attempted on a fresh scratch DB as superuser: rejected on both INSERT and UPDATE routes; full auto-rollback lifecycle still expressible. All five doc 03 §7 freeze criteria explicitly MET. Freeze declaration reserved for the operator at Freeze Gate 0.
Minors: verdict-presence-not-pass note (contract), client_id claim-minting obligation line (contract), all-roles future-table tripwire (QA).

**2026-07-07 · 0.2 Skill libraries · Code Review → PASS (0 blockers, 3 majors, 7 minors) · QA → GAPS-FOUND (2 criticals, 4 minors)**
Suites at review time: 293/293 across 20 files; isolation verified empirically (suites pass with no network namespace); all four SKILL.md hard rules survived adversarial probing. Gate held open pending disposition of: [QA-C1] schema-generation rejection path untested → tests being added; [QA-C2] NaN channel-weight bug in aeo-audit fix prioritization → `Number.isFinite` fix + regression test; [CR-M1] `reviseKit` bypasses build-time structural validation → unified validate pipeline; [CR-M2] compliance seed-vertical overwrite + zero-rules-evaluated pass → overwrite protection + empty-ruleset fails closed; [CR-M3] public `serializeToScriptBlock` accepts rejected drafts → type-restricted to ready results. All five + gate minors dispatched 2026-07-07 to owning agents (schema-generation/aeo-audit → aeo-seo-logic-engineer; brand-kit → lead-ui-ux-designer; compliance → content-production-engineer).
**Gate CLOSED 2026-07-07:** all 5 criticals/majors + all minors remediated and regression-tested (regressions verified to fail pre-fix where applicable); re-verification green — 329/329 tests across 23 files (schema-generation 70, aeo-audit 81, brand-kit 87, compliance 91), lint/typecheck/build clean. One shared-contract change (`SpacingTokens.steps` → readonly) applied with orchestrator sign-off per escalation protocol. F2 contrast pair-set policy set by design lead (10 pairs, both surfaces) — carried to 0.4 and the F2 ratification list.

**2026-07-07 · 0.1 Project scaffold · Code Review → PASS** (0 blockers, 1 major, 4 minors).
- Major (process): 0.1 was marked done in this file before the review verdict landed. No file change was required (the review passed), but the standing correction is recorded: **gate status is written from the verdict, never ahead of it.**
- Minors, disposition: env server-only split (fixed — `src/lib/env.server.ts` with `server-only` guard), CI `permissions: contents: read` (fixed), `docs/ops/environments.md` CI-env wording (fixed), worker-types note for Phase 1.3 (documented in `workers/edge-autofix/README.md`; due at 1.3).

## Freeze log (frozen-foundation decisions + post-freeze changes)

**🔒 FREEZE GATE 0 — FOUNDATION FROZEN — 2026-07-08 (operator sign-off).**
The operator reviewed a local prototype build of F2 (`npm run dev` → `/design-system`) and signed off on **both** freezes:
- **F1 — multi-tenant data model** (doc 03): 6 migrations, RLS enabled + forced on all 13 tables, structural tenant-consistency via composite FKs, in-schema approval/review gates, `auto` publishing prohibited on `site_changes`. Code Review security gate CLOSED (0 leaks under 360+ probes); QA isolation suite 363/363. **FROZEN.**
- **F2 — design system + white-label theming** (doc 06): token system, tenant theming engine (untrusted-input-safe, B1 CSS-injection fix cleared), 22 token-mapped components, Recharts language, 5 reduced-motion-gated moments. Design Review passed + operator sign-off (resolution 4b). **FROZEN.**
- Skills (0.2) gate-closed; agent team (0.0) operational.

**Post-freeze change control now in force (CLAUDE.md rule 1):** any change to the frozen data model or design system requires **Orchestrator + Code Review sign-off**, recorded here.

_No post-freeze changes yet._

## Open escalations to operator

_None blocking. The "pending ratification" items below are logged for decision at their named checkpoints (F1 = 0.3 freeze, F2 = 0.4 freeze, operator = Freeze Gate 0 review)._

## Operator ratifications — 2026-07-07 (all four decision groups ratified wholesale)

The operator ratified all four groups. Recorded here as binding; the frozen-foundation change-control rule (CLAUDE.md rule 1) governs any future change.

1. **Auto-publish prohibition (F1 MAJOR 1 fix):** RATIFIED. `automation_level='auto'` structurally impossible on `site_changes`; every on-page/site write is `ai_draft_human_approve` or `human_only`.
2. **Access-control split:** RATIFIED. `platform_owner` reads zero rows through tenant-facing policies (ops via `service_role`); clients/tenant_users/tenants writes are `agency_admin`-only; `operator` writes module tables; `client_viewer` read-only + own-client.
3. **F2 theming policies:** RATIFIED. 10-pair contrast set (both surfaces); light-surface `#f4f6f9`; one-palette-per-tenant; fixed type scale (tenants swap colors + fonts only).
4. **Library default thresholds:** RATIFIED as launch defaults — see the ⚑ revisit flags below.

### ⚑ Thresholds to revisit once we have real client data (GG / real estate / Gate 1a)
These were ratified as reasonable launch defaults but are the ones most likely to want tuning against real-world signal — flagged per operator request:
- **aeo-audit review-velocity thresholds** (hyper-local ≥4 new/30d, recency ≤30d; semi-local ≥1/30d, ≤60d) — pure estimates until we see real review flow per vertical.
- **aeo-audit refresh-window default (90d)** — real cadence is vertical- and client-specific (doc 05 cites real-estate 60–90d); calibrate per playbook once GG's decay pattern is observed.
- **aeo-audit base check weights** (AI-crawler access + schema highest) — revisit once we can see which checks actually move citations for a real client at Gate 1a.
- (Not data-dependent, no revisit expected: schema-generation date-match exemption + price-candidate policy; compliance TCPA presence-scope + alcohol-jurisdiction warn; brand-kit contrast pairs. Auto-rollback thresholds are already per-client-configurable — tuned in Phase 1.2, not here.)

## Doc-silent assumptions from 0.2 — RATIFIED 2026-07-07 (superseded by the block above; retained for the decision trail)

**Ratify at F1 (0.3, lead-backend-data-architect):**
1. `tenants.theme.font` sub-shape — doc 03 has singular `font`; doc 06 requires three faces. Library emits `font: {display, body, mono}`.
2. `tenants.theme.colors` key naming — snake_case (`surface_raised`) chosen per jsonb convention.
3. `AutomationLevel` lives as a local copy in aeo-audit `types.ts` — unify into the shared data-layer types at F1.
4. `SchemaBrandContext` identity gap (schema-generation `types.ts` ~467–479) — brand context shape must line up with the `brand_kits` schema.
5. Compliance registry + regex cache are module-level state — must be tenant/request-scoped when wired into the app (flag carried to the 1.x integration review).

**Ratify at F2 (0.4, operator sign-off):**
6. Positive/negative distinguishability policy: hue separation ≥ 30° OR mutual contrast ≥ 1.3:1, auto-separated by lightness (brand-kit `CONTRAST_REQUIREMENTS`).
7. Contrast pair-set policy incl. surfaceRaised pairs — being set by the design lead in 0.2 remediation; carries into the theming engine.

**Ratify at Freeze Gate 0 (operator):**
8. aeo-audit library-defined base check weights (AI-crawler access + schema highest at 12) — playbook schema has no per-check weights; single override point exists if F1 adds them.
9. aeo-audit refresh-window default 90 days (outer bound of doc 05's 60–90 real-estate example), overridable per audit.
10. aeo-audit review-velocity thresholds (hyper-local ≥4/30d recency ≤30d; semi-local ≥1/30d recency ≤60d).
11. schema-generation: date fields are sanity-validated but exempt from visible-text matching (rendered dates can't be deterministically matched) — needs a line in the skill doc.
12. schema-generation: Review/AggregateRating supported as standalone roots (doc 02 profiles list them standalone; SKILL.md showed them only nested).
13. compliance: TCPA check verifies consent-language presence, not legal sufficiency of the consent flow — explicit boundary for compliance-review.
14. compliance: state-by-state alcohol-promotion rules have no matrix in doc 02 → warn with jurisdiction note, never silent pass.

## Resolved escalations (operator resolutions, 2026-07-07)

1. **Phase 1 sequencing (doc 00 §5 vs doc 07):** RESOLVED — **doc 07 is authoritative** for Phase 1 sequencing. Doc 00 §5's ordering is superseded where they differ.
2. **"content pipeline" owner:** RESOLVED — added a 13th agent, **`content-production-engineer`**, owning M8, M9, M11, M12, M15. It generates content; `content-quality` and `compliance-review` remain the independent reviewers — a producing agent never approves its own output. Doc 01 (roster + agent block), doc 05 (module map), doc 07 (1.5/1.7 owners), and `.claude/agents/` updated.
3. **Skills as definitions vs code:** RESOLVED — skills stay as Claude Code definitions; the isolation-tested implementation library lands in 0.2. **The 0.2 gate (Code Review + QA) tests the underlying library, not just the definition.**
4. **F2 design direction encoding:** CONFIRMED as done. **F2 freeze gate:** RESOLVED — Design Review alone is insufficient; the F2 freeze requires **operator sign-off** as independent reviewer. Doc 01, doc 07 (0.4 + Freeze Gate 0), and CLAUDE.md updated.
