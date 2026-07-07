# F2 design-system decisions record (Lead UI/UX Designer, 2026-07-07)

Companion to doc 06 for Design Review + operator sign-off. These are the
normative decisions F2 adds where doc 06 names the goal but not the
mechanism. Post-freeze changes to anything here require Orchestrator + Code
Review sign-off (doc 07, Freeze Gate 0).

## 1. Token architecture

- Runtime tokens live as CSS custom properties on `:root`
  (src/app/globals.css), named exactly as `toCssVariables()` emits them:
  `--surface`, `--surface-raised`, `--ink`, `--muted`, `--accent`,
  `--positive`, `--negative`, `--font-{display,body,mono}`, `--text-*`,
  `--space-*`. A parity test (src/lib/theme/globals-parity.test.ts) pins the
  stylesheet to the pipeline output — the stylesheet cannot drift from the
  library.
- Tailwind v4 `@theme inline` maps utilities to `var(--token)` references,
  so utilities re-resolve per scope. The default Tailwind color palette is
  wiped (`--color-*: initial`): `bg-red-500` does not exist in this app.
  Enforcement test: src/lib/theme/no-hardcoded-colors.test.ts.
- **Dark is the default.** Light is the pipeline-computed adaptation
  (buildBrandKit against `SIGNAL_LIGHT_SURFACE` `#f4f6f9`), applied via
  `prefers-color-scheme: light` and overridable with
  `data-theme="dark" | "light"` on `<html>`.

## 2. Derived chrome (computed from tokens, never brand values)

| Variable | Rule |
|---|---|
| `--accent-foreground`, `--positive-foreground`, `--negative-foreground` | whichever of `surface`/`ink` has the higher WCAG contrast against the fill (`deriveOnColorForegrounds`, recomputed per tenant) |
| `--overlay` | `color-mix(in oklab, var(--ink) 8%, transparent)` — quiet hover/selected wash |
| `--border` / `--input` | ink at 14% / 20% |
| `--ring` | `var(--accent)` — keyboard focus is tenant-branded |
| `--scrim` | surface at 55% — dialog/sheet overlay dims in-theme |
| `--radius` | 0.5rem (instrument-tight; shadcn scale derives from it) |

## 3. shadcn → token mapping

shadcn semantic variables are aliases of the tokens
(`--color-background: var(--surface)`, `--color-foreground: var(--ink)`,
`--color-card/popover: var(--surface-raised)`, `--color-primary:
var(--accent)`, `--color-destructive: var(--negative)`, etc.). Component
sources were re-pointed where shadcn's vocabulary collides with doc 06:

- shadcn's decorative `accent`/`muted` **backgrounds** → `overlay` (our
  `--accent` is the brand color; our `--muted` is secondary text).
- `text-muted-foreground` → `text-muted`; `text-accent-foreground` (hover) →
  `text-ink`.
- `text-white` (destructive variants) → `text-destructive-foreground`
  (= `--negative-foreground`); `bg-black/50` overlays → `bg-scrim`.
- Components' `dark:` variant classes were stripped: mode adaptation happens
  at the token layer, and Tailwind's media-query `dark:` would fight the
  `data-theme` override.

Components live vendored in src/components/ui (fetched from the upstream
new-york-v4 registry; ui.shadcn.com is blocked by the session egress policy,
raw.githubusercontent.com was used). `cn()` lives at src/lib/theme/utils.ts
(components.json `aliases.utils`).

## 4. Type

- Display: **Space Grotesk** (characterful grotesque — instrument dials, not
  a serif editorial voice). Body: **Inter**. Data/metrics: **IBM Plex Mono**.
  Self-hosted with real family names (public/fonts + `@font-face`) because
  font stacks are runtime token values a tenant theme can replace.
- The scale includes two data-moment steps: `text-display` (3.5rem/640) and
  `text-score` (5.25rem/650) — the Visibility Score treatment.
- Weights 400–650; structure from spacing, not hairlines. Deliberately none
  of the three banned looks (cream+serif+terracotta / near-black+acid /
  hairline-broadsheet): deep blue-slate graphite chrome, brass accent
  (default only — tenants override), coral/teal functional pair.

## 5. Theming engine gate

`resolveTenantTheme()` (src/lib/theme/engine.ts) rebuilds every
`tenants.theme` through `buildBrandKit` at render time — the DB blob is
untrusted input. Colors are re-parsed to normalized hex; **font stacks are
validated against a CSS font-family grammar whitelist**
(src/lib/skills/brand-kit/font-stack.ts: Unicode letters, digits, spaces,
and `_ , ' " -` only — `; { } < > ( ) / \`, control characters, and thereby
`url(` / `</style>` are rejected), because font values are emitted verbatim
into `<style>` stylesheets and inline styles; a violating stack throws like
a malformed color and is never rendered (stored-CSS-injection gate, B1).
Outcomes: pass → apply; correctable → apply corrected values
and surface every adjustment; unsolvable/malformed (unparseable color or
grammar-violating font) → **refuse**, apply Signal
fallback, log the reason (never silent). Scoping: `:root[data-tenant-theme]`
(whole-app; portaled overlays included) or `<TenantThemeScope>` for embedded
previews.

- A tenant theme is one palette; it does not carry a light/dark pair. The
  mode toggle applies to the Signal default only. (Doc-silent; flagged for
  the operator — if resellers need per-tenant dual modes, that is a Phase 1+
  extension of `tenants.theme`.)
- The type scale is instrument chrome: tenants swap colors and faces, not
  the scale (`tenants.theme` carries `colors` + `font` per doc 03 §3).

## 6. Chart language

One identity color (accent = the client), neutral ink-mixes for competitors,
`positive`/`negative` reserved for status and always paired with a glyph or
label. No multi-hue categorical ramp exists in F2 — adding one is a
design-system change. Grid = ink @ 8%; axis/values in muted mono; tooltips on
raised surface. Dark-mode token lightness (L 0.70–0.77) sits above the
dataviz-skill categorical band (0.48–0.67) because the token gate requires
≥ 3:1 on both chrome layers; accepted deviation — compensated with thin
marks, alpha washes, and text-token labels.

## 7. Motion

Exactly five moments (src/components/moments), all gated through ONE hook
(`useReducedMotion`: OS preference + provider override; SSR default =
reduced, so content is never hidden). The score resolve reserves its box
(fixed `ch` digit slots, fixed dot-row height, opacity-only caption) — zero
layout shift. No motion primitives may be imported outside
src/components/moments.
