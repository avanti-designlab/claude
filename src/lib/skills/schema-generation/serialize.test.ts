/**
 * Script-block serialization guards (0.2 gate: CR finding 2 + QA finding 4).
 *
 * - `serializeToScriptBlock` accepts ONLY a ready result — the one-line bypass
 *   `serializeToScriptBlock(rejected.draftJsonLd)` must not compile.
 * - A literal "</script>" that legitimately appears in visible content is
 *   escaped to its \u003c JSON form so the emitted block can never be closed
 *   early by embedded data.
 */

import { describe, expect, it } from "vitest";
import { generateSchema, serializeToScriptBlock } from "./generate";
import type {
  JsonLdObject,
  SchemaGenerationReady,
  SchemaGenerationRejected,
} from "./types";

function makeReady(): SchemaGenerationReady {
  const result = generateSchema({
    schemaType: "FAQPage",
    entity: {
      faqs: [{ question: "Do you deliver?", answer: "Yes, same day across San Diego." }],
    },
    visiblePageText: "Do you deliver? Yes, same day across San Diego.",
  });
  if (result.status !== "ready") throw new Error("fixture should be ready");
  return result;
}

function makeRejected(): SchemaGenerationRejected {
  const result = generateSchema({
    schemaType: "FAQPage",
    entity: { faqs: [{ question: "Do you deliver?", answer: "Yes, same day." }] },
    visiblePageText: "Totally unrelated page about socks.",
  });
  if (result.status !== "rejected") throw new Error("fixture should be rejected");
  return result;
}

describe("serializeToScriptBlock — ready-only surface (CR finding 2)", () => {
  it("round-trips the ready path: re-serializing a ready result reproduces its scriptBlock exactly", () => {
    const ready = makeReady();
    expect(serializeToScriptBlock(ready)).toBe(ready.scriptBlock);
  });

  it("rejects the rejected-path bypass at compile time", () => {
    const rejected = makeRejected();
    expect(rejected.draftJsonLd).toBeDefined();
    const bypassDraft = () =>
      // @ts-expect-error -- 0.2 CR gate: a rejected draft (JsonLdObject) is not a SchemaGenerationReady and must not be serializable
      serializeToScriptBlock(rejected.draftJsonLd);
    const bypassResult = () =>
      // @ts-expect-error -- 0.2 CR gate: a rejected result must not be serializable
      serializeToScriptBlock(rejected);
    // Never invoked — the guard is the compile-time rejection above. If either
    // call ever compiles again, tsc fails with "Unused '@ts-expect-error'".
    expect(typeof bypassDraft).toBe("function");
    expect(typeof bypassResult).toBe("function");
  });
});

describe("script-block escaping (QA finding 4)", () => {
  it("escapes a literal </script> that legitimately appears in visible content", () => {
    const answer = "Remove the trailing </script> tag from the embed snippet before pasting it.";
    const result = generateSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question: "Why does my embed break?", answer }] },
      visiblePageText: `Why does my embed break? ${answer}`,
    });
    if (result.status !== "ready") throw new Error("fixture should be ready");

    // The only raw </script> in the block is the closing tag itself.
    expect(result.scriptBlock.match(/<\/script>/g)).toHaveLength(1);
    expect(result.scriptBlock.endsWith("</script>")).toBe(true);
    // The embedded occurrence is escaped to its \u003c JSON form...
    expect(result.scriptBlock).toContain("\\u003c/script>");
    // ...and JSON.parse restores the original text byte-for-byte.
    const body = result.scriptBlock.split("\n").slice(1, -1).join("\n");
    const parsed = JSON.parse(body) as JsonLdObject;
    const mainEntity = parsed.mainEntity as JsonLdObject[];
    expect((mainEntity[0].acceptedAnswer as JsonLdObject).text).toBe(answer);
    expect(parsed).toEqual(result.jsonLd);
  });
});
