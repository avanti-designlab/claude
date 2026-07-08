/**
 * Check 9 — NAP consistency across the playbook's directory list (SKILL.md).
 * Each directory in `local_module_config.nap_directories` needs a listing
 * whose name/address/phone match the canonical entity. Missing listings and
 * field mismatches both count against the directory.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft, NapRecord } from "../types";
import { normalizeAddress, normalizeName, normalizePhone, round1 } from "../util";

export function checkNapConsistency(ctx: CheckContext): CheckOutcome {
  const { site, playbook } = ctx;
  const directories = playbook.local_module_config.nap_directories;

  if (directories.length === 0) {
    return {
      status: "skipped",
      skipReason: "not_applicable",
      score: null,
      evidence: [{ message: "Playbook lists no NAP directories." }],
      fixes: [],
    };
  }
  if (site.entity === undefined) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No canonical entity (name/address/phone) supplied — cannot judge NAP consistency." }],
      fixes: [],
    };
  }
  if (site.napRecords === undefined) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No NAP records supplied — connect directory lookups (M14) to score consistency." }],
      fixes: [],
    };
  }

  const canonical = site.entity;
  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];
  const missingDirectories: string[] = [];
  const mismatchedDirectories: string[] = [];
  let consistent = 0;

  const findRecord = (directory: string): NapRecord | undefined =>
    site.napRecords?.find((record) => record.directory.trim().toLowerCase() === directory.trim().toLowerCase());

  for (const directory of directories) {
    const record = findRecord(directory);
    if (record === undefined) {
      missingDirectories.push(directory);
      evidence.push({
        url: `nap:${directory}`,
        field: "listing",
        expected: `listing for "${canonical.name}"`,
        found: "no listing found",
        message: `No listing found on ${directory} (playbook-required directory).`,
      });
      continue;
    }

    let directoryConsistent = true;
    const compare = (
      field: "name" | "address" | "phone",
      recordValue: string | null,
      canonicalValue: string | undefined,
      normalize: (s: string) => string,
    ): void => {
      if (canonicalValue === undefined) return; // nothing canonical to compare against
      if (recordValue === null || recordValue.trim() === "") {
        directoryConsistent = false;
        evidence.push({
          url: record.url ?? `nap:${directory}`,
          field,
          expected: canonicalValue,
          found: "missing on listing",
          message: `${directory} listing is missing the ${field}.`,
        });
      } else if (normalize(recordValue) !== normalize(canonicalValue)) {
        directoryConsistent = false;
        evidence.push({
          url: record.url ?? `nap:${directory}`,
          field,
          expected: canonicalValue,
          found: recordValue,
          message: `${directory} listing ${field} "${recordValue}" does not match canonical "${canonicalValue}".`,
        });
      }
    };

    compare("name", record.name, canonical.name, normalizeName);
    compare("address", record.address, canonical.address, normalizeAddress);
    compare("phone", record.phone, canonical.phone, normalizePhone);

    if (directoryConsistent) {
      consistent += 1;
    } else {
      mismatchedDirectories.push(directory);
    }
  }

  const score = round1((consistent / directories.length) * 100);

  if (missingDirectories.length > 0) {
    fixes.push({
      id: "nap_consistency/create-missing-listings",
      checkId: "nap_consistency",
      title: `Create listings on ${missingDirectories.join(", ")}`,
      detail: "Playbook-required directories with no listing. Listing creation involves account setup/verification on each platform.",
      targetUrls: missingDirectories.map((directory) => `nap:${directory}`),
      impact: "high",
      impactEstimate: "High — missing playbook directories are missing citations; AI engines cross-reference them for local trust.",
      module: "M14",
      automationLevel: "human_only",
    });
  }
  if (mismatchedDirectories.length > 0) {
    fixes.push({
      id: "nap_consistency/correct-mismatched-listings",
      checkId: "nap_consistency",
      title: `Correct NAP data on ${mismatchedDirectories.join(", ")}`,
      detail: `Listings disagree with the canonical NAP for "${canonical.name}" — we draft the corrections for your approval on each directory.`,
      targetUrls: mismatchedDirectories.map((directory) => `nap:${directory}`),
      impact: "high",
      impactEstimate: "High — inconsistent NAP erodes local rankings and entity confidence across engines.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
