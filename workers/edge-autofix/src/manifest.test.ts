/**
 * Manifest wire-format suite — the contract BOTH halves depend on: the
 * CloudflareEdgeAdapter writes exactly this format and byte-verifies it; the
 * worker parses it strictly and fails OPEN on anything else. Every rejection
 * here is a case where the worker must serve the origin untouched and the
 * adapter must refuse to clobber foreign data.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  edgeRuleId,
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  parseManifest,
  serializeManifest,
  type EdgeRule,
  type EdgeRulesManifest,
} from "./manifest";

const IMG_SRC = "https://cdn.example.com/photos/casa uno — exterior.jpg";

function allOpsManifest(): EdgeRulesManifest {
  const rules: EdgeRule[] = [
    {
      id: "title@/pricing",
      enabled: true,
      path: "/pricing",
      op: "set_title",
      payload: { text: "Pricing | GG Realty" },
    },
    {
      id: "meta-description@/pricing",
      enabled: true,
      path: "/pricing",
      op: "set_meta_description",
      payload: { content: "Transparent pricing for San Diego sellers." },
    },
    {
      id: "canonical@/pricing",
      enabled: false,
      path: "/pricing",
      op: "set_canonical",
      payload: { href: "https://ggrealty.example/pricing" },
    },
    {
      id: "jsonld.faq@/pricing",
      enabled: true,
      path: "/pricing",
      op: "upsert_json_ld",
      payload: { scriptId: "faq", json: { "@type": "FAQPage" } },
    },
    {
      id: `img-alt.${base64UrlEncode(IMG_SRC)}@/listings`,
      enabled: true,
      path: "/listings",
      op: "set_img_alt",
      payload: { src: IMG_SRC, alt: "Casa Uno exterior at dusk" },
    },
  ];
  return {
    format: MANIFEST_FORMAT,
    formatVersion: MANIFEST_FORMAT_VERSION,
    version: 7,
    updatedAt: "2026-07-09T12:00:00.000Z",
    rules,
  };
}

describe("serialize → parse round-trip", () => {
  it("round-trips a manifest carrying every operation kind, byte-stable", () => {
    const manifest = allOpsManifest();
    const text = serializeManifest(manifest);
    const parsed = parseManifest(text);
    expect(parsed).not.toBeNull();
    // Rules come back sorted by id (canonical form)...
    expect(parsed!.rules.map((r) => r.id)).toEqual(
      [...manifest.rules.map((r) => r.id)].sort(),
    );
    // ...and re-serializing the parse is BYTE-IDENTICAL — the property the
    // adapter's write verification is built on.
    expect(serializeManifest(parsed!)).toBe(text);
    expect(parsed!.version).toBe(7);
  });

  it("serialization is canonical: rule order in memory does not change the bytes", () => {
    const manifest = allOpsManifest();
    const reversed: EdgeRulesManifest = {
      ...manifest,
      rules: [...manifest.rules].reverse(),
    };
    expect(serializeManifest(reversed)).toBe(serializeManifest(manifest));
  });
});

describe("strict parse — all-or-nothing rejection", () => {
  const valid = () => JSON.parse(serializeManifest(allOpsManifest()));

  function expectRejected(mutate: (doc: ReturnType<typeof valid>) => void) {
    const doc = valid();
    mutate(doc);
    expect(parseManifest(JSON.stringify(doc))).toBeNull();
  }

  it("rejects non-JSON, non-object, and array documents", () => {
    expect(parseManifest("not json {{{")).toBeNull();
    expect(parseManifest('"a string"')).toBeNull();
    expect(parseManifest("[]")).toBeNull();
    expect(parseManifest("null")).toBeNull();
  });

  it("rejects a foreign format marker and a future formatVersion", () => {
    expectRejected((d) => (d.format = "someone-elses/rules"));
    expectRejected((d) => (d.formatVersion = 2));
  });

  it("rejects a bad version (negative, float, string) and a missing updatedAt", () => {
    expectRejected((d) => (d.version = -1));
    expectRejected((d) => (d.version = 1.5));
    expectRejected((d) => (d.version = "7"));
    expectRejected((d) => delete d.updatedAt);
  });

  it("rejects extra top-level keys and extra rule/payload keys (no smuggling)", () => {
    expectRejected((d) => (d.extra = true));
    expectRejected((d) => (d.rules[0].note = "hand edit"));
    expectRejected((d) => (d.rules[0].payload.also = "x"));
  });

  it("rejects unknown operations and malformed payloads — ONE bad rule kills the document", () => {
    expectRejected((d) => (d.rules[0].op = "regex_replace"));
    expectRejected((d) => (d.rules[0].payload = { pattern: "a", replace: "b" }));
    expectRejected((d) => (d.rules[0].payload = { text: 42 }));
    expectRejected((d) => (d.rules[3].payload.json = ["not", "an", "object"]));
    expectRejected((d) => (d.rules[3].payload.scriptId = "bad/slash"));
    expectRejected((d) => (d.rules[4].payload.src = ""));
  });

  it("rejects a path that does not start with '/' and a non-boolean enabled", () => {
    expectRejected((d) => {
      d.rules[0].path = "pricing";
      d.rules[0].id = "title@pricing";
    });
    expectRejected((d) => (d.rules[0].enabled = "yes"));
  });

  it("rejects duplicate ids and an id that is not its own derivation (tamper evidence)", () => {
    expectRejected((d) => d.rules.push({ ...d.rules[0] }));
    // Point the rule at another page without re-deriving the id.
    expectRejected((d) => (d.rules[0].path = "/other"));
    expectRejected((d) => (d.rules[0].id = "title@/other"));
  });

  it("accepts disabled rules (a parse concern, not a policy one)", () => {
    const parsed = parseManifest(serializeManifest(allOpsManifest()));
    expect(parsed!.rules.find((r) => r.op === "set_canonical")!.enabled).toBe(
      false,
    );
  });
});

describe("rule identity", () => {
  it("derives ids as {op-slug}[.{discriminator}]@{path} — single header-safe tokens", () => {
    const manifest = allOpsManifest();
    for (const rule of manifest.rules) {
      expect(edgeRuleId(rule)).toBe(rule.id);
      // Header-safe single token: id lists are space-separated in the
      // worker's x-edge-autofix header.
      expect(rule.id).not.toMatch(/[\s,;]/);
    }
  });

  it("two rules can never share a slot: same (op, path, discriminator) ⇒ same id", () => {
    expect(
      edgeRuleId({ op: "set_title", path: "/a", payload: { text: "x" } }),
    ).toBe(edgeRuleId({ op: "set_title", path: "/a", payload: { text: "y" } }));
    expect(
      edgeRuleId({
        op: "upsert_json_ld",
        path: "/a",
        payload: { scriptId: "faq", json: {} },
      }),
    ).not.toBe(
      edgeRuleId({
        op: "upsert_json_ld",
        path: "/a",
        payload: { scriptId: "article", json: {} },
      }),
    );
  });
});

describe("base64url (img-src discriminators)", () => {
  it("round-trips ASCII, URL characters, and non-ASCII text", () => {
    for (const value of [
      "a",
      "ab",
      "abc",
      IMG_SRC,
      "https://x.example/α β γ/фото.png?v=1&w=2",
      "",
    ]) {
      expect(base64UrlDecode(base64UrlEncode(value))).toBe(value);
    }
  });

  it("emits only id-grammar characters (no +, /, =)", () => {
    expect(base64UrlEncode(IMG_SRC)).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it("decode rejects non-alphabet input and impossible lengths", () => {
    expect(base64UrlDecode("not+base64/url=")).toBeNull();
    expect(base64UrlDecode("aaaaa")).toBeNull(); // length % 4 === 1
    expect(base64UrlDecode("/etc/passwd")).toBeNull();
  });
});
