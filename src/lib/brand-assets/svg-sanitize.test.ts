import { describe, expect, it } from "vitest";
import {
  sanitizeSvg,
  sanitizeSvgOrThrow,
  SvgUnsafeError,
  SVG_SANITIZE_MAX_CHARS,
  type SvgRefusalReason,
} from "./svg-sanitize";

/**
 * Adversarial coverage for the security-critical SVG sanitizer (Orchestrator
 * ruling, condition 6a — 0-bypass standard). Every hostile input MUST refuse;
 * every clean brand-logo shape MUST pass. A refusal never emits bytes.
 */

function expectRefused(input: string, reason?: SvgRefusalReason) {
  const res = sanitizeSvg(input);
  expect(res.ok, `expected refusal for: ${input.slice(0, 80)}`).toBe(false);
  if (!res.ok && reason) expect(res.reason).toBe(reason);
}

function expectSafe(input: string) {
  const res = sanitizeSvg(input);
  expect(res.ok, `expected SAFE for: ${input.slice(0, 80)}`).toBe(true);
}

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';

describe("SVG sanitizer — script execution vectors are refused (0-bypass)", () => {
  it("refuses a <script> element", () => {
    expectRefused(`${SVG_OPEN}<script>alert(1)</script></svg>`, "disallowed_element");
  });

  it("refuses <script> regardless of case", () => {
    expectRefused(`${SVG_OPEN}<ScRiPt>alert(1)</ScRiPt></svg>`, "disallowed_element");
    expectRefused(`${SVG_OPEN}<SCRIPT>alert(1)</SCRIPT></svg>`, "disallowed_element");
  });

  it('refuses "< script" whitespace-split tag (matches browser text-node behavior, fail closed)', () => {
    expectRefused(`${SVG_OPEN}< script>alert(1)</script></svg>`, "malformed");
  });

  it("refuses an on* event handler on the root", () => {
    expectRefused(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>`,
      "event_handler"
    );
  });

  it("refuses on* handlers regardless of case or which handler", () => {
    expectRefused(`${SVG_OPEN}<rect OnClick="x()"/></svg>`, "event_handler");
    expectRefused(`${SVG_OPEN}<a onmouseover="x()">x</a></svg>`, "event_handler");
    expectRefused(`${SVG_OPEN}<rect onfocusin="x()"/></svg>`, "event_handler");
  });

  it("refuses <foreignObject> (and nested)", () => {
    expectRefused(
      `${SVG_OPEN}<foreignObject><div>x</div></foreignObject></svg>`,
      "disallowed_element"
    );
    expectRefused(
      `${SVG_OPEN}<g><foreignObject><foreignObject>x</foreignObject></foreignObject></g></svg>`,
      "disallowed_element"
    );
  });

  it("refuses SMIL animation elements (set/animate/animateMotion) — a known XSS vector", () => {
    expectRefused(
      `${SVG_OPEN}<a><set attributeName="href" to="javascript:alert(1)"/></a></svg>`,
      "disallowed_element"
    );
    expectRefused(`${SVG_OPEN}<animate attributeName="x"/></svg>`, "disallowed_element");
    expectRefused(`${SVG_OPEN}<animateMotion/></svg>`, "disallowed_element");
  });

  it("refuses iframe/embed/object/feImage", () => {
    expectRefused(`${SVG_OPEN}<iframe src="x"></iframe></svg>`, "disallowed_element");
    expectRefused(`${SVG_OPEN}<embed src="x"/></svg>`, "disallowed_element");
    expectRefused(`${SVG_OPEN}<object data="x"></object></svg>`, "disallowed_element");
    expectRefused(`${SVG_OPEN}<feImage href="x"/></svg>`, "disallowed_element");
  });
});

describe("SVG sanitizer — external / smuggled references are refused", () => {
  it("refuses javascript: in xlink:href", () => {
    expectRefused(
      `${SVG_OPEN}<a xlink:href="javascript:alert(1)">x</a></svg>`,
      "external_reference"
    );
  });

  it("refuses javascript: smuggled via numeric character reference", () => {
    // &#106; = 'j' → "javascript:" after decode.
    expectRefused(
      `${SVG_OPEN}<a xlink:href="&#106;avascript:alert(1)">x</a></svg>`,
      "external_reference"
    );
  });

  it("refuses javascript: smuggled via hex character reference + whitespace", () => {
    expectRefused(
      `${SVG_OPEN}<a href="&#x6a;a\tva\nscript:alert(1)">x</a></svg>`,
      "external_reference"
    );
  });

  it("refuses external http(s) href on <use>/<image>/<a>", () => {
    expectRefused(`${SVG_OPEN}<use href="https://evil.example/x#y"/></svg>`, "external_reference");
    expectRefused(`${SVG_OPEN}<image href="http://evil.example/x.png"/></svg>`, "external_reference");
    expectRefused(`${SVG_OPEN}<a href="//evil.example/x">x</a></svg>`, "external_reference");
  });

  it("refuses data: URIs in href (embedded objects/images)", () => {
    expectRefused(
      `${SVG_OPEN}<image xlink:href="data:image/png;base64,AAAA"/></svg>`,
      "external_reference"
    );
    expectRefused(
      `${SVG_OPEN}<a href="data:text/html,<script>alert(1)</script>">x</a></svg>`,
      "external_reference"
    );
  });

  it("refuses data:text/html smuggled in a non-URL attribute (catch-all)", () => {
    expectRefused(`${SVG_OPEN}<rect fill="data:text/html,x"/></svg>`, "dangerous_attribute");
  });
});

describe("SVG sanitizer — CSS execution/fetch vectors are refused", () => {
  it("refuses expression() in a style attribute", () => {
    expectRefused(`${SVG_OPEN}<rect style="width:expression(alert(1))"/></svg>`, "dangerous_css");
  });

  it("refuses @import in a <style> element body", () => {
    expectRefused(`${SVG_OPEN}<style>@import url(http://evil.example/x.css)</style></svg>`, "dangerous_css");
  });

  it("refuses external url() in a <style> element body", () => {
    expectRefused(
      `${SVG_OPEN}<style>.a{background:url(http://evil.example/x.png)}</style></svg>`,
      "dangerous_css"
    );
  });

  it("refuses -moz-binding and javascript: url in style", () => {
    expectRefused(`${SVG_OPEN}<rect style="-moz-binding:url(x)"/></svg>`, "dangerous_css");
    expectRefused(`${SVG_OPEN}<rect style="background:url(javascript:alert(1))"/></svg>`, "dangerous_css");
  });

  it("refuses CSS-COMMENT-split tokens (expr/*..*/ession, @imp/*..*/ort) in style attrs AND <style> bodies", () => {
    // Inline CSS comments must not defeat the token scan — they are stripped
    // before the includes() checks. Build the split with concatenation so the
    // CSS comment delimiters never appear literally in THIS block comment.
    const c = "/*x*/";
    expectRefused(`${SVG_OPEN}<rect style="width:expr${c}ession(alert(1))"/></svg>`, "dangerous_css");
    expectRefused(
      `${SVG_OPEN}<style>@imp${c}ort url(http://evil.example/x.css)</style></svg>`,
      "dangerous_css"
    );
    expectRefused(
      `${SVG_OPEN}<style>.a{background:url${c}(http://evil.example/x.png)}</style></svg>`,
      "dangerous_css"
    );
  });

  it("still passes SAFE CSS that merely CONTAINS a comment", () => {
    expectSafe(`${SVG_OPEN}<style>/* brand palette */ .a{fill:#0b0b0f}</style><rect class="a"/></svg>`);
  });
});

describe("SVG sanitizer — XML/entity/encoding attacks are refused", () => {
  it("refuses a DOCTYPE with an internal ENTITY subset (billion-laughs / XXE)", () => {
    expectRefused(
      `<!DOCTYPE svg [ <!ENTITY lol "lol"> ]>${SVG_OPEN}<rect/></svg>`,
      "doctype"
    );
  });

  it("refuses any DOCTYPE (conservative — clean logos need none)", () => {
    expectRefused(`<!DOCTYPE svg>${SVG_OPEN}<rect/></svg>`, "doctype");
  });

  it("refuses a CDATA section", () => {
    expectRefused(`${SVG_OPEN}<![CDATA[ <script>alert(1)</script> ]]></svg>`, "cdata");
  });

  it("refuses a non-xml processing instruction", () => {
    expectRefused(`<?php system("x"); ?>${SVG_OPEN}<rect/></svg>`, "processing_instruction");
  });

  it("refuses NUL / C0 control bytes (encoding smuggling)", () => {
    const NUL = String.fromCharCode(0);
    const VT = String.fromCharCode(0x0b); // vertical tab (a C0 control)
    expectRefused(`${SVG_OPEN}<rect/>${NUL}</svg>`, "control_chars");
    expectRefused(`${SVG_OPEN}<rect${VT}/></svg>`, "control_chars");
  });

  it("refuses a non-UTF-8/ASCII XML encoding declaration", () => {
    expectRefused(
      `<?xml version="1.0" encoding="UTF-16"?>${SVG_OPEN}<rect/></svg>`,
      "bad_encoding"
    );
  });

  it("refuses foreign-namespaced elements (e.g. RDF in <metadata>)", () => {
    expectRefused(
      `${SVG_OPEN}<metadata><rdf:RDF xmlns:rdf="x"><rdf:Work/></rdf:RDF></metadata></svg>`,
      "disallowed_element"
    );
  });

  it("refuses an unbalanced comment (no closing -->)", () => {
    expectRefused(`${SVG_OPEN}<!-- unclosed <rect/></svg>`, "malformed");
  });
});

describe("SVG sanitizer — structural refusals", () => {
  it("refuses empty / non-string input", () => {
    expectRefused("", "empty");
    expect(sanitizeSvg(null).ok).toBe(false);
    expect(sanitizeSvg(undefined).ok).toBe(false);
    expect(sanitizeSvg(42 as unknown).ok).toBe(false);
  });

  it("refuses input with no <svg> root", () => {
    expectRefused(`<rect/>`, "not_svg");
  });

  it("refuses a disallowed non-svg root element", () => {
    expectRefused(`<div>x</div>`, "disallowed_element");
  });

  it("refuses input over the parser ceiling", () => {
    const huge = `${SVG_OPEN}` + "<rect/>".repeat(SVG_SANITIZE_MAX_CHARS) + "</svg>";
    expectRefused(huge, "too_large");
  });
});

describe("SVG sanitizer — clean brand logos pass, and comments/prolog are stripped", () => {
  it("passes a minimal path logo", () => {
    expectSafe(`${SVG_OPEN}<path d="M0 0h10v10z" fill="#0b0b0f"/></svg>`);
  });

  it("passes groups, gradients, title/desc, and same-document <use>", () => {
    expectSafe(
      `${SVG_OPEN}<title>Logo</title><desc>Brand mark</desc>` +
        `<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>` +
        `<g fill="url(#g)"><rect x="0" y="0" width="10" height="10"/></g>` +
        `<use href="#g"/></svg>`
    );
  });

  it("passes and strips a leading <?xml?> prolog + benign comment", () => {
    const res = sanitizeSvg(
      `<?xml version="1.0" encoding="utf-8"?><!-- Generated by tool --><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.svg).not.toContain("<?xml");
      expect(res.svg).not.toContain("<!--");
    }
  });

  it("strips a comment that HID a script tag (the script never survives)", () => {
    const res = sanitizeSvg(`${SVG_OPEN}<!-- <script>alert(1)</script> --><rect/></svg>`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.svg.toLowerCase()).not.toContain("<script");
  });

  it("passes safe CSS in a <style> element and a style attribute", () => {
    expectSafe(`${SVG_OPEN}<style>.a{fill:#0b0b0f}</style><rect class="a"/></svg>`);
    expectSafe(`${SVG_OPEN}<rect style="fill:#0b0b0f;stroke:#fff"/></svg>`);
  });

  it("passes the standard xmlns / xmlns:xlink declarations", () => {
    expectSafe(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect/></svg>`
    );
  });
});

describe("sanitizeSvgOrThrow", () => {
  it("returns the safe svg for clean input", () => {
    const out = sanitizeSvgOrThrow(`${SVG_OPEN}<rect/></svg>`);
    expect(out).toContain("<rect");
  });

  it("throws SvgUnsafeError with the reason for hostile input", () => {
    try {
      sanitizeSvgOrThrow(`${SVG_OPEN}<script>x</script></svg>`);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SvgUnsafeError);
      expect((err as SvgUnsafeError).reason).toBe("disallowed_element");
    }
  });
});
