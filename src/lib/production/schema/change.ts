/**
 * M10 schema generation — the change-management feed (doc 04 §2 step 1, doc 07
 * §1.5). Shapes a READY schema artifact into a `DesiredChange`, the GENERATE
 * seam every on-page write enters. Producing one has zero side effects: only
 * the change-management pipeline can turn it into a persisted `previewed`
 * `site_changes` row, and only a human-approved preview can ever be applied
 * (doc 00 §2, CLAUDE.md rule 5 — no autonomous publishing).
 *
 * READY-ONLY BY CONSTRUCTION: `buildSchemaChange` accepts only a
 * `SchemaGenerationReady`, so a rejected result — schema that overclaims vs the
 * page — is not assignable and can never be turned into a site write through
 * this API. This mirrors the skill's `serializeToScriptBlock` (ready-only) and
 * gives M10 the same one-way valve at the write boundary.
 *
 * NO SERIALIZATION HERE — M10 never concatenates or hand-builds a JSON-LD
 * string. `after` carries the skill's `jsonLd` OBJECT: it is the canonical,
 * inspectable, losslessly-jsonb-storable form for `site_changes.diff`, it is
 * what the edge_worker `upsert_json_ld` adapter consumes directly, and any
 * adapter that needs the serialized `<script>` block re-serializes through the
 * skill's single `serializeToScriptBlock` authority (also exposed on the ready
 * result as `.scriptBlock`) — never a bespoke serializer.
 */

import type { ChangeTarget, DesiredChange } from "@/lib/change-management";
import type { Json, SiteChangeAutomationLevel, SiteChangeMethod } from "@/lib/types/db";
import type { SchemaGenerationReady } from "@/lib/skills/schema-generation";

/**
 * Everything M10 does NOT know from the artifact alone: which property/method
 * the schema lands on, where on the page, and the existing schema it replaces.
 * The method is dictated by the property's connection (WordPress/Webflow/Wix/
 * edge worker) — M10 never picks it. `automationLevel` is left to the pipeline
 * default ('ai_draft_human_approve') when omitted; 'auto' is unrepresentable in
 * the type, mirroring the DB CHECK.
 */
export interface SchemaChangeSpec {
  tenantId: string;
  clientId: string;
  propertyId: string;
  method: SiteChangeMethod;
  /** Page URL + method-specific locator (e.g. `edge:jsonld/{scriptId}`). */
  target: ChangeTarget;
  /**
   * The existing JSON-LD at this slot (from the crawl's `jsonLdBlocks`), or
   * `null`/omitted when the page has none today. Threaded straight into the
   * diff's before-state so a one-click rollback restores exactly what was there.
   */
  before?: Json | null;
  automationLevel?: SiteChangeAutomationLevel;
}

/**
 * Turn a ready schema artifact + its placement into a `DesiredChange`
 * (`changeType: "schema"`). The pipeline previews it (persisted `site_changes`
 * row, status 'previewed', structured before/after diff), a human approves,
 * then a WriteMethodAdapter applies it. This function does none of that — it
 * only shapes the input seam.
 */
export function buildSchemaChange(
  ready: SchemaGenerationReady,
  spec: SchemaChangeSpec,
): DesiredChange {
  return {
    tenantId: spec.tenantId,
    clientId: spec.clientId,
    propertyId: spec.propertyId,
    method: spec.method,
    changeType: "schema",
    ...(spec.automationLevel !== undefined
      ? { automationLevel: spec.automationLevel }
      : {}),
    target: spec.target,
    before: spec.before ?? null,
    // The skill's jsonLd is JSON-serializable by construction (its own
    // scriptBlock is JSON.stringify(jsonLd)); the cast only bridges
    // JsonLdObject's optional-value type to the jsonb `Json` type.
    after: ready.jsonLd as unknown as Json,
    source: `schema:${ready.schemaType}`,
  };
}
