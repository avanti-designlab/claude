/**
 * Extraction suite (M2 crawl layer): fidelity on real-shaped HTML, and the
 * hostile-input discipline — pathological markup must terminate, never throw,
 * and never balloon past the documented caps. Client sites are untrusted
 * input; the extractor is the first thing their bytes touch.
 */

import { describe, expect, it } from "vitest";
import {
  extractDoc,
  MAX_H1S,
  MAX_HREFS,
  MAX_IMAGES,
  MAX_JSONLD_BLOCKS,
  MAX_VISIBLE_TEXT_CHARS,
} from "./extract";

describe("extractDoc — fidelity on well-formed HTML", () => {
  const PAGE = `<!doctype html>
<html><head>
  <title>Dubai Off-Plan Guide &amp; FAQ</title>
  <meta charset="utf-8">
  <meta name="description" content="What buyers ask about off-plan purchases &amp; escrow.">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","dateModified":"2026-06-01T00:00:00Z"}</script>
  <style>body { color: red }</style>
</head><body>
  <h1>Off-plan buying, answered</h1>
  <p>Yes — foreigners can buy off-plan in Dubai. Escrow accounts protect the deposit until handover.</p>
  <a href="/faq">FAQ</a>
  <a href="/faq">FAQ again</a>
  <a href="https://example.com/guides/escrow?utm=x#top">Escrow guide</a>
  <img src="/img/tower.jpg" alt="Marina skyline">
  <img src="/img/deco.png" alt="">
  <img src="/img/no-alt.png">
  <iframe src="https://www.youtube.com/embed/abc123"></iframe>
  <h2>Video transcript</h2>
  <p>Full transcript of the walkthrough…</p>
  <script src="/app.js"></script>
</body></html>`;

  it("captures title, meta description, h1s, JSON-LD, images, links, video + transcript markers", () => {
    const doc = extractDoc(PAGE);
    expect(doc.title).toBe("Dubai Off-Plan Guide & FAQ");
    expect(doc.metaDescription).toBe("What buyers ask about off-plan purchases & escrow.");
    expect(doc.h1s).toEqual(["Off-plan buying, answered"]);
    expect(doc.jsonLdBlocks).toHaveLength(1);
    expect(JSON.parse(doc.jsonLdBlocks[0])).toMatchObject({ "@type": "FAQPage" });
    expect(doc.images).toEqual([
      { src: "/img/tower.jpg", alt: "Marina skyline" },
      { src: "/img/deco.png", alt: "" }, // empty alt = decorative, covered
      { src: "/img/no-alt.png", alt: null }, // ABSENT alt — distinct from ""
    ]);
    // hrefs are raw + deduplicated; origin filtering is the crawler's job.
    expect(doc.hrefs).toEqual(["/faq", "https://example.com/guides/escrow?utm=x#top"]);
    expect(doc.hasVideo).toBe(true); // youtube iframe
    expect(doc.hasTranscriptMarker).toBe(true); // heading text
    expect(doc.hasScripts).toBe(true); // /app.js
    expect(doc.jsonLdDateModified).toBe("2026-06-01T00:00:00Z");
  });

  it("visible text excludes script/style/title/JSON-LD content — nothing non-visible leaks into the scored text", () => {
    const doc = extractDoc(PAGE);
    expect(doc.visibleText).toContain("Escrow accounts protect the deposit");
    expect(doc.visibleText).not.toContain("color: red"); // style
    expect(doc.visibleText).not.toContain("schema.org"); // JSON-LD
    expect(doc.visibleText).not.toContain("Dubai Off-Plan Guide"); // title
  });

  it("transcript marker also fires on id/class, and NOT on prose merely mentioning the word", () => {
    expect(extractDoc(`<div class="video-transcript">…</div>`).hasTranscriptMarker).toBe(true);
    expect(extractDoc(`<section id="Transcript"><p>text</p></section>`).hasTranscriptMarker).toBe(true);
    // The word in a paragraph is NOT an indexable-transcript signal — a false
    // positive would hand out unearned rubric credit.
    expect(extractDoc(`<p>Ask us for a transcript of the call.</p>`).hasTranscriptMarker).toBe(false);
  });

  it("hasVideo: <video> yes; unrelated iframe no; data-block scripts don't count as JS", () => {
    expect(extractDoc(`<video src="/v.mp4"></video>`).hasVideo).toBe(true);
    expect(extractDoc(`<iframe src="https://maps.example/embed"></iframe>`).hasVideo).toBe(false);
    // application/json data blocks (Next.js __NEXT_DATA__) are not executable JS.
    const ssr = extractDoc(`<script type="application/json">{"props":{}}</script><p>content</p>`);
    expect(ssr.hasScripts).toBe(false);
  });

  it("first title / first meta description win; later duplicates are ignored", () => {
    const doc = extractDoc(
      `<title>First</title><title>Second</title>` +
        `<meta name="description" content="one"><meta name="description" content="two">`,
    );
    expect(doc.title).toBe("First");
    expect(doc.metaDescription).toBe("one");
  });

  it("newest dateModified wins across multiple JSON-LD blocks; invalid dates ignored", () => {
    const doc = extractDoc(
      `<script type="application/ld+json">{"@type":"Article","dateModified":"2026-01-01"}</script>` +
        `<script type="application/ld+json">{"@graph":[{"dateModified":"2026-05-01"},{"dateModified":"not-a-date"}]}</script>`,
    );
    expect(doc.jsonLdDateModified).toBe("2026-05-01");
  });
});

describe("extractDoc — hostile and malformed HTML (must terminate, never throw)", () => {
  it("a flood of stray '<' characters terminates and yields text", () => {
    const doc = extractDoc("<".repeat(50_000));
    expect(doc.h1s).toEqual([]);
  });

  it("'<a<a<a' tag-soup floods terminate", () => {
    const doc = extractDoc("<a<a".repeat(25_000));
    expect(doc.hrefs).toEqual([]);
  });

  it("unclosed script/comment/quote all run to end-of-input without hanging", () => {
    // Unclosed script: everything after is raw text — the secret must not
    // leak into visibleText.
    const unclosedScript = extractDoc(`<p>seen</p><script>var secret = "S3CRET";`);
    expect(unclosedScript.visibleText).toContain("seen");
    expect(unclosedScript.visibleText).not.toContain("S3CRET");

    const unclosedComment = extractDoc(`<p>before</p><!-- never closed <p>hidden</p>`);
    expect(unclosedComment.visibleText).toBe("before");

    // Unclosed attribute quote: the "value" swallows the rest of the input —
    // bounded, terminates, and nothing downstream is misparsed as tags.
    const unclosedQuote = extractDoc(`<a href="/x><p>swallowed</p>`);
    expect(unclosedQuote.hrefs).toEqual(["/x><p>swallowed</p>"]);
    expect(unclosedQuote.visibleText).toBe("");
  });

  it("attribute bombs are skipped past without collecting them", () => {
    const bomb = `<img ${Array.from({ length: 500 }, (_, i) => `a${i}=v`).join(" ")} src="/x.png" alt="late">`;
    const doc = extractDoc(bomb);
    // The tag terminates at its ">"; src/alt sit beyond the attr-examination
    // cap, so the image is honestly dropped rather than half-parsed.
    expect(doc.images).toEqual([]);
  });

  it("NUL bytes and control characters pass through without breaking scanning", () => {
    const nul = String.fromCharCode(0);
    const doc = extractDoc(`<p>a${nul}b</p><h1>ok${nul}</h1>`);
    expect(doc.h1s).toHaveLength(1);
    expect(doc.h1s[0]).toContain("ok");
  });

  it("collection caps hold: hrefs, images, h1s, JSON-LD blocks, visible text", () => {
    const links = Array.from({ length: MAX_HREFS + 500 }, (_, i) => `<a href="/p${i}">x</a>`).join("");
    expect(extractDoc(links).hrefs).toHaveLength(MAX_HREFS);

    const imgs = Array.from({ length: MAX_IMAGES + 100 }, (_, i) => `<img src="/i${i}.png">`).join("");
    expect(extractDoc(imgs).images).toHaveLength(MAX_IMAGES);

    const h1s = Array.from({ length: MAX_H1S + 10 }, (_, i) => `<h1>h${i}</h1>`).join("");
    expect(extractDoc(h1s).h1s).toHaveLength(MAX_H1S);

    const blocks = Array.from(
      { length: MAX_JSONLD_BLOCKS + 10 },
      () => `<script type="application/ld+json">{"@type":"Thing"}</script>`,
    ).join("");
    expect(extractDoc(blocks).jsonLdBlocks).toHaveLength(MAX_JSONLD_BLOCKS);

    const text = extractDoc(`<p>${"word ".repeat(100_000)}</p>`);
    expect(text.visibleText.length).toBeLessThanOrEqual(MAX_VISIBLE_TEXT_CHARS);
  });

  it("deeply nested unbalanced markup terminates with sane output", () => {
    const doc = extractDoc(`${"<div><span>".repeat(20_000)}<h1>deep</h1>`);
    expect(doc.h1s).toEqual(["deep"]); // unclosed trailing heading still flushes
  });

  it("empty and whitespace-only inputs extract to an honestly empty document", () => {
    for (const input of ["", "   \n\t  "]) {
      const doc = extractDoc(input);
      expect(doc.title).toBeNull();
      expect(doc.metaDescription).toBeNull();
      expect(doc.visibleText).toBe("");
      expect(doc.hasVideo).toBe(false);
    }
  });

  it("is deterministic: identical input → identical output", () => {
    const input = `<title>t</title><h1>h</h1><a href="/a">a</a><a href="/b">b</a><img src="/i.png">`;
    expect(JSON.stringify(extractDoc(input))).toBe(JSON.stringify(extractDoc(input)));
  });
});
