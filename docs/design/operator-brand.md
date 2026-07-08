# Operator brand (tenant #1) — WORKING BRAND v1

**Status (2026-07-08, operator decision): pass 3 is the working brand v1, applied
APP-WIDE as a dual-palette light/dark theme.** The operator kept BOTH pass-3
variants: the blue-depth light palette boots the app; the dark-glow palette is
the app's dark mode under the standard mode mechanism. A "main" mode may be
picked later.

**Structure is LOCKED as v1; VALUES float.** The operator may still swap the
font and add/swap colors — those are value changes inside the locked roles, on
the additive path below. Do NOT treat the hex values as frozen; do NOT change
the roles without operator direction. This brand is NOT part of the F2 freeze —
F2 (tokens/engine/components) is frozen; the operator brand riding it is a
working version awaiting a future re-freeze on operator sign-off.

Source files: `src/lib/theme/operator-theme.ts` (palettes, both gate-validated
through `buildBrandKit`), `src/lib/theme/operator-mode-css.ts` (dual-mode
emission), `src/app/layout.tsx` (boot wiring),
`src/components/dashboard-preview/glow-card.tsx` (glow language).

## Locked roles (v1 structure)

| Role | Light mode value | Dark mode value | Product use |
|---|---|---|---|
| **Primary blue** → `--accent` | `#2456f0` | `#3f7cff` | Buttons, links, focus ring, the Visibility-Score resolve, glow fills |
| **Highlight cyan** → `--accent-secondary` | `#8fd4ff` (gate-corrected to `#0091eb` on white — reported) | `#8fd4ff` (verbatim) | The illuminated edge, rim-light, sky washes, the reference bubble gradient |
| **Deep navy anchor** | gradient ends mix `--accent` toward the navy ink `#0b152b` | the SURFACES: `#050815` canvas / `#0b1430` cards (Dark Blue `#0a1c46` lineage) | Depth — gradients always travel light → dark |
| **Red = urgency** → `--negative` | `#e11d48` | `#f43f5e` | EVERY "needs action" surface (washes, rims, arrows). Never orange, never the brand accent. Green/red up/down semantics stay universal; color is never the only signal |
| **Face: Geist** | variable 100–900, OFL-1.1, self-hosted `public/fonts/geist-var.woff2` | same | Display AND body — hierarchy from weight + size + tight tracking (Apple/Webflow pattern). Inter fallback; IBM Plex Mono unchanged |
| **Hero = floating rounded bubble** | GlowCard `surface="hero"`, radius `calc(var(--radius)*4)` | same | Every page hero: a floating card with margin from the viewport — never a full-width band |
| **Glow language** | soft blue halo + pale cyan rim (backlit glass in daylight) | neon cyan 1px gradient edge + blue bloom + inner radial glow | SPARINGLY: hero + one or two earned moments per page. Dense tables/forms stay quiet |

All glow recipes are pure `color-mix` derivations over tokens — no literals —
so every surface re-skins per tenant. Mode-dependent foregrounds ride the
`dark:` variant (bound in `globals.css` to the standard mechanism) or derived
`--accent-foreground`-family tokens — never a raw white/black assumption.

## The mode mechanism (app-wide)

- The app **boots light** (the light palette is the unconditional base for
  `:root[data-tenant-theme="operator"]`).
- **Dark applies** under `@media (prefers-color-scheme: dark)` (unless
  `data-theme="light"` forces light) and under `data-theme="dark"` (explicit
  override) — the SAME `data-theme` contract the frozen Signal defaults use.
- Both palettes pass the frozen engine's accessibility gate independently;
  corrections are reported (light: cyan → `#0091eb`, the only one; dark: zero).
  Derived on-color foregrounds are emitted per palette; `color-scheme`
  follows polarity so UA chrome matches.
- `/dashboard-preview`'s Light / Dark-glow toggle simply sets `data-theme` —
  it IS the standard mechanism, with preview-page naming.
- The frozen engine is unchanged: `operator-mode-css.ts` only formats two
  gate-validated resolutions into mode-conditional CSS.

## Motion signature (operator direction, 2026-07-08 — "immersive and live")

Entrance choreography, one orchestrated run per page load / route entry
(`src/components/moments/entrance.tsx` + the `.entrance-*` CSS in
`globals.css`; filed under moment #5, key state transitions):

- **Rise:** 14px translate + fade, **520ms**, ease `cubic-bezier(0.22, 1, 0.36, 1)`
  (premium ease-out — Apple-calm, never bouncy).
- **Stagger:** **90ms** between sibling steps; section headers take the step
  before their card grid.
- **Bloom:** a hero/showcase GlowCard's box-shadow ramps in over **800ms**,
  starting **420ms** after its rise begins — the card lands, then lights.
- **Counters:** count-ups and the gauge resolve start **400ms** after their
  own tile's rise begins (`counterDelayMs`) — sequenced, never simultaneous.
- **Discipline:** transforms/opacity only (zero layout shift); SSR markup is
  final-state-identical (no hydration mismatch; plays without JS); no
  scroll-jacking; dense tables/forms appear instantly. Reduced motion renders
  the final state instantly via BOTH gates: `prefers-reduced-motion` (CSS)
  and the design-system force-toggle (`:root[data-motion="reduced"]`,
  mirroring the frozen `useReducedMotion` policy).

## Available accents (superseded, NOT deleted — the additive path)

The pass-2 brand-guide palette remains in the system
(`OPERATOR_ACCENT_LIBRARY` + `OPERATOR_BRAND_INPUT`, still gate-validated):

| Name | Hex | Status |
|---|---|---|
| Core Blue | `#1B2FCE` | Superseded as primary by the blue-depth blues; available |
| Core Orange | `#FC4C14` | **Available** — not leading; if re-added it must stay hue-separated from urgency red (energy ≠ error) |
| Alachua | `#F4A200` | **Available** — carried in the working palettes' `--accent-warm` slot (light: post-gate `#c18000`; dark: verbatim) |
| Dark Blue | `#0A1C46` | Alive as the dark-surface lineage |

**Re-adding a color is additive:** author it into the mode INPUTS (or a new
`--accent-*` slot via the sanctioned two-accent extension pattern), let the
gate validate/correct it, and update this table. Same for a font swap: change
`OPERATOR_TYPOGRAPHY` + self-host the face in `globals.css`/`public/fonts`
(the font-stack grammar gate applies). Nothing requires touching the frozen
engine or components.

## Phase-1 flag — dual-palette `tenants.theme` schema (owner: lead-backend-data-architect, at M7)

Today's `tenants.theme` jsonb shape carries ONE palette. The operator brand's
dual palette lives in code (two `tenants.theme`-shaped inputs). When DB-driven
tenant themes arrive (M7 Brand Kit engine), the schema needs an extension for
an optional second (dark) palette — e.g. `theme.modes.{light,dark}` or a
sibling `theme_dark` — resolved through the same gate per palette and emitted
via `dualModeTenantCss`. Single-palette tenants stay valid unchanged
(backward compatible). The backend architect owns the schema call at M7 time;
the theming side is already shaped for it (`DemoTenant.modes`,
`dualModeTenantCss`).

## Accessibility

Both palettes pass the full contrast gate (3:1 UI marks on both chrome
layers, 4.5:1+ derived text-on-fill, positive/negative distinguishability);
every auto-correction is surfaced on `/design-system` (Engine decision panel
shows BOTH modes for the operator). Contrast gates hold in both modes with
derived foregrounds everywhere; the entrance choreography and all count-ups
render final states instantly under reduced motion.
