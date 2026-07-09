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
 *
 * The one piece of real wiring beyond globals: the runtime's HTMLRewriter is
 * wrapped in `scopeRewriterSelectors`, which translates the structural seam
 * keys handleRequest registers ("title"/"meta"/"link") into the HEAD-SCOPED
 * CSS selectors in rules.ts (`head > title` etc.) so inline-SVG accessibility
 * `<title>` elements are never rewritten (Major-2 fix, gate-dispositioned
 * 2026-07-09). The scoped selector strings never meet real lol-html in this
 * repo's suites — first-live-deploy canary, BUILD-STATE carried ticket ii.
 */

import {
  handleRequest,
  scopeRewriterSelectors,
  type EdgeAutofixEnv,
  type HtmlRewriterConstructor,
} from "./worker";

const worker = {
  async fetch(request: Request, env: EdgeAutofixEnv | undefined): Promise<Response> {
    // Present in the Cloudflare runtime; undefined anywhere else, which
    // makes handleRequest a strict pass-through (fail open by construction).
    const RuntimeRewriter = (
      globalThis as { HTMLRewriter?: HtmlRewriterConstructor }
    ).HTMLRewriter;
    return handleRequest(request, env ?? {}, {
      originFetch: (req) => fetch(req),
      rewriter:
        RuntimeRewriter === undefined
          ? undefined
          : scopeRewriterSelectors(RuntimeRewriter),
    });
  },
};

export default worker;
