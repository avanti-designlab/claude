/**
 * Worker glue suite — handleRequest's contract, proven with injected fakes
 * (Node's Request/Response, a fake KV, a recording HTMLRewriter — no
 * Cloudflare runtime, no network):
 *
 *  - FAIL OPEN: every non-happy path returns the IDENTICAL origin Response
 *    object (asserted by identity, not equality — untouched means untouched,
 *    origin cache headers included).
 *  - Rewrite path: correct selectors registered, the seen-state is threaded
 *    from element handlers to the head-end injection, the verifiability
 *    header carries version + rule ids, and the cache-poisoning guards
 *    (no-store, etag/last-modified stripped, CDN-tier directives stripped)
 *    are applied.
 *  - A throwing rule handler never breaks the page (exception-guarded).
 *  - The Major-2 selector fix (gate-dispositioned 2026-07-09):
 *    scopeRewriterSelectors registers the head-scoped CSS selectors with the
 *    real rewriter, and a document-order streaming fake with REAL selector
 *    semantics proves inline-SVG <title>s are never rewritten and never
 *    suppress the head injection — plus the head-window handler gate as
 *    defense in depth when a seam delivers post-</head> elements anyway.
 */

import { describe, expect, it } from "vitest";
import {
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  edgeRuleId,
  serializeManifest,
  type EdgeRule,
  type EdgeRuleSeed,
} from "./manifest";
import {
  handleRequest,
  scopeRewriterSelectors,
  type EdgeAutofixEnv,
  type HtmlRewriterConstructor,
  type HtmlRewriterLike,
  type KvNamespaceLike,
  type RewriterElementLike,
  type RewriterEndTagLike,
  type WorkerDeps,
} from "./worker";

const PAGE_URL = "https://ggrealty.example/pricing";

function rule<T extends EdgeRuleSeed>(partial: T): T & { id: string } {
  return { ...partial, id: edgeRuleId(partial) };
}

const TITLE = rule({
  enabled: true,
  path: "/pricing",
  op: "set_title",
  payload: { text: "Pricing | GG Realty" },
});
const META = rule({
  enabled: true,
  path: "/pricing",
  op: "set_meta_description",
  payload: { content: "Pricing overview" },
});
const CANONICAL = rule({
  enabled: true,
  path: "/pricing",
  op: "set_canonical",
  payload: { href: "https://ggrealty.example/pricing" },
});
const IMG_ALT = rule({
  enabled: true,
  path: "/pricing",
  op: "set_img_alt",
  payload: { src: "/hero.jpg", alt: "Hero" },
});
const JSONLD = rule({
  enabled: true,
  path: "/pricing",
  op: "upsert_json_ld",
  payload: { scriptId: "faq", json: { "@type": "FAQPage" } },
});

function manifestText(rules: EdgeRule[], version = 3): string {
  return serializeManifest({
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    updatedAt: "2026-07-09T12:00:00.000Z",
    rules,
  });
}

function kv(value: string | null): KvNamespaceLike {
  return { get: async () => value };
}

function htmlOrigin(headers: Record<string, string> = {}): Response {
  return new Response("<html><head></head><body>origin</body></html>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
      etag: '"origin-etag"',
      "last-modified": "Wed, 08 Jul 2026 00:00:00 GMT",
      ...headers,
    },
  });
}

/** Recording HTMLRewriter stand-in: journals selectors + handlers. */
class FakeRewriter implements HtmlRewriterLike {
  static instances: FakeRewriter[] = [];
  readonly handlers = new Map<
    string,
    { element(element: RewriterElementLike): void }
  >();
  constructor() {
    FakeRewriter.instances.push(this);
  }
  on(
    selector: string,
    handlers: { element(element: RewriterElementLike): void },
  ): HtmlRewriterLike {
    this.handlers.set(selector, handlers);
    return this;
  }
  transform(response: Response): Response {
    return new Response("<html>rewritten</html>", response);
  }
}

/** `rewriter: null` models a runtime WITHOUT HTMLRewriter (fail-open path). */
function deps(
  origin: Response,
  rewriter: WorkerDeps["rewriter"] | null = FakeRewriter,
): WorkerDeps & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    originFetch: async (req) => {
      requests.push(req);
      return origin;
    },
    rewriter: rewriter ?? undefined,
  };
}

function env(value: string | null): EdgeAutofixEnv {
  return { EDGE_RULES: kv(value) };
}

/** A fake element for driving registered handlers after the fact. */
class FakeGlueElement implements RewriterElementLike {
  endTagHandler: ((tag: RewriterEndTagLike) => void) | null = null;
  inner: string | null = null;
  readonly attrs: Record<string, string>;
  constructor(attrs: Record<string, string> = {}) {
    this.attrs = attrs;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  setInnerContent(content: string): void {
    this.inner = content;
  }
  onEndTag(handler: (tag: RewriterEndTagLike) => void): void {
    this.endTagHandler = handler;
  }
}

describe("fail open — the origin response is returned UNTOUCHED (same object)", () => {
  const table: Array<[string, () => Promise<{ out: Response; origin: Response }>]> = [
    [
      "no EDGE_RULES binding",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        return { out: await handleRequest(new Request(PAGE_URL), {}, d), origin };
      },
    ],
    [
      "KV read throws",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        const failing: KvNamespaceLike = {
          get: async () => {
            throw new Error("kv unavailable");
          },
        };
        return {
          out: await handleRequest(new Request(PAGE_URL), { EDGE_RULES: failing }, d),
          origin,
        };
      },
    ],
    [
      "manifest key missing",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        return { out: await handleRequest(new Request(PAGE_URL), env(null), d), origin };
      },
    ],
    [
      "manifest unparseable / foreign",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        return {
          out: await handleRequest(
            new Request(PAGE_URL),
            env('{"format":"someone-elses/rules"}'),
            d,
          ),
          origin,
        };
      },
    ],
    [
      "valid manifest, no rule for this path",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        return {
          out: await handleRequest(
            new Request("https://ggrealty.example/other"),
            env(manifestText([TITLE])),
            d,
          ),
          origin,
        };
      },
    ],
    [
      "only disabled rules for this path",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin);
        return {
          out: await handleRequest(
            new Request(PAGE_URL),
            env(manifestText([{ ...TITLE, enabled: false }])),
            d,
          ),
          origin,
        };
      },
    ],
    [
      "no HTMLRewriter in the runtime",
      async () => {
        const origin = htmlOrigin();
        const d = deps(origin, null);
        return {
          out: await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE])), d),
          origin,
        };
      },
    ],
  ];

  for (const [name, run] of table) {
    it(`${name} → strict pass-through`, async () => {
      const { out, origin } = await run();
      // IDENTITY: the exact origin Response object, so origin caching headers
      // (and everything else) are untouched by construction.
      expect(out).toBe(origin);
      expect(out.headers.get("x-edge-autofix")).toBeNull();
      expect(out.headers.get("cache-control")).toBe("public, max-age=600");
      expect(out.headers.get("etag")).toBe('"origin-etag"');
    });
  }

  it("non-GET/HEAD requests are forwarded without any rewrite attempt", async () => {
    const origin = htmlOrigin();
    const d = deps(origin);
    const out = await handleRequest(
      new Request(PAGE_URL, { method: "POST", body: "x" }),
      env(manifestText([TITLE])),
      d,
    );
    expect(out).toBe(origin);
    expect(d.requests[0].method).toBe("POST");
  });

  it("non-200 and non-HTML origin responses pass through untouched", async () => {
    const notFound = new Response("<html>404</html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
    expect(
      await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE])), deps(notFound)),
    ).toBe(notFound);

    const json = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(
      await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE])), deps(json)),
    ).toBe(json);
  });
});

describe("rewrite path", () => {
  it("registers exactly the needed selectors, stamps the verifiability header, and never cache-poisons", async () => {
    FakeRewriter.instances = [];
    const origin = htmlOrigin();
    const d = deps(origin);
    const out = await handleRequest(
      new Request(PAGE_URL),
      env(manifestText([TITLE, JSONLD], 9)),
      d,
    );

    expect(out).not.toBe(origin);
    // Verifiability: the header names the manifest version + SELECTED rules
    // (in the manifest's canonical id-sorted order) — selection, not proof
    // of rendered effect; MONITOR verifies the DOM, never this header alone.
    expect(out.headers.get("x-edge-autofix")).toBe(
      "v9; jsonld.faq@/pricing title@/pricing",
    );
    // Cache-poisoning guards: a rewritten body is never cacheable and never
    // 304-revalidatable against origin validators.
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(out.headers.get("etag")).toBeNull();
    expect(out.headers.get("last-modified")).toBeNull();
    // Untouched origin headers still flow through.
    expect(out.headers.get("content-type")).toBe("text/html; charset=utf-8");

    // Selector wiring: title (the rule) + head (the injection seam); no
    // meta/link/img handlers for rules that were not selected.
    const rewriter = FakeRewriter.instances[0];
    expect([...rewriter.handlers.keys()].sort()).toEqual(["head", "title"]);
  });

  it("strips CDN-tier cache directives on the REWRITTEN path (Surrogate-Control outranks cache-control on Fastly-class CDNs); pass-through keeps them untouched", async () => {
    const origin = htmlOrigin({
      "surrogate-control": "max-age=86400",
      "cdn-cache-control": "max-age=86400",
      "cloudflare-cdn-cache-control": "max-age=86400",
    });
    const out = await handleRequest(
      new Request(PAGE_URL),
      env(manifestText([TITLE])),
      deps(origin),
    );
    expect(out).not.toBe(origin);
    // A rewritten body must not be pinnable at ANY cache tier: a CDN that
    // honors Surrogate-Control over cache-control would otherwise keep
    // serving a stale rewrite past a rules change.
    expect(out.headers.get("surrogate-control")).toBeNull();
    expect(out.headers.get("cdn-cache-control")).toBeNull();
    expect(out.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    expect(out.headers.get("cache-control")).toBe("no-store");

    // Pass-through (no rule for the page): the origin's CDN directives flow
    // through byte-untouched — the origin's own caching is never degraded.
    const passOrigin = htmlOrigin({ "surrogate-control": "max-age=86400" });
    const pass = await handleRequest(
      new Request("https://ggrealty.example/untouched"),
      env(manifestText([TITLE])),
      deps(passOrigin),
    );
    expect(pass).toBe(passOrigin);
    expect(pass.headers.get("surrogate-control")).toBe("max-age=86400");
  });

  it("threads seen-state from element handlers to the head-end injection (glue, end to end)", async () => {
    FakeRewriter.instances = [];
    await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE, JSONLD])), deps(htmlOrigin()));
    const rewriter = FakeRewriter.instances[0];

    // Drive the handlers the way HTMLRewriter would, in document order:
    // the page HAS a <title>, so only the JSON-LD block injects at </head>.
    const title = new FakeGlueElement();
    rewriter.handlers.get("title")!.element(title);
    expect(title.inner).toBe("Pricing | GG Realty");

    const head = new FakeGlueElement();
    rewriter.handlers.get("head")!.element(head);
    const injected: string[] = [];
    head.endTagHandler!({ before: (content) => injected.push(content) });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('data-edge-autofix-schema="faq"');
    expect(injected[0]).not.toContain("<title>");
  });

  it("injects the missing title at </head> when no <title> streamed past", async () => {
    FakeRewriter.instances = [];
    await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE])), deps(htmlOrigin()));
    const rewriter = FakeRewriter.instances[0];

    const head = new FakeGlueElement();
    rewriter.handlers.get("head")!.element(head);
    const injected: string[] = [];
    head.endTagHandler!({ before: (content) => injected.push(content) });
    expect(injected[0]).toBe("<title>Pricing | GG Realty</title>");
  });

  it("a throwing element handler fails open for that element (the page never breaks)", async () => {
    FakeRewriter.instances = [];
    await handleRequest(new Request(PAGE_URL), env(manifestText([TITLE])), deps(htmlOrigin()));
    const rewriter = FakeRewriter.instances[0];

    const hostile: RewriterElementLike = {
      getAttribute: () => null,
      setAttribute: () => {
        throw new Error("boom");
      },
      setInnerContent: () => {
        throw new Error("boom");
      },
      onEndTag: () => {
        throw new Error("boom");
      },
    };
    // Neither registered handler propagates the element's failure.
    expect(() => rewriter.handlers.get("title")!.element(hostile)).not.toThrow();
    expect(() => rewriter.handlers.get("head")!.element(hostile)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Major-2 regression surface (gate-dispositioned 2026-07-09): the     */
/* head-scoped selector wiring + inline-SVG <title> fixtures           */
/* ------------------------------------------------------------------ */

/**
 * A document-order STREAMING fake with real selector semantics — unlike
 * FakeRewriter (which only journals registrations), this models lol-html:
 * it walks the source HTML in byte order, tracks each element's parent,
 * resolves the registered CSS selectors (`E` and `head > E`) against that
 * context, fires the head end-tag callback BETWEEN head children and body
 * content (real streaming order), and serializes mutations back out. It
 * exists to prove the head-scoped selector fix and the head-window handler
 * gate against fixtures containing inline-SVG <title> elements. Real
 * lol-html still never runs in this repo's suites — the first-live-deploy
 * canary noted in rules.ts.
 */
function makeStreamingRewriter(source: string): HtmlRewriterConstructor {
  interface Reg {
    selector: string;
    handlers: { element(element: RewriterElementLike): void };
  }
  const VOID_TAGS = new Set(["meta", "link", "img", "br", "hr", "input"]);
  const ATTR = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;

  /** `E` or `P > E` — the only selector shapes this worker registers. */
  function matches(selector: string, tag: string, parent: string | null): boolean {
    const m = /^(?:([a-z]+)\s*>\s*)?([a-z]+)$/.exec(selector);
    if (!m) return false;
    return m[2] === tag && (m[1] === undefined || m[1] === parent);
  }

  class StreamedElement implements RewriterElementLike {
    readonly attrOrder: string[] = [];
    readonly attrs = new Map<string, string>();
    readonly mutatedAttrs = new Set<string>();
    newInner: string | null = null;
    endTagHandlers: Array<(tag: RewriterEndTagLike) => void> = [];
    constructor(attrText: string) {
      let m: RegExpExecArray | null;
      while ((m = ATTR.exec(attrText)) !== null) {
        this.attrOrder.push(m[1]);
        this.attrs.set(m[1], m[2]);
      }
    }
    getAttribute(name: string): string | null {
      return this.attrs.get(name) ?? null;
    }
    setAttribute(name: string, value: string): void {
      if (!this.attrs.has(name)) this.attrOrder.push(name);
      this.attrs.set(name, value);
      this.mutatedAttrs.add(name);
    }
    setInnerContent(content: string, options?: { html: boolean }): void {
      // html:false → the runtime entity-escapes (lol-html-modeled minimum).
      this.newInner = options?.html
        ? content
        : content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    onEndTag(handler: (tag: RewriterEndTagLike) => void): void {
      this.endTagHandlers.push(handler);
    }
    serializeOpenTag(tag: string): string {
      const attrs = this.attrOrder
        .map((n) => `${n}="${this.attrs.get(n)!}"`)
        .join(" ");
      return attrs.length > 0 ? `<${tag} ${attrs}>` : `<${tag}>`;
    }
  }

  return class StreamingFake implements HtmlRewriterLike {
    private readonly regs: Reg[] = [];
    on(
      selector: string,
      handlers: { element(element: RewriterElementLike): void },
    ): HtmlRewriterLike {
      this.regs.push({ selector, handlers });
      return this;
    }
    transform(response: Response): Response {
      const edits: Array<{ start: number; end: number; text: string }> = [];
      const stack: string[] = [];
      // Element-scoped end-tag callbacks (head injection), by tag name.
      const pendingEndTag = new Map<string, Array<(t: RewriterEndTagLike) => void>>();
      const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"]|"[^"]*")*?)>/g;
      let m: RegExpExecArray | null;
      while ((m = TAG.exec(source)) !== null) {
        const [full, closing, rawName, attrText] = m;
        const tag = rawName.toLowerCase();
        if (closing === "/") {
          const idx = stack.lastIndexOf(tag);
          if (idx >= 0) stack.length = idx;
          const handlers = pendingEndTag.get(tag);
          if (handlers) {
            pendingEndTag.delete(tag);
            const parts: string[] = [];
            for (const h of handlers) h({ before: (content) => void parts.push(content) });
            if (parts.length > 0) {
              edits.push({ start: m.index, end: m.index, text: parts.join("") });
            }
          }
          continue;
        }
        const parent = stack.length > 0 ? stack[stack.length - 1] : null;
        const el = new StreamedElement(attrText);
        for (const reg of this.regs) {
          if (matches(reg.selector, tag, parent)) reg.handlers.element(el);
        }
        if (el.endTagHandlers.length > 0) {
          pendingEndTag.set(tag, [
            ...(pendingEndTag.get(tag) ?? []),
            ...el.endTagHandlers,
          ]);
        }
        if (el.newInner !== null) {
          // Replace the whole element (open tag → matching close tag).
          const close = source.indexOf(`</${tag}>`, m.index);
          if (close >= 0) {
            edits.push({
              start: m.index,
              end: close + tag.length + 3,
              text: `<${tag}>${el.newInner}</${tag}>`,
            });
          }
        } else if (el.mutatedAttrs.size > 0) {
          edits.push({
            start: m.index,
            end: m.index + full.length,
            text: el.serializeOpenTag(tag),
          });
        }
        if (!VOID_TAGS.has(tag) && !attrText.endsWith("/")) stack.push(tag);
      }
      edits.sort((a, b) => b.start - a.start);
      let out = source;
      for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
      return new Response(out, response);
    }
  };
}

const SVG_PAGE = [
  "<!doctype html><html><head>",
  "<title>Original Title</title>",
  '<meta charset="utf-8">',
  "</head><body>",
  '<svg viewBox="0 0 10 10"><title>Accessible chart name</title><circle r="4"></circle></svg>',
  "<p>copy</p>",
  "<svg><title>Second svg title</title></svg>",
  "</body></html>",
].join("");

const SVG_PAGE_NO_HEAD_TITLE = [
  "<!doctype html><html><head>",
  '<meta charset="utf-8">',
  "</head><body>",
  "<svg><title>Accessible chart name</title></svg>",
  "</body></html>",
].join("");

async function renderSvgFixture(
  source: string,
  rewriter: HtmlRewriterConstructor,
): Promise<string> {
  const origin = new Response(source, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const out = await handleRequest(
    new Request(PAGE_URL),
    env(manifestText([TITLE])),
    { originFetch: async () => origin, rewriter },
  );
  return out.text();
}

describe("Major-2 selector fix — inline-SVG <title> elements survive a set_title rule", () => {
  it("scopeRewriterSelectors (the production wiring, index.ts) registers the HEAD-SCOPED CSS selectors: title/meta/link scoped, img page-wide, head unchanged", async () => {
    FakeRewriter.instances = [];
    await handleRequest(
      new Request(PAGE_URL),
      env(manifestText([TITLE, META, CANONICAL, IMG_ALT, JSONLD])),
      deps(htmlOrigin(), scopeRewriterSelectors(FakeRewriter)),
    );
    const inner = FakeRewriter.instances[0];
    expect([...inner.handlers.keys()].sort()).toEqual([
      "head",
      "head > link",
      "head > meta",
      "head > title",
      "img",
    ]);
  });

  it("(a) with a set_title rule: the head title is replaced, SVG accessibility titles are byte-untouched, and the new title lands exactly once", async () => {
    const body = await renderSvgFixture(
      SVG_PAGE,
      scopeRewriterSelectors(makeStreamingRewriter(SVG_PAGE)),
    );
    expect(body).toContain("<title>Pricing | GG Realty</title>");
    expect(body).not.toContain("<title>Original Title</title>");
    // The SVG titles — page-wide clobber was the Major-2 bug — survive.
    expect(body).toContain("<title>Accessible chart name</title>");
    expect(body).toContain("<title>Second svg title</title>");
    expect(body.match(/Pricing \| GG Realty/g)).toHaveLength(1);
  });

  it("(b) SVG titles never suppress the head injection: a page with SVG <title>s but NO head title still gets the injected title inside <head>, SVG untouched", async () => {
    const body = await renderSvgFixture(
      SVG_PAGE_NO_HEAD_TITLE,
      scopeRewriterSelectors(makeStreamingRewriter(SVG_PAGE_NO_HEAD_TITLE)),
    );
    const injectedAt = body.indexOf("<title>Pricing | GG Realty</title>");
    expect(injectedAt).toBeGreaterThan(-1);
    expect(injectedAt).toBeLessThan(body.indexOf("</head>"));
    expect(body).toContain("<title>Accessible chart name</title>");
    expect(body.match(/Pricing \| GG Realty/g)).toHaveLength(1);
  });

  it("head-window gate (defense in depth): even when the seam DELIVERS post-</head> titles to the handler (unscoped bare selectors), they stay untouched and never mark seen.title", async () => {
    // NO scopeRewriterSelectors here: the raw streaming fake resolves the
    // bare seam key "title" against EVERY <title> in document order —
    // exactly the hazard the seen.headClosed gate exists for.
    const replaced = await renderSvgFixture(
      SVG_PAGE,
      makeStreamingRewriter(SVG_PAGE),
    );
    expect(replaced).toContain("<title>Pricing | GG Realty</title>");
    expect(replaced).toContain("<title>Accessible chart name</title>");
    expect(replaced).toContain("<title>Second svg title</title>");
    expect(replaced.match(/Pricing \| GG Realty/g)).toHaveLength(1);

    // And on the no-head-title page the injection still fires (the SVG match
    // arrives after </head>, so it must not have set seen.title).
    const injected = await renderSvgFixture(
      SVG_PAGE_NO_HEAD_TITLE,
      makeStreamingRewriter(SVG_PAGE_NO_HEAD_TITLE),
    );
    const at = injected.indexOf("<title>Pricing | GG Realty</title>");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(injected.indexOf("</head>"));
    expect(injected).toContain("<title>Accessible chart name</title>");
    expect(injected.match(/Pricing \| GG Realty/g)).toHaveLength(1);
  });
});
