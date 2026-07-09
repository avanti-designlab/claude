/**
 * buildSchemaChange — the change-management GENERATE feed (M10, doc 04 §2 step 1).
 *
 * Proves M10 shapes a READY artifact into a valid `DesiredChange` and that a
 * rejected result is not assignable (compile-time ready-only, mirroring the
 * skill's serializeToScriptBlock one-way valve).
 */

import { describe, expect, it } from "vitest";
import type { DesiredChange } from "@/lib/change-management";
import { produceSchema } from "./produce";
import { buildSchemaChange, type SchemaChangeSpec } from "./change";

function readyFaq() {
  const q = "Do you deliver?";
  const a = "Yes, same day across San Diego.";
  const result = produceSchema({
    schemaType: "FAQPage",
    entity: { faqs: [{ question: q, answer: a }] },
    visible: `${q} ${a}`,
  });
  if (result.status !== "ready") throw new Error("fixture should be ready");
  return result;
}

const SPEC: SchemaChangeSpec = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  clientId: "22222222-2222-2222-2222-222222222222",
  propertyId: "33333333-3333-3333-3333-333333333333",
  method: "edge_worker",
  target: { url: "https://client.example/faq", locator: "edge:jsonld/faq" },
};

describe("buildSchemaChange — the DesiredChange seam", () => {
  it("shapes a ready artifact into a schema DesiredChange with the JSON-LD object as `after`", () => {
    const ready = readyFaq();
    const change: DesiredChange = buildSchemaChange(ready, SPEC);

    expect(change.tenantId).toBe(SPEC.tenantId);
    expect(change.clientId).toBe(SPEC.clientId);
    expect(change.propertyId).toBe(SPEC.propertyId);
    expect(change.method).toBe("edge_worker");
    expect(change.changeType).toBe("schema");
    expect(change.target).toEqual(SPEC.target);
    expect(change.source).toBe("schema:FAQPage");
    // `after` carries the STRUCTURED object (not a serialized string) — the
    // edge_worker upsert_json_ld payload + a losslessly-diffable jsonb value.
    expect(change.after).toBe(ready.jsonLd);
    expect((change.after as { "@type": string })["@type"]).toBe("FAQPage");
  });

  it("defaults before to null and omits automationLevel (pipeline default applies)", () => {
    const change = buildSchemaChange(readyFaq(), SPEC);
    expect(change.before).toBeNull();
    expect("automationLevel" in change).toBe(false);
  });

  it("threads the existing on-page schema through as the rollback before-state", () => {
    const existing = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] };
    const change = buildSchemaChange(readyFaq(), { ...SPEC, before: existing });
    expect(change.before).toEqual(existing);
  });

  it("passes an explicit automationLevel through (human_only)", () => {
    const change = buildSchemaChange(readyFaq(), { ...SPEC, automationLevel: "human_only" });
    expect(change.automationLevel).toBe("human_only");
  });

  it("is READY-ONLY: a rejected result is not assignable (compile-time gate)", () => {
    const rejected = produceSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question: "Do you deliver?", answer: "Fabricated answer." }] },
      visible: "Totally unrelated page about socks.",
    });
    expect(rejected.status).toBe("rejected");
    // @ts-expect-error — a rejected result overclaims vs the page and must never
    // be turned into a site write through this seam.
    const build = () => buildSchemaChange(rejected, SPEC);
    expect(typeof build).toBe("function"); // never invoked — the guard is the compile error
  });
});
