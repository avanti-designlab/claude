/**
 * edge-autofix request handling — the thin glue between the pure rule layer
 * (`rules.ts`, fully unit-tested) and the Cloudflare runtime. `handleRequest`
 * takes its runtime dependencies (origin fetch, HTMLRewriter constructor, KV
 * binding) as STRUCTURAL interfaces, so it is itself testable in plain vitest;
 * `index.ts` wires the real globals.
 *
 * THE WORKER'S CONTRACT (doc 04 §1 method 2 + §5) — pinned by worker.test.ts:
 *
 *  FAIL OPEN, ALWAYS. This worker sits on a CLIENT'S domain; it must never
 *  block or degrade the client's site. Every non-happy path — missing KV
 *  binding, KV read error, missing manifest, unparseable/foreign manifest,
 *  no HTMLRewriter in the runtime, any throw while planning — returns the
 *  UNMODIFIED origin response. An unreachable manifest means NO rewrites,
 *  never an error page.
 *
 *  REWRITE ONLY WHAT IS SAFE TO REWRITE. Only GET/HEAD requests, only 200
 *  responses, only `text/html` bodies, and only when at least one enabled
 *  rule matches the exact request pathname. Everything else passes through
 *  byte-identical, headers untouched.
 *
 *  NEVER CACHE-POISON. A REWRITTEN response is marked `cache-control:
 *  no-store` and stripped of `etag`/`last-modified`, so no shared or browser
 *  cache can pin a rewritten body past a rules change, and no conditional
 *  revalidation can 304-serve a stale rewrite. (Correctness over cache hits:
 *  rewritten pages are regenerated per request.) PASS-THROUGH responses keep
 *  their origin caching untouched — the origin's own content stays cacheable
 *  exactly as the origin intended.
 *
 *  VERIFIABLE. Every rewritten response carries `x-edge-autofix:
 *  v{manifestVersion}; {ruleId} {ruleId} ...` naming exactly which rules were
 *  applied — that is how an operator (or the MONITOR step) confirms a rule is
 *  live on a URL. Pass-through responses carry no marker.
 *
 *  ISOLATION (doc 04 §5). One worker per client domain, one KV namespace per
 *  client, provisioned at onboarding — this code holds no cross-client state
 *  and reads exactly one KV key. The worker only ever READS rules; every rule
 *  in the manifest was written through the change-management pipeline by the
 *  CloudflareEdgeAdapter (previewed, human-approved, audited, reversible).
 *
 *  TIMING (the applied_at caveat). A rule lands in KV at apply time but this
 *  worker sees it on the NEXT request after KV edge propagation (up to ~60s).
 *  Rendered effect therefore trails `site_changes.applied_at` by propagation
 *  + next-visit time — the MONITOR step owns render-verification; the adapter
 *  verifies at the manifest level only, and says so.
 */

import { MANIFEST_KEY, parseManifest } from "./manifest";
import { buildRewritePlan, newSeenTargets } from "./rules";

/* ------------------------------------------------------------------ */
/* Structural runtime types (no @cloudflare/workers-types dependency — */
/* the root tsconfig typechecks this package against the DOM lib, and  */
/* workers types must not be added globally; see the package README).  */
/* ------------------------------------------------------------------ */

/** The one KV method this worker uses, shaped like Cloudflare's KVNamespace. */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
}

/** Bindings from wrangler.toml (per-client instances bind their namespace). */
export interface EdgeAutofixEnv {
  EDGE_RULES?: KvNamespaceLike;
}

export interface RewriterEndTagLike {
  before(content: string, options?: { html: boolean }): void;
}

/** Structural subset of HTMLRewriter's Element (extends the pure layer's). */
export interface RewriterElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  setInnerContent(content: string, options?: { html: boolean }): void;
  onEndTag(handler: (tag: RewriterEndTagLike) => void): void;
}

export interface HtmlRewriterLike {
  on(
    selector: string,
    handlers: { element(element: RewriterElementLike): void },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
}

export type HtmlRewriterConstructor = new () => HtmlRewriterLike;

/** Injected runtime dependencies (real globals in index.ts; fakes in tests). */
export interface WorkerDeps {
  /** Forwards the request to the origin (global `fetch` on a zone route). */
  originFetch(request: Request): Promise<Response>;
  /** The runtime's HTMLRewriter, or undefined outside Cloudflare (fail open). */
  rewriter: HtmlRewriterConstructor | undefined;
}

/* ------------------------------------------------------------------ */
/* The handler                                                         */
/* ------------------------------------------------------------------ */

export async function handleRequest(
  request: Request,
  env: EdgeAutofixEnv,
  deps: WorkerDeps,
): Promise<Response> {
  // Non-idempotent requests are never rewritten — forward untouched.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return deps.originFetch(request);
  }

  const origin = await deps.originFetch(request);

  // Only successful HTML documents are rewrite candidates.
  if (origin.status !== 200) return origin;
  const contentType = origin.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().includes("text/html")) {
    return origin;
  }

  try {
    // FAIL OPEN: a missing binding, a KV error, a missing key, or a manifest
    // that does not STRICTLY parse (foreign format, unknown op, torn write)
    // all mean the same thing here — no rewrites, origin served as-is.
    if (!env.EDGE_RULES || !deps.rewriter) return origin;
    const manifestText = await env.EDGE_RULES.get(MANIFEST_KEY);
    if (manifestText === null) return origin;
    const manifest = parseManifest(manifestText);
    if (manifest === null) return origin;

    const plan = buildRewritePlan(manifest, new URL(request.url).pathname);
    if (plan === null) return origin;

    // Shared per-response state: element handlers mark what streamed past;
    // the head end-tag callback injects whatever is still missing. Handler
    // bodies are exception-guarded — one bad rule must never break the page
    // mid-stream (the rule simply does not apply).
    const seen = newSeenTargets();
    const rewriter = new deps.rewriter();
    for (const action of plan.selectors) {
      rewriter.on(action.selector, {
        element(element) {
          try {
            action.handle(element, seen);
          } catch {
            /* fail open per element */
          }
        },
      });
    }
    rewriter.on("head", {
      element(element) {
        try {
          element.onEndTag((tag) => {
            try {
              const html = plan.headEndHtml(seen);
              if (html.length > 0) tag.before(html, { html: true });
            } catch {
              /* fail open per injection */
            }
          });
        } catch {
          /* fail open per element */
        }
      },
    });

    const rewritten = rewriter.transform(origin);
    // Fresh Response so headers are mutable regardless of runtime guards.
    const out = new Response(rewritten.body, rewritten);
    out.headers.set("x-edge-autofix", plan.header);
    // Never cache-poison: a rewritten body must not outlive a rules change
    // in any cache, and must never be 304-revalidated against origin state.
    out.headers.set("cache-control", "no-store");
    out.headers.delete("etag");
    out.headers.delete("last-modified");
    return out;
  } catch {
    // FAIL OPEN: any unexpected failure serves the client's page unmodified.
    return origin;
  }
}
