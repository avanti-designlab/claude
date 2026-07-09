/**
 * Pure rule-application suite — the worker's rewrite behavior proven with
 * fake elements, zero Cloudflare runtime (the point of the rules.ts / worker.ts
 * split). Covers: selection (enabled + exact path), replace-vs-inject for
 * title/meta/canonical, the head-window gate (elements after </head> — SVG
 * <title>s — are never touched and never mark seen), byte-exact img-src
 * matching, JSON-LD injection with breakout-proof escaping, and the
 * verifiability header value.
 */

import { describe, expect, it } from "vitest";
import {
  edgeRuleId,
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  type EdgeRule,
  type EdgeRuleSeed,
  type EdgeRulesManifest,
} from "./manifest";
import {
  buildRewritePlan,
  escapeAttribute,
  escapeText,
  jsonLdScriptContent,
  newSeenTargets,
  selectRules,
  type RewritableElement,
  type SelectorAction,
} from "./rules";

function rule<T extends EdgeRuleSeed>(partial: T): T & { id: string } {
  return { ...partial, id: edgeRuleId(partial) };
}

function manifestWith(rules: EdgeRule[], version = 42): EdgeRulesManifest {
  return {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    updatedAt: "2026-07-09T12:00:00.000Z",
    rules,
  };
}

/** A recording stand-in for HTMLRewriter's Element. */
class FakeElement implements RewritableElement {
  readonly sets: Array<[string, string]> = [];
  innerContent: { content: string; options?: { html: boolean } } | null = null;
  constructor(private readonly attrs: Record<string, string> = {}) {}
  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
      ? this.attrs[name]
      : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    this.sets.push([name, value]);
  }
  setInnerContent(content: string, options?: { html: boolean }): void {
    this.innerContent = { content, options };
  }
}

function actionFor(
  plan: { selectors: SelectorAction[] },
  selector: SelectorAction["selector"],
): SelectorAction {
  const action = plan.selectors.find((s) => s.selector === selector);
  if (!action) throw new Error(`no action registered for '${selector}'`);
  return action;
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
  payload: { content: 'San Diego pricing — honest & "transparent"' },
});
const CANONICAL = rule({
  enabled: true,
  path: "/pricing",
  op: "set_canonical",
  payload: { href: "https://ggrealty.example/pricing" },
});
const JSONLD = rule({
  enabled: true,
  path: "/pricing",
  op: "upsert_json_ld",
  payload: { scriptId: "faq", json: { "@type": "FAQPage" } },
});

describe("selection", () => {
  it("selects only ENABLED rules whose path equals the pathname byte-exact", () => {
    const disabled = { ...TITLE, enabled: false };
    const otherPath = rule({
      enabled: true,
      path: "/pricing/",
      op: "set_title",
      payload: { text: "trailing slash is a DIFFERENT path" },
    });
    const manifest = manifestWith([disabled, otherPath, META]);
    expect(selectRules(manifest, "/pricing").map((r) => r.id)).toEqual([
      META.id,
    ]);
    expect(selectRules(manifest, "/pricing/").map((r) => r.id)).toEqual([
      otherPath.id,
    ]);
  });

  it("builds NO plan when nothing matches — the pass-through signal", () => {
    expect(buildRewritePlan(manifestWith([TITLE]), "/other")).toBeNull();
    expect(buildRewritePlan(manifestWith([]), "/pricing")).toBeNull();
    expect(
      buildRewritePlan(manifestWith([{ ...TITLE, enabled: false }]), "/pricing"),
    ).toBeNull();
  });
});

describe("replace-or-inject", () => {
  it("title: replaces an existing <title> as plain text and skips the head-end injection", () => {
    const plan = buildRewritePlan(manifestWith([TITLE]), "/pricing")!;
    const seen = newSeenTargets();
    const el = new FakeElement();
    actionFor(plan, "title").handle(el, seen);
    expect(el.innerContent).toEqual({
      content: "Pricing | GG Realty",
      options: { html: false },
    });
    expect(seen.title).toBe(true);
    expect(plan.headEndHtml(seen)).toBe("");
  });

  it("title: injects an escaped <title> at </head> when the page has none", () => {
    const hostile = rule({
      enabled: true,
      path: "/p",
      op: "set_title",
      payload: { text: "</title><script>alert(1)</script> & Co" },
    });
    const plan = buildRewritePlan(manifestWith([hostile]), "/p")!;
    const html = plan.headEndHtml(newSeenTargets());
    expect(html).toBe(
      "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co</title>",
    );
  });

  it("meta description: rewrites content only on name=description (case-insensitive), leaves other metas alone", () => {
    const plan = buildRewritePlan(manifestWith([META]), "/pricing")!;
    const seen = newSeenTargets();

    const viewport = new FakeElement({ name: "viewport", content: "width=device-width" });
    actionFor(plan, "meta").handle(viewport, seen);
    expect(viewport.sets).toEqual([]);
    expect(seen.metaDescription).toBe(false);

    const description = new FakeElement({ name: "Description", content: "old" });
    actionFor(plan, "meta").handle(description, seen);
    expect(description.sets).toEqual([["content", META.payload.content]]);
    expect(seen.metaDescription).toBe(true);
    expect(plan.headEndHtml(seen)).toBe("");
  });

  it("meta description: injects with attribute-escaped content when the page has none", () => {
    const plan = buildRewritePlan(manifestWith([META]), "/pricing")!;
    expect(plan.headEndHtml(newSeenTargets())).toBe(
      '<meta name="description" content="San Diego pricing — honest &amp; &quot;transparent&quot;">',
    );
  });

  it("canonical: rewrites href on a rel token match ('alternate canonical' counts, 'stylesheet' does not)", () => {
    const plan = buildRewritePlan(manifestWith([CANONICAL]), "/pricing")!;
    const seen = newSeenTargets();

    const stylesheet = new FakeElement({ rel: "stylesheet", href: "/x.css" });
    actionFor(plan, "link").handle(stylesheet, seen);
    expect(stylesheet.sets).toEqual([]);

    const canonical = new FakeElement({
      rel: "alternate CANONICAL",
      href: "https://old.example/pricing",
    });
    actionFor(plan, "link").handle(canonical, seen);
    expect(canonical.sets).toEqual([["href", CANONICAL.payload.href]]);
    expect(seen.canonical).toBe(true);
    expect(plan.headEndHtml(seen)).toBe("");
  });

  it("canonical: injects at </head> when the page has none", () => {
    const plan = buildRewritePlan(manifestWith([CANONICAL]), "/pricing")!;
    expect(plan.headEndHtml(newSeenTargets())).toBe(
      '<link rel="canonical" href="https://ggrealty.example/pricing">',
    );
  });
});

describe("head-window gate (inline-SVG <title> defense in depth, 2026-07-09)", () => {
  it("title/meta/link handlers ignore elements delivered AFTER </head> and never mark seen; img stays page-wide by design; the head injection is unaffected", () => {
    const alt = rule({
      enabled: true,
      path: "/pricing",
      op: "set_img_alt",
      payload: { src: "/hero.jpg", alt: "Hero" },
    });
    const plan = buildRewritePlan(
      manifestWith([TITLE, META, CANONICAL, alt]),
      "/pricing",
    )!;
    const seen = newSeenTargets();
    seen.headClosed = true; // </head> has streamed past

    // An SVG accessibility <title> in the body: untouched, unseen.
    const svgTitle = new FakeElement();
    actionFor(plan, "title").handle(svgTitle, seen);
    expect(svgTitle.innerContent).toBeNull();
    expect(seen.title).toBe(false);

    // Body-level microdata <meta name="description">: untouched, unseen.
    const bodyMeta = new FakeElement({ name: "description", content: "microdata" });
    actionFor(plan, "meta").handle(bodyMeta, seen);
    expect(bodyMeta.sets).toEqual([]);
    expect(seen.metaDescription).toBe(false);

    // Body-level <link rel=canonical>: untouched, unseen.
    const bodyLink = new FakeElement({ rel: "canonical", href: "/x" });
    actionFor(plan, "link").handle(bodyLink, seen);
    expect(bodyLink.sets).toEqual([]);
    expect(seen.canonical).toBe(false);

    // img alt is intentionally UNGATED — body content is its target.
    const img = new FakeElement({ src: "/hero.jpg" });
    actionFor(plan, "img").handle(img, seen);
    expect(img.sets).toEqual([["alt", "Hero"]]);

    // The injection decision at </head> (where headClosed is set) still
    // emits everything genuinely missing from the head — post-head matches
    // could not suppress it.
    const injected = plan.headEndHtml(seen);
    expect(injected).toContain("<title>");
    expect(injected).toContain('name="description"');
    expect(injected).toContain('rel="canonical"');
  });
});

describe("img alt — byte-exact src match", () => {
  const src = "https://cdn.example.com/casa uno.jpg";
  const ALT = rule({
    enabled: true,
    path: "/listings",
    op: "set_img_alt",
    payload: { src, alt: "Casa Uno exterior" },
  });
  const ALT2 = rule({
    enabled: true,
    path: "/listings",
    op: "set_img_alt",
    payload: { src: "/img/two.jpg", alt: "Casa Dos" },
  });

  it("sets alt on the exact src, supports several alt rules per page, leaves other imgs untouched", () => {
    const plan = buildRewritePlan(manifestWith([ALT, ALT2]), "/listings")!;
    const seen = newSeenTargets();

    const match = new FakeElement({ src });
    actionFor(plan, "img").handle(match, seen);
    expect(match.sets).toEqual([["alt", "Casa Uno exterior"]]);

    const second = new FakeElement({ src: "/img/two.jpg", alt: "old" });
    actionFor(plan, "img").handle(second, seen);
    expect(second.sets).toEqual([["alt", "Casa Dos"]]);

    const other = new FakeElement({ src: "/img/unrelated.jpg" });
    actionFor(plan, "img").handle(other, seen);
    expect(other.sets).toEqual([]);

    const srcless = new FakeElement({});
    actionFor(plan, "img").handle(srcless, seen);
    expect(srcless.sets).toEqual([]);
  });
});

describe("JSON-LD injection", () => {
  it("injects a tagged script at </head>; the payload cannot break out of the element", () => {
    const hostile = rule({
      enabled: true,
      path: "/p",
      op: "upsert_json_ld",
      payload: {
        scriptId: "faq",
        json: { "@type": "FAQPage", q: '</script><script>alert(1)</script>' },
      },
    });
    const plan = buildRewritePlan(manifestWith([hostile]), "/p")!;
    const html = plan.headEndHtml(newSeenTargets());
    expect(html).toContain('<script type="application/ld+json"');
    expect(html).toContain(`data-edge-autofix-rule="${hostile.id}"`);
    expect(html).toContain('data-edge-autofix-schema="faq"');
    // Exactly one script element; no literal "</script" inside the payload.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.slice(0, html.lastIndexOf("</script>"))).not.toContain(
      "</script",
    );
    // And the embedded JSON still parses back to the identical value.
    const body = html.slice(html.indexOf(">", html.indexOf("data-edge")) + 1, html.lastIndexOf("</script>"));
    expect(JSON.parse(body)).toEqual(hostile.payload.json);
  });

  it("injects one script per JSON-LD rule (several schema slots per page)", () => {
    const article = rule({
      enabled: true,
      path: "/pricing",
      op: "upsert_json_ld",
      payload: { scriptId: "article", json: { "@type": "Article" } },
    });
    const plan = buildRewritePlan(manifestWith([JSONLD, article]), "/pricing")!;
    const html = plan.headEndHtml(newSeenTargets());
    expect(html.match(/<script /g)).toHaveLength(2);
    expect(html).toContain('data-edge-autofix-schema="faq"');
    expect(html).toContain('data-edge-autofix-schema="article"');
  });
});

describe("verifiability header", () => {
  it("names the manifest version and every selected rule id, space-separated", () => {
    const plan = buildRewritePlan(
      manifestWith([TITLE, META, JSONLD], 42),
      "/pricing",
    )!;
    expect(plan.header).toBe(
      "v42; title@/pricing meta-description@/pricing jsonld.faq@/pricing",
    );
    expect(plan.ruleIds).toHaveLength(3);
  });
});

describe("escaping primitives", () => {
  it("escapeText / escapeAttribute cover &, <, >, and quotes", () => {
    expect(escapeText('a & <b> "c"')).toBe('a &amp; &lt;b&gt; "c"');
    expect(escapeAttribute('a & <b> "c"')).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });

  it("jsonLdScriptContent escapes < and U+2028/U+2029 while preserving the value", () => {
    const json = { a: "</script>", b: "line\u2028sep\u2029end" };
    const text = jsonLdScriptContent(json);
    expect(text).not.toContain("<");
    expect(text).not.toContain("\u2028");
    expect(text).not.toContain("\u2029");
    expect(JSON.parse(text)).toEqual(json);
  });
});
