/**
 * Brand-extract isolation suite.
 *
 * Exercises the vendor-free analyzer end-to-end over realistic fixtures and its
 * pure-module contract: deterministic, never-throwing, honest-when-absent,
 * voice NOT summarized, and a draft that never emits an invalid-hex color or an
 * unsafe font stack. Client HTML/CSS are untrusted input — the malformed and
 * hostile cases pin that the parser terminates and degrades gracefully.
 */

import { describe, expect, it } from "vitest";
import { normalizeHex, validateFontStack } from "@/lib/skills/brand-kit";
import { extractBrandCandidates, MAX_INPUT_CHARS, toBrandKitDraft } from "./extract";
import { classifyColor, colorsInValue, extractColors, NEAR_DUP_DISTANCE } from "./colors";
import { parseGoogleFamilies } from "./fonts";
import { readStructuredData } from "./logos";
import { classifySelector, parseCss } from "./css-scan";
import { scanPage, tokenize } from "./html-scan";
import { fileNameOf, resolveUrl, usableBase } from "./url";
import type { ColorRoleSignals, ExtractedBrandCandidates } from "./types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MARKETING_URL = "https://acme.example/";

const MARKETING_HTML = `<!doctype html>
<html><head>
<title>Acme Analytics — Data you can trust</title>
<meta name="description" content="Acme Analytics helps teams see clearly.">
<meta property="og:site_name" content="Acme Analytics">
<meta name="theme-color" content="#2b6cff">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/touch.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;600">
</head>
<body>
<header>
  <a href="/"><img class="site-logo" src="/assets/logo.svg" alt="Acme logo"></a>
  <nav><a href="/pricing">Pricing</a><a href="/about">About</a></nav>
</header>
<main>
  <h1>See your data clearly</h1>
  <p>Acme Analytics turns messy dashboards into clear answers your whole team can act on. No fluff, just signal.</p>
  <a class="btn btn-primary" href="/start">Start free</a>
</main>
<footer><p>Copyright Acme, all rights reserved</p></footer>
</body></html>`;

const MARKETING_CSS = `
:root { --brand-primary: #2b6cff; }
body { background: #ffffff; color: #111827; font-family: Inter, sans-serif; }
h1, h2 { font-family: "Playfair Display", serif; color: #0b1220; }
a { color: #2b6cff; }
.btn { background-color: #2b6cff; color: #ffffff; border: 1px solid #1e4fd6; }
.btn:hover { background-color: #1e4fd6; }
`;

function extractMarketing(): ExtractedBrandCandidates {
  return extractBrandCandidates({ html: MARKETING_HTML, pageUrl: MARKETING_URL, cssBlobs: [MARKETING_CSS] });
}

function noRoles(): ColorRoleSignals {
  return {
    background: false,
    button: false,
    header: false,
    link: false,
    text: false,
    border: false,
    brandVariable: false,
    inline: false,
  };
}

/* ------------------------------------------------------------------ */
/* Normal marketing site                                               */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — normal marketing site", () => {
  const result = extractMarketing();

  it("ranks the brand blue first and classifies it accent", () => {
    expect(result.colors[0].hex).toBe("#2b6cff");
    expect(result.colors[0].classification).toBe("accent");
    expect(result.colors[0].roles.brandVariable).toBe(true);
    expect(result.colors[0].roles.button).toBe(true);
  });

  it("keeps white and dark ink as neutrals, not accents", () => {
    const white = result.colors.find((c) => c.hex === "#ffffff");
    expect(white?.classification).toBe("neutral");
    const ink = result.colors.find((c) => c.hex === "#0b1220");
    expect(ink?.classification).toBe("neutral");
  });

  it("detects the display font (headings) and body font (paragraphs)", () => {
    const playfair = result.fonts.find((f) => f.family === "Playfair Display");
    const inter = result.fonts.find((f) => f.family === "Inter");
    expect(playfair?.role).toBe("display");
    expect(inter?.role).toBe("body");
    expect(playfair?.sources).toContain("google-fonts-link");
    expect(playfair?.sources).toContain("css-selector");
  });

  it("ranks the header logo image first, with a resolved absolute URL", () => {
    expect(result.logos[0].kind).toBe("header-img");
    expect(result.logos[0].url).toBe("https://acme.example/assets/logo.svg");
    expect(result.logos.some((l) => l.kind === "apple-touch-icon")).toBe(true);
  });

  it("reads identity facts without interpreting them", () => {
    expect(result.identity.siteName).toBe("Acme Analytics");
    expect(result.identity.title).toBe("Acme Analytics — Data you can trust");
    expect(result.identity.tagline).toBe("Acme Analytics helps teams see clearly.");
  });

  it("exposes home copy as sourceText but never summarizes voice", () => {
    expect(result.voiceExtractionAvailable).toBe(false);
    expect(result.sourceText).toContain("messy dashboards");
    // nav + footer copy is excluded as boilerplate, not voice material.
    expect(result.sourceText).not.toContain("Pricing");
    expect(result.sourceText).not.toContain("Copyright");
  });

  it("is deterministic — identical output across runs", () => {
    expect(extractMarketing()).toEqual(extractMarketing());
  });
});

describe("toBrandKitDraft — normal marketing site", () => {
  const draft = toBrandKitDraft(extractMarketing());

  it("prefills the accent, secondary accent, surface and ink from top candidates", () => {
    expect(draft.colors.accent).toBe("#2b6cff");
    expect(draft.colors.accentSecondary).toBe("#1e4fd6");
    expect(draft.colors.surface).toBe("#ffffff");
    expect(draft.colors.ink).toBe("#0b1220");
  });

  it("prefills grammar-safe font stacks that pass the skill's B1 gate", () => {
    expect(draft.typography.display).toBe("Playfair Display, sans-serif");
    expect(draft.typography.body).toBe("Inter, sans-serif");
    expect(() => validateFontStack(draft.typography.display as string, "display")).not.toThrow();
    expect(() => validateFontStack(draft.typography.body as string, "body")).not.toThrow();
  });

  it("prefills the logo URL from the top logo candidate", () => {
    expect(draft.logoUrl).toBe("https://acme.example/assets/logo.svg");
  });

  it("leaves voice empty and honestly flags that AI must fill it", () => {
    expect(draft.voice).toEqual({ descriptors: [], samples: [], do: [], dont: [] });
    expect(draft.voiceNeedsAi).toBe(true);
    expect(draft.notes.some((n) => /connect ai/i.test(n))).toBe(true);
  });

  it("every prefilled color passes the skill's normalizeHex grammar", () => {
    for (const value of Object.values(draft.colors)) {
      expect(() => normalizeHex(value as string)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* CSS-absent / inline-only site                                       */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — inline styles only (CSS absent)", () => {
  const html = `<header style="background:#0a0a0a">
    <h1 style="color:#ff5a5f;font-family:Poppins, sans-serif">Stay a while</h1>
    <a class="btn" style="background:#ff5a5f;color:#ffffff">Book now</a>
  </header>`;
  const result = extractBrandCandidates({ html, pageUrl: "https://stay.example" });

  it("flags cssAbsent and still finds the inline accent + font", () => {
    expect(result.diagnostics.cssAbsent).toBe(true);
    expect(result.diagnostics.notes.some((n) => /no stylesheet/i.test(n))).toBe(true);
    const accent = result.colors.find((c) => c.hex === "#ff5a5f");
    expect(accent?.classification).toBe("accent");
    expect(accent?.roles.inline).toBe(true);
    expect(result.fonts.find((f) => f.family === "Poppins")?.role).toBe("display");
  });

  it("proposes the inline accent in the draft", () => {
    const draft = toBrandKitDraft(result);
    expect(draft.colors.accent).toBe("#ff5a5f");
    expect(draft.typography.display).toBe("Poppins, sans-serif");
  });
});

/* ------------------------------------------------------------------ */
/* SVG-logo site                                                       */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — inline SVG logo", () => {
  const html = `<header>
    <svg viewBox="0 0 120 40"><title>BrandCo</title><path d="M0 0h10v10H0z"/></svg>
    <h1>Welcome</h1>
  </header>`;
  const result = extractBrandCandidates({ html, pageUrl: "https://brandco.example" });

  it("surfaces the header SVG as a logo candidate with no addressable URL", () => {
    expect(result.logos[0].kind).toBe("inline-svg");
    expect(result.logos[0].url).toBeNull();
  });

  it("captures the SVG title in the page scan", () => {
    const page = scanPage(tokenize(html));
    expect(page.headerSvgs[0].title).toBe("BrandCo");
  });

  it("does not prefill a logo URL when the only logo is an inline SVG", () => {
    expect(toBrandKitDraft(result).logoUrl).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Favicon-only site                                                   */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — favicon only", () => {
  const html = `<head><link rel="icon" href="https://cdn.site/favicon.png"></head><body><p>hi there friends</p></body>`;
  const result = extractBrandCandidates({ html, pageUrl: "https://site.example" });

  it("uses the favicon as the sole logo candidate and prefills it", () => {
    expect(result.logos).toHaveLength(1);
    expect(result.logos[0].kind).toBe("icon-link");
    expect(result.logos[0].url).toBe("https://cdn.site/favicon.png");
    expect(toBrandKitDraft(result).logoUrl).toBe("https://cdn.site/favicon.png");
  });
});

/* ------------------------------------------------------------------ */
/* Messy / near-duplicate colors                                       */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — near-duplicate colors collapse", () => {
  const css = `.a{color:#2b6cff}.b{color:#2b6dff}.c{color:#2c6cff}.d{color:#2b6cfe}`;
  const result = extractBrandCandidates({ html: `<p>copy copy copy</p>`, pageUrl: "https://x.example", cssBlobs: [css] });

  it("merges perceptually-identical blues into one representative", () => {
    const blues = result.colors.filter((c) => c.hex.startsWith("#2"));
    expect(blues).toHaveLength(1);
    // Equal-score ties resolve deterministically to the lexicographically smallest hex.
    expect(blues[0].hex).toBe("#2b6cfe");
    expect(blues[0].frequency).toBe(4);
  });

  it("keeps genuinely distinct colors separate", () => {
    const css2 = `.a{color:#2b6cff}.b{color:#e5484d}`;
    const r2 = extractBrandCandidates({ html: `<p>x</p>`, pageUrl: "https://x.example", cssBlobs: [css2] });
    expect(r2.colors).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Malformed / hostile input                                           */
/* ------------------------------------------------------------------ */

describe("extractBrandCandidates — malformed & hostile input never throws", () => {
  it("survives broken markup and returns a partial, honest result", () => {
    const html = `<div class="x><<<<< <img src="/a.png" <header><h1>Hi<a href="`;
    expect(() => extractBrandCandidates({ html, pageUrl: "https://x.example" })).not.toThrow();
    const r = extractBrandCandidates({ html, pageUrl: "https://x.example" });
    expect(Array.isArray(r.colors)).toBe(true);
    expect(r.voiceExtractionAvailable).toBe(false);
  });

  it("survives unterminated CSS braces, quotes, and comments", () => {
    const css = `.a{color:#123456;/* unterminated comment .b{background:"unclosed`;
    expect(() => extractBrandCandidates({ html: "<p>x</p>", pageUrl: "https://x.example", cssBlobs: [css] })).not.toThrow();
  });

  it("handles empty and garbage inputs honestly", () => {
    const empty = extractBrandCandidates({ html: "", pageUrl: "" });
    expect(empty.diagnostics.htmlEmpty).toBe(true);
    expect(empty.diagnostics.baseUrlUnusable).toBe(true);
    expect(empty.colors).toEqual([]);
    expect(empty.logos).toEqual([]);
    expect(empty.sourceText).toBe("");
  });

  it("tolerates a non-string html field without throwing", () => {
    // A hostile caller may POST any JSON shape.
    const r = extractBrandCandidates({ html: undefined as unknown as string, pageUrl: "https://x.example" });
    expect(r.diagnostics.htmlEmpty).toBe(true);
  });

  it("clamps an oversized document and discloses the truncation honestly", () => {
    const giant = `<p>${"a".repeat(MAX_INPUT_CHARS + 100)}</p>`;
    const r = extractBrandCandidates({ html: giant, pageUrl: "https://x.example" });
    expect(r.diagnostics.notes.some((n) => /size limit/i.test(n))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Hex grammar edges                                                   */
/* ------------------------------------------------------------------ */

describe("colorsInValue — hex grammar", () => {
  it("accepts 3/4/6/8 hex and normalizes to #rrggbb (alpha dropped)", () => {
    expect(colorsInValue("#fff")).toEqual(["#ffffff"]);
    expect(colorsInValue("#ffff")).toEqual(["#ffffff"]);
    expect(colorsInValue("#abcdef")).toEqual(["#abcdef"]);
    expect(colorsInValue("#abcdef12")).toEqual(["#abcdef"]);
  });

  it("drops invalid hex runs (5/7 digits, non-hex letters)", () => {
    expect(colorsInValue("#12345")).toEqual([]);
    expect(colorsInValue("#1234567")).toEqual([]);
    expect(colorsInValue("#gggggg")).toEqual([]);
    expect(colorsInValue("notacolor")).toEqual([]);
  });

  it("parses rgb()/rgba()/hsl() into hex", () => {
    expect(colorsInValue("rgb(255, 0, 0)")).toEqual(["#ff0000"]);
    expect(colorsInValue("rgba(0,0,0,0.5)")).toEqual(["#000000"]);
    expect(colorsInValue("hsl(210, 100%, 50%)")).toEqual(["#0080ff"]);
  });

  it("classifies chromatic vs neutral by absolute chroma, not inflated saturation", () => {
    expect(classifyColor("#2b6cff")).toBe("accent");
    expect(classifyColor("#111827")).toBe("neutral"); // dark ink, faint blue tint
    expect(classifyColor("#ffffff")).toBe("neutral");
    expect(classifyColor("#000000")).toBe("neutral");
    expect(classifyColor("#6b7280")).toBe("neutral"); // gray-500
  });
});

describe("toBrandKitDraft — never emits an invalid hex or unsafe font stack", () => {
  it("drops a candidate whose hex fails the skill grammar", () => {
    const fake: ExtractedBrandCandidates = {
      colors: [
        { hex: "not-a-hex", frequency: 9, roles: noRoles(), classification: "accent" },
        { hex: "#123456", frequency: 3, roles: noRoles(), classification: "accent" },
      ],
      fonts: [],
      logos: [],
      imagery: [],
      identity: { siteName: null, title: null, tagline: null },
      voiceExtractionAvailable: false,
      sourceText: "",
      diagnostics: { htmlEmpty: false, cssAbsent: false, baseUrlUnusable: false, cssRulesParsed: 0, notes: [] },
    };
    const draft = toBrandKitDraft(fake);
    expect(draft.colors.accent).toBe("#123456");
    expect(Object.values(draft.colors)).not.toContain("not-a-hex");
    for (const value of Object.values(draft.colors)) {
      expect(() => normalizeHex(value as string)).not.toThrow();
    }
  });

  it("drops a font family whose name is not grammar-safe", () => {
    const css = `h1{font-family:"Ha}ck", sans-serif}`;
    const result = extractBrandCandidates({ html: "<h1>x</h1>", pageUrl: "https://x.example", cssBlobs: [css] });
    // The candidate can carry the raw family (it is data)…
    expect(result.fonts[0].family).toBe("Ha}ck");
    // …but the draft never emits an unsafe stack for it.
    const draft = toBrandKitDraft(result);
    expect(draft.typography.display).toBeUndefined();
  });

  it("omits the accent when no chromatic color exists (never fabricates one)", () => {
    const css = `body{background:#ffffff;color:#1a1a1a}`;
    const result = extractBrandCandidates({ html: "<p>x</p>", pageUrl: "https://x.example", cssBlobs: [css] });
    const draft = toBrandKitDraft(result);
    expect(draft.colors.accent).toBeUndefined();
    expect(draft.notes.some((n) => /no clear brand accent/i.test(n))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Structured data + about page + URL resolution                       */
/* ------------------------------------------------------------------ */

describe("readStructuredData — schema.org Organization", () => {
  it("reads Organization name and logo, tolerating invalid JSON blocks", () => {
    const good = `{"@context":"https://schema.org","@type":"Organization","name":"Globex","logo":"https://cdn/globex.png"}`;
    const bad = `{ not valid json `;
    const sd = readStructuredData([bad, good]);
    expect(sd.name).toBe("Globex");
    expect(sd.logo).toBe("https://cdn/globex.png");
  });

  it("feeds the Organization logo + name into extraction when og tags are absent", () => {
    const html = `<head>
      <script type="application/ld+json">{"@type":"Organization","name":"Globex","logo":"/logo.png"}</script>
    </head><body><p>welcome to globex corp today</p></body>`;
    const result = extractBrandCandidates({ html, pageUrl: "https://globex.example/" });
    expect(result.identity.siteName).toBe("Globex");
    expect(result.logos.some((l) => l.kind === "structured-data" && l.url === "https://globex.example/logo.png")).toBe(true);
  });
});

describe("about page copy joins sourceText", () => {
  it("concatenates home + about visible copy for later voice work", () => {
    const home = `<main><p>We build calm software.</p></main>`;
    const about = `<main><p>Founded in a garage in 2011 by two stubborn optimists.</p></main>`;
    const result = extractBrandCandidates({ html: home, pageUrl: "https://calm.example", aboutHtml: about });
    expect(result.sourceText).toContain("calm software");
    expect(result.sourceText).toContain("stubborn optimists");
  });
});

describe("URL resolution", () => {
  it("resolves relative, absolute and protocol-relative to absolute http(s)", () => {
    expect(resolveUrl("/a/b.png", "https://x.example/page")).toBe("https://x.example/a/b.png");
    expect(resolveUrl("https://cdn/x.png", null)).toBe("https://cdn/x.png");
    expect(resolveUrl("//cdn.io/x.png", "https://x.example")).toBe("https://cdn.io/x.png");
  });

  it("drops non-addressable and unparseable references", () => {
    expect(resolveUrl("data:image/png;base64,AAAA", "https://x.example")).toBeNull();
    expect(resolveUrl("javascript:alert(1)", "https://x.example")).toBeNull();
    expect(resolveUrl("mailto:a@b.c", "https://x.example")).toBeNull();
    expect(resolveUrl("/rel.png", null)).toBeNull();
    expect(resolveUrl("", "https://x.example")).toBeNull();
  });

  it("usableBase rejects non-http(s) and junk", () => {
    expect(usableBase("https://ok.example/")).toBe("https://ok.example/");
    expect(usableBase("ftp://x")).toBeNull();
    expect(usableBase("not a url")).toBeNull();
  });

  it("fileNameOf strips query/hash and lowercases", () => {
    expect(fileNameOf("https://x/ASSETS/Logo.SVG?v=2#a")).toBe("logo.svg");
  });
});

/* ------------------------------------------------------------------ */
/* Font + selector + meta-color unit checks                            */
/* ------------------------------------------------------------------ */

describe("parseGoogleFamilies", () => {
  it("parses css2 and legacy family params", () => {
    expect(parseGoogleFamilies(["https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter"]))
      .toEqual(["Playfair Display", "Inter"]);
    expect(parseGoogleFamilies(["https://fonts.googleapis.com/css?family=Roboto|Open+Sans:400,700"]))
      .toEqual(["Roboto", "Open Sans"]);
  });
});

describe("classifySelector", () => {
  it("recognizes headings, links, buttons, mono and body selectors", () => {
    expect(classifySelector("h1").isHeading).toBe(true);
    expect(classifySelector("nav a:hover").isLink).toBe(true);
    expect(classifySelector(".btn-primary").isButton).toBe(true);
    expect(classifySelector("code").isMono).toBe(true);
    expect(classifySelector("body").isBody).toBe(true);
    expect(classifySelector(".hero-title").isHeading).toBe(true);
  });
});

describe("theme-color meta becomes a brand color", () => {
  it("weights a theme-color meta as a brand accent", () => {
    const colors = extractColors({
      rules: [],
      inlineStyles: [],
      metaByName: new Map([["theme-color", "#7c3aed"]]),
    });
    expect(colors[0].hex).toBe("#7c3aed");
    expect(colors[0].roles.brandVariable).toBe(true);
    expect(colors[0].classification).toBe("accent");
  });
});

describe("parseCss — flattens @media, collects @font-face", () => {
  it("sees rules inside @media and captures @font-face families", () => {
    const css = `@media (min-width:600px){ .btn{ background:#ff0000 } } @font-face{ font-family:"Souvenir"; src:url(x.woff2) }`;
    const parsed = parseCss([css]);
    expect(parsed.rules.some((r) => r.selectors.includes(".btn"))).toBe(true);
    expect(parsed.fontFaces[0].some((d) => d.prop === "font-family")).toBe(true);
  });
});

describe("near-duplicate distance threshold is honored", () => {
  it("uses the documented RGB distance to decide a collapse", () => {
    // Sanity: the threshold is a small radius, not a catch-all.
    expect(NEAR_DUP_DISTANCE).toBeLessThan(20);
  });
});
