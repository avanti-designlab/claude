# edge-autofix (Cloudflare Worker) — scaffold only

The edge-worker auto-fix method (doc 04 §1 Method 2): rewrites tags/schema at delivery time. **Required for Framer sites** (no usable write API) and the universal fallback for anything else.

**Status: Phase 0.1 scaffold.** The worker here is a pass-through stub proving the deploy path. The real desired-state rewriting is built in step 1.3 — after the change-management layer (1.2) exists, because no write to a client site may bypass it.

At 1.3, give this package its own `tsconfig.json` with `@cloudflare/workers-types` (env bindings, `ExecutionContext`) — the stub currently typechecks fine against the root config's DOM lib, but the real worker won't, and workers types must not be added globally (they conflict with DOM types).

Deploy topology (doc 04 §5): **one isolated worker/route per client domain** — provisioned at client onboarding, never shared across clients. `wrangler.toml` here is the template; per-client instances get their own name/route.

Deploy (requires `CLOUDFLARE_API_TOKEN`, operator-provisioned — see `docs/ops/environments.md`):

```sh
cd workers/edge-autofix && npx wrangler deploy
```
