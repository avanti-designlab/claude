/**
 * edge-autofix request handling — the thin glue between the pure rule layer
 * (`rules.ts`, fully unit-tested) and the Cloudflare runtime. `handleRequest`
 * takes its runtime dependencies (origin fetch, HTMLRewriter constructor, KV
 * binding) as STRUCTURAL interfaces, so it is itself testable in plain vitest;
 * `index.ts` wires the real globals.
 *
 * THE WORKER'S CONTRACT (doc 04 §1 method 2 + §5) — pinned by worker.test.ts:
 *
 *  FAIL OPEN, ALWAYS — WITH ONE HONEST EXCEPTION. This worker sits on a
 *  CLIENT'S domain; it must never block or degrade the client's site. Every
 *  non-happy path — missing KV binding, KV read error, missing manifest,
 *  unparseable/foreign manifest, no HTMLRewriter in the runtime, any throw
 *  while planning — returns the UNMODIFIED origin response. An unreachable
 *  manifest means NO rewrites, never an error page. THE EXCEPTION this
 *  cannot cover: if the ORIGIN fetch itself rejects, there is no origin
 *  response to fail open TO — that rejection propagates to the runtime
 *  (which serves its error page exactly as it would with no worker
 *  installed). Fail-open means "never degrade a page the origin could
 *  serve", not "conjure a page the origin never produced".
 *
 *  REWRITE ONLY WHAT IS SAFE TO REWRITE. Only GET/HEAD requests, only 200
 *  responses, only `text/html` bodies, and only when at least one enabled
 *  rule matches the exact request pathname. Everything else passes through
 *  byte-identical, headers untouched.
 *
 *  NEVER CACHE-POISON. A REWRITTEN response is marked `cache-control:
 *  no-store`, stripped of `etag`/`last-modified`, AND stripped of the
 *  CDN-tier directives `surrogate-control` / `cdn-cache-control` /
 *  `cloudflare-cdn-cache-control` (Fastly-class CDNs give Surrogate-Control
 *  precedence over cache-control, so a lingering origin value could pin a
 *  rewritten body upstream past a rules change). So no shared or browser
 *  cache can pin a rewritten body, and no conditional revalidation can
 *  304-serve a stale rewrite. (Correctness over cache hits: rewritten pages
 *  are regenerated per request.) PASS-THROUGH responses keep their origin
 *  caching untouched — the origin's own content stays cacheable exactly as
 *  the origin intended.
 *
 *  VERIFIABLE — WITH AN HONEST LIMIT. Every rewritten response carries
 *  `x-edge-autofix: v{manifestVersion}; {ruleId} {ruleId} ...` naming exactly
 *  which rules were SELECTED for the page — selected, not proven applied:
 *  element handlers run while the body streams, AFTER the headers are gone,
 *  and a per-element failure (exception-guarded below, fail open) can
 *  silently drop one rule's rendered effect. MONITOR must therefore verify
 *  the rendered DOM effect on the live URL; header presence alone is never
 *  proof a rule landed. Pass-through responses carry no marker.
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
 *  verifies at the manifest level only, and says so. One more caveat:
 *  visitors holding a primed PRE-RULE cache entry revalidate conditionally,
 *  the origin answers 304, and a 304 is not a 200 — pass-through — so those
 *  visitors keep the pre-rule body until their cached TTL expires. MONITOR
 *  must not read stale-cache visitors as a failed rule.
 */

import { MANIFEST_KEY, parseManifest } from "./manifest";
import {
  buildRewritePlan,
  newSeenTargets,
  REGISTERED_CSS_SELECTORS,
} from "./rules";

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
  /**
   * The runtime's HTMLRewriter, or undefined outside Cloudflare (fail open).
   * The values `handleRequest` passes to `on()` are the STRUCTURAL SEAM KEYS
   * from rules.ts ("title" / "meta" / "link" / "img" / "head"); index.ts
   * wires the REAL HTMLRewriter through {@link scopeRewriterSelectors}, which
   * translates each key into its head-scoped CSS selector
   * (`REGISTERED_CSS_SELECTORS`) so inline-SVG `<title>`s and body-level
   * `<meta>`/`<link>` never match. Injected fakes implement the seam keys.
   */
  rewriter: HtmlRewriterConstructor | undefined;
}

/**
 * Wrap an HTMLRewriter constructor so every `on(seamKey, …)` registration is
 * translated into its head-scoped CSS selector (`head > title`, `head >
 * meta`, `head > link`; `img` and `head` unchanged) before reaching the real
 * runtime. This is THE Major-2 selector fix (gate-dispositioned 2026-07-09):
 * a bare `title` selector on lol-html matches every `<title>` in the byte
 * stream — inline-SVG accessibility titles included — clobbering them
 * page-wide and suppressing the head injection via `seen.title`.
 * Applied at the runtime-wiring seam (index.ts); the map itself is
 * compile-time exhaustive over the seam keys (see rules.ts, including the
 * reviewer's first-live-deploy canary note — no suite here runs real
 * lol-html against these selector strings).
 */
export function scopeRewriterSelectors(
  Inner: HtmlRewriterConstructor,
): HtmlRewriterConstructor {
  return class ScopedSelectorRewriter implements HtmlRewriterLike {
    private readonly inner = new Inner();
    on(
      selector: string,
      handlers: { element(element: RewriterElementLike): void },
    ): HtmlRewriterLike {
      const scoped =
        (REGISTERED_CSS_SELECTORS as Record<string, string>)[selector] ??
        selector;
      this.inner.on(scoped, handlers);
      return this;
    }
    transform(response: Response): Response {
      return this.inner.transform(response);
    }
  };
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

  // Deliberately OUTSIDE the fail-open try below: if the ORIGIN fetch itself
  // rejects there is no origin response to fail open TO — nothing this worker
  // could serve instead. The rejection propagates to the runtime, exactly as
  // it would with no worker installed (see the header's fail-open exception).
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
              // The head window closes HERE: everything the title/meta/link
              // handlers see from now on (inline-SVG <title>s in the body)
              // is outside the head and must be ignored — the injection
              // decision below is final.
              seen.headClosed = true;
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
    // Names the rules SELECTED for this page — not proof of rendered effect
    // (a per-element failure after this point fails open silently); MONITOR
    // verifies the DOM, never this header alone.
    out.headers.set("x-edge-autofix", plan.header);
    // Never cache-poison: a rewritten body must not outlive a rules change
    // in any cache, and must never be 304-revalidated against origin state.
    out.headers.set("cache-control", "no-store");
    // CDN-tier directives too: Fastly-class CDNs give Surrogate-Control
    // precedence over cache-control, so a lingering origin value could pin
    // a rewritten body upstream past a rules change.
    out.headers.delete("surrogate-control");
    out.headers.delete("cdn-cache-control");
    out.headers.delete("cloudflare-cdn-cache-control");
    out.headers.delete("etag");
    out.headers.delete("last-modified");
    return out;
  } catch {
    // FAIL OPEN: any unexpected failure serves the client's page unmodified.
    return origin;
  }
}
