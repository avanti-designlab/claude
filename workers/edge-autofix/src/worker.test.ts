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
 *    (no-store, etag/last-modified stripped) are applied.
 *  - A throwing rule handler never breaks the page (exception-guarded).
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
  type EdgeAutofixEnv,
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
    // Verifiability: the header names the manifest version + applied rules
    // (in the manifest's canonical id-sorted order).
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
