/**
 * Check 7 — Entity consistency (SKILL.md).
 * Business name / phone / address must be consistent across on-site
 * organization-level JSON-LD and (when the local module is on) directory NAP
 * records; declared credentials must actually appear on-site.
 *
 * Canonical values come from `site.entity` when provided; otherwise the most
 * frequent on-site organization name is used (ties broken lexicographically
 * for determinism).
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { localChecksApplicable } from "../weights";
import {
  clamp,
  collectJsonLdNodes,
  jsonLdAddressText,
  nodeTypes,
  normalizeAddress,
  normalizeName,
  normalizePhone,
  normalizeWhitespace,
  round1,
  stringProp,
} from "../util";

/** Organization-level types whose name/phone/address identify THE entity. */
const ORG_TYPES = new Set([
  "Organization",
  "LocalBusiness",
  "Store",
  "Restaurant",
  "InsuranceAgency",
  "RealEstateAgent",
  "Brand",
]);

interface EntityOccurrence {
  /** Page URL or "nap:<directory>". */
  source: string;
  kind: "on-site" | "directory";
  name: string | null;
  phone: string | null;
  address: string | null;
}

export function checkEntityConsistency(ctx: CheckContext): CheckOutcome {
  const { site, playbook } = ctx;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];
  const occurrences: EntityOccurrence[] = [];

  for (const page of site.pages) {
    for (const raw of page.jsonLdBlocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // invalid blocks are check 1's finding
      }
      for (const node of collectJsonLdNodes(parsed)) {
        if (!nodeTypes(node).some((type) => ORG_TYPES.has(type))) continue;
        occurrences.push({
          source: page.url,
          kind: "on-site",
          name: stringProp(node, "name"),
          phone: stringProp(node, "telephone"),
          address: jsonLdAddressText(node),
        });
      }
    }
  }

  // Directory NAP records participate only when the local module is in scope
  // (a national playbook's entity story is on-site + profiles, owned by M14 otherwise).
  if (localChecksApplicable(playbook) && site.napRecords !== undefined) {
    for (const record of site.napRecords) {
      occurrences.push({
        source: `nap:${record.directory}`,
        kind: "directory",
        name: record.name,
        phone: record.phone,
        address: record.address,
      });
    }
  }

  if (occurrences.length === 0 && site.entity === undefined) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No canonical entity supplied and no organization-level entity signals found to compare." }],
      fixes: [],
    };
  }

  // Canonical values: supplied entity, else majority on-site name.
  let canonicalName: string | null = site.entity?.name ?? null;
  if (canonicalName === null) {
    const counts = new Map<string, { count: number; original: string }>();
    for (const occ of occurrences) {
      if (occ.name === null) continue;
      const key = normalizeName(occ.name);
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { count: 1, original: occ.name });
      }
    }
    const ranked = [...counts.entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1),
    );
    canonicalName = ranked[0]?.[1].original ?? null;
  }
  const canonicalPhone = site.entity?.phone ?? null;
  const canonicalAddress = site.entity?.address ?? null;

  const inconsistentSources: string[] = [];
  let consistent = 0;
  for (const occ of occurrences) {
    let mismatched = false;
    if (occ.name !== null && canonicalName !== null && normalizeName(occ.name) !== normalizeName(canonicalName)) {
      mismatched = true;
      evidence.push({
        url: occ.source,
        field: "name",
        expected: canonicalName,
        found: occ.name,
        message: `Entity name "${occ.name}" does not match canonical "${canonicalName}".`,
      });
    }
    if (occ.phone !== null && canonicalPhone !== null && normalizePhone(occ.phone) !== normalizePhone(canonicalPhone)) {
      mismatched = true;
      evidence.push({
        url: occ.source,
        field: "phone",
        expected: canonicalPhone,
        found: occ.phone,
        message: `Entity phone "${occ.phone}" does not match canonical "${canonicalPhone}".`,
      });
    }
    if (
      occ.address !== null &&
      canonicalAddress !== null &&
      normalizeAddress(occ.address) !== normalizeAddress(canonicalAddress)
    ) {
      mismatched = true;
      evidence.push({
        url: occ.source,
        field: "address",
        expected: canonicalAddress,
        found: occ.address,
        message: `Entity address "${occ.address}" does not match canonical "${canonicalAddress}".`,
      });
    }
    if (mismatched) {
      if (!inconsistentSources.includes(occ.source)) inconsistentSources.push(occ.source);
    } else {
      consistent += 1;
    }
  }

  // Credentials: each declared credential should appear somewhere on-site.
  const missingCredentials: string[] = [];
  for (const credential of site.entity?.credentials ?? []) {
    const needle = normalizeWhitespace(credential);
    const found = site.pages.some(
      (page) =>
        normalizeWhitespace(page.visibleText).includes(needle) ||
        page.jsonLdBlocks.some((raw) => normalizeWhitespace(raw).includes(needle)),
    );
    if (!found) {
      missingCredentials.push(credential);
      evidence.push({
        field: "credential",
        expected: credential,
        found: "not found on any page",
        message: `Declared credential "${credential}" appears nowhere on-site (text or schema).`,
      });
    }
  }

  const consistencyScore = occurrences.length === 0 ? 100 : (consistent / occurrences.length) * 100;
  const credentialPenalty = Math.min(15, missingCredentials.length * 5);
  const score = round1(clamp(consistencyScore - credentialPenalty));

  const onSiteMismatches = inconsistentSources.filter((source) => !source.startsWith("nap:"));
  const directoryMismatches = inconsistentSources.filter((source) => source.startsWith("nap:"));

  if (onSiteMismatches.length > 0) {
    fixes.push({
      id: "entity_consistency/align-onsite-entity",
      checkId: "entity_consistency",
      title: `Align entity name/phone/address on ${onSiteMismatches.length} page(s)`,
      detail: `Canonical entity: "${canonicalName ?? "(unknown)"}". Inconsistent on-site signals fragment the entity for AI engines.`,
      targetUrls: onSiteMismatches.sort(),
      impact: "high",
      impactEstimate: "High — a fragmented entity cannot be resolved confidently by AI engines; consistency is a core entity signal.",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (directoryMismatches.length > 0) {
    fixes.push({
      id: "entity_consistency/align-directory-entity",
      checkId: "entity_consistency",
      title: `Correct entity data on ${directoryMismatches.length} directory listing(s)`,
      detail: `Directory listings disagree with the canonical entity ("${canonicalName ?? "(unknown)"}").`,
      targetUrls: directoryMismatches.sort(),
      impact: "medium",
      impactEstimate: "Medium — cross-web consistency feeds entity resolution and local trust.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (missingCredentials.length > 0) {
    fixes.push({
      id: "entity_consistency/surface-credentials",
      checkId: "entity_consistency",
      title: `Surface ${missingCredentials.length} missing credential(s) on-site`,
      detail: `Credentials not found anywhere on-site: ${missingCredentials.join(", ")}. Add to author boxes / bio pages and Person schema sameAs.`,
      targetUrls: [site.baseUrl],
      impact: "medium",
      impactEstimate: "Medium — visible credentials are E-E-A-T and entity-resolution signals.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
