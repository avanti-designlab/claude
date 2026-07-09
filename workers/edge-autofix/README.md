# edge-autofix (Cloudflare Worker) — Phase 1.3 write method 4/4

The edge-worker auto-fix method (doc 04 §1 Method 2): rewrites HTML responses
in flight — title, meta description, canonical, injected JSON-LD, img alt.
**Required for Framer sites** (no usable write API) and the universal fallback
for anything else.

## How it works

- One **isolated worker per client domain** + one **KV namespace per client**
  (doc 04 §5), provisioned at onboarding. `wrangler.toml` here is the
  template; per-client instances get their own name/route/namespace binding.
- The worker READS a versioned rules manifest from its KV namespace (binding
  `EDGE_RULES`, key `manifest`; format defined in `src/manifest.ts`) and
  applies only enabled rules whose `path` matches the request pathname —
  via HTMLRewriter, streaming, with HEAD-SCOPED selectors (`head > title`,
  `head > meta`, `head > link`; see `REGISTERED_CSS_SELECTORS` in
  `src/rules.ts`) so inline-SVG accessibility `<title>` elements and
  body-level `<meta>`/`<link>` microdata are never rewritten.
- The worker never invents changes. Every rule is WRITTEN by the platform's
  `CloudflareEdgeAdapter` (`src/lib/write-methods/cloudflare/`) through the
  change-management pipeline (doc 04 §2): previewed, human-approved, audited
  as a `site_changes` row, reversible by removing the rule.

## Behavior contract (pinned by the test suites here)

- **Fail OPEN**: missing/unreachable/foreign manifest, missing binding, any
  internal error → the origin response is served unmodified. The worker can
  never block or degrade the client's site. The one exception fail-open
  cannot cover: if the ORIGIN fetch itself rejects, there is no origin
  response to serve — the rejection propagates to the runtime exactly as it
  would with no worker installed.
- **Never cache-poison**: rewritten responses are `cache-control: no-store`
  with `etag`/`last-modified` stripped AND the CDN-tier directives
  `surrogate-control`/`cdn-cache-control`/`cloudflare-cdn-cache-control`
  stripped (Surrogate-Control outranks cache-control on Fastly-class CDNs);
  pass-through responses keep origin caching untouched.
- **Verifiable — with an honest limit**: rewritten responses carry
  `x-edge-autofix: v{manifestVersion}; {ruleId} ...` naming the rules
  SELECTED for the page — not proof of rendered effect (a per-element
  failure fails open after headers are sent). MONITOR must verify the
  rendered DOM on the live URL, never header presence alone.
- **Timing**: a rule takes effect on the next request after KV edge
  propagation (~60s) — the `applied_at` caveat the adapter documents. Also:
  visitors holding a primed pre-rule cache entry revalidate → 304 →
  pass-through until their TTL expires; MONITOR must not read stale-cache
  visitors as a failed rule.

## Code layout / testing

`src/manifest.ts` (wire format, shared with the adapter by relative import) →
`src/rules.ts` (pure rule application) → `src/worker.ts` (runtime glue with
injected deps) → `src/index.ts` (entry; wires real globals). Everything except
the 8-line entry is unit-tested in the repo's plain vitest run
(`npx vitest run` at the repo root) — no miniflare/workerd needed, because the
CF-only surfaces (HTMLRewriter, KV) are injected structural interfaces.

Typechecking note: this package deliberately does NOT use
`@cloudflare/workers-types` (they conflict with the root config's DOM types,
which must not change). CF-only runtime surfaces are typed as narrow
structural interfaces in `src/worker.ts`; `HTMLRewriter` is looked up off
`globalThis` at the entry, which doubles as the fail-open path outside the CF
runtime.

## Deploy

Requires `CLOUDFLARE_API_TOKEN`, operator-provisioned — see
`docs/ops/environments.md`. Per-client deploy happens at the property-wiring
step (BUILD-STATE carried ticket ii), never from feature code.

**HARD PRECONDITION (gate-dispositioned 2026-07-09):** this method must NOT
be wired to live client properties until per-property write serialization
exists at the wiring seam — Workers KV has no CAS, so a stale-base
interleaving of two of our own manifest writers silently drops the first
write while both report verified success (see the KNOWN RACE section in
`src/lib/write-methods/cloudflare/adapter.ts` and its pin test). The wiring
step also owns the first-live-deploy canaries: the real selector strings
against real lol-html, Cloudflare error-code semantics, and KV read-after-
write consistency.

```sh
cd workers/edge-autofix && npx wrangler deploy
```
