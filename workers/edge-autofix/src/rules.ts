/**
 * edge-autofix rule application — the PURE half of the worker (doc 04 §1
 * method 2). Everything here is plain TypeScript over narrow structural
 * interfaces, so the whole rewrite behavior is unit-testable in vitest with
 * no Cloudflare runtime; `worker.ts` is the thin glue that feeds these
 * functions real HTMLRewriter elements.
 *
 * Behavior contract (each line pinned by rules.test.ts / worker.test.ts):
 *  - Only ENABLED rules whose `path` equals the request's URL pathname
 *    byte-exact are applied. Everything else — including a valid manifest
 *    with no rule for this page — leaves the response untouched.
 *  - Replace-or-inject: title / meta-description / canonical rewrite the
 *    existing element when the page has one, and inject a new element just
 *    before `</head>` when it does not (streaming order guarantees every
 *    head child is seen before the head end tag).
 *  - JSON-LD is inject-only into `</head>`, tagged with
 *    `data-edge-autofix-rule` + `data-edge-autofix-schema`; origin JSON-LD
 *    blocks are never touched.
 *  - img alt matches `src` byte-exact in the handler (never via a CSS
 *    attribute selector — no escaping ambiguity, no selector injection).
 *  - Everything injected is escaped here: attribute values entity-escaped,
 *    text entity-escaped, JSON-LD serialized with `<` (and U+2028/U+2029)
 *    escaped so a hostile payload cannot break out of its script element.
 *  - The verifiability header value names the manifest version + every
 *    selected rule id (rule ids are single tokens — no spaces — so the
 *    space-separated list is unambiguous).
 */

import type { EdgeRule, EdgeRulesManifest, JsonObject } from "./manifest";

/* ------------------------------------------------------------------ */
/* Narrow element surface (structural subset of HTMLRewriter's Element)*/
/* ------------------------------------------------------------------ */

export interface RewritableElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  setInnerContent(content: string, options?: { html: boolean }): void;
}

/** Which replace-targets streamed past — decides the `</head>` injections. */
export interface SeenTargets {
  title: boolean;
  metaDescription: boolean;
  canonical: boolean;
}

export function newSeenTargets(): SeenTargets {
  return { title: false, metaDescription: false, canonical: false };
}

/** One HTMLRewriter registration the glue wires up. */
export interface SelectorAction {
  selector: "title" | "meta" | "link" | "img";
  handle(element: RewritableElement, seen: SeenTargets): void;
}

export interface RewritePlan {
  /** `x-edge-autofix` header value: `v{version}; {ruleId} {ruleId} ...` */
  header: string;
  /** Rule ids selected for this page (diagnostics / tests). */
  ruleIds: string[];
  selectors: SelectorAction[];
  /** HTML to inject just before `</head>`, given what streamed past. */
  headEndHtml(seen: SeenTargets): string;
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** Enabled rules whose path equals the request pathname byte-exact. */
export function selectRules(
  manifest: EdgeRulesManifest,
  pathname: string,
): EdgeRule[] {
  return manifest.rules.filter((r) => r.enabled && r.path === pathname);
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

/**
 * Build the rewrite plan for one request, or null when no enabled rule
 * matches the page (the caller then serves the origin response untouched —
 * headers included).
 */
export function buildRewritePlan(
  manifest: EdgeRulesManifest,
  pathname: string,
): RewritePlan | null {
  const selected = selectRules(manifest, pathname);
  if (selected.length === 0) return null;

  // Rule ids are unique per manifest and identity is (op, path,
  // discriminator), so at most ONE of each of these exists per page.
  const title = selected.find((r) => r.op === "set_title");
  const meta = selected.find((r) => r.op === "set_meta_description");
  const canonical = selected.find((r) => r.op === "set_canonical");
  const jsonLd = selected.filter((r) => r.op === "upsert_json_ld");
  const imgAlt = selected.filter((r) => r.op === "set_img_alt");

  const selectors: SelectorAction[] = [];

  if (title) {
    selectors.push({
      selector: "title",
      handle(element, seen) {
        seen.title = true;
        // html:false — HTMLRewriter escapes the text itself.
        element.setInnerContent(title.payload.text, { html: false });
      },
    });
  }

  if (meta) {
    selectors.push({
      selector: "meta",
      handle(element, seen) {
        const name = element.getAttribute("name");
        if (name !== null && name.toLowerCase() === "description") {
          seen.metaDescription = true;
          element.setAttribute("content", meta.payload.content);
        }
      },
    });
  }

  if (canonical) {
    selectors.push({
      selector: "link",
      handle(element, seen) {
        const rel = element.getAttribute("rel");
        if (rel !== null && relTokens(rel).includes("canonical")) {
          seen.canonical = true;
          element.setAttribute("href", canonical.payload.href);
        }
      },
    });
  }

  if (imgAlt.length > 0) {
    const bySrc = new Map(imgAlt.map((r) => [r.payload.src, r.payload.alt]));
    selectors.push({
      selector: "img",
      handle(element) {
        const src = element.getAttribute("src");
        if (src !== null) {
          const alt = bySrc.get(src);
          if (alt !== undefined) element.setAttribute("alt", alt);
        }
      },
    });
  }

  const ruleIds = selected.map((r) => r.id);
  return {
    header: `v${manifest.version}; ${ruleIds.join(" ")}`,
    ruleIds,
    selectors,
    headEndHtml(seen) {
      const parts: string[] = [];
      if (title && !seen.title) {
        parts.push(`<title>${escapeText(title.payload.text)}</title>`);
      }
      if (meta && !seen.metaDescription) {
        parts.push(
          `<meta name="description" content="${escapeAttribute(meta.payload.content)}">`,
        );
      }
      if (canonical && !seen.canonical) {
        parts.push(
          `<link rel="canonical" href="${escapeAttribute(canonical.payload.href)}">`,
        );
      }
      for (const rule of jsonLd) {
        parts.push(
          `<script type="application/ld+json" data-edge-autofix-rule="${escapeAttribute(rule.id)}" data-edge-autofix-schema="${escapeAttribute(rule.payload.scriptId)}">${jsonLdScriptContent(rule.payload.json)}</script>`,
        );
      }
      return parts.join("");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Escaping (everything injected passes through here)                  */
/* ------------------------------------------------------------------ */

/** rel is a whitespace-separated, case-insensitive token list. */
function relTokens(rel: string): string[] {
  return rel.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Serialize JSON-LD for inline `<script>` embedding: `<` becomes `<`
 * (kills `</script>` breakout and `<!--` ambiguity) and the JS line
 * separators U+2028/U+2029 are escaped. The result parses back to the
 * identical JSON value.
 */
export function jsonLdScriptContent(json: JsonObject): string {
  return JSON.stringify(json)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
