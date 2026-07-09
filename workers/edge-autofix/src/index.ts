/**
 * edge-autofix — Cloudflare Worker entry (doc 04 §1 method 2; REQUIRED for
 * Framer, universal fallback for everything else).
 *
 * One isolated worker per client domain (doc 04 §5). It rewrites HTML
 * responses in flight — title, meta description, canonical, injected JSON-LD,
 * img alt — driven by the versioned rules manifest in this instance's KV
 * namespace (binding `EDGE_RULES`, key `manifest`). Every rule in that
 * manifest was written by the CloudflareEdgeAdapter through the
 * change-management pipeline (doc 04 §2): previewed, human-approved, audited
 * as a `site_changes` row, and reversible by removing the rule — this worker
 * never invents changes.
 *
 * All behavior lives in `worker.ts` (fail-open / cache / verifiability
 * contract) and `rules.ts` (pure rule application) — this file only wires the
 * real runtime globals so the rest stays unit-testable without workerd.
 */

import {
  handleRequest,
  type EdgeAutofixEnv,
  type HtmlRewriterConstructor,
} from "./worker";

const worker = {
  async fetch(request: Request, env: EdgeAutofixEnv | undefined): Promise<Response> {
    return handleRequest(request, env ?? {}, {
      originFetch: (req) => fetch(req),
      // Present in the Cloudflare runtime; undefined anywhere else, which
      // makes handleRequest a strict pass-through (fail open by construction).
      rewriter: (globalThis as { HTMLRewriter?: HtmlRewriterConstructor })
        .HTMLRewriter,
    });
  },
};

export default worker;
