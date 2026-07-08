/**
 * Deterministic before/after diff construction (doc 04 §2 PREVIEW step).
 *
 * A change is previewed as a reviewable {@link StructuredDiff} a human approves
 * before anything writes. The diff is derived PURELY from the change's before/
 * after payloads (recomputable from the persisted `site_changes.diff` at any
 * time), so nothing extra needs storing and the render is identical every time.
 *
 * `identical: true` marks a no-op — the shape the §4 onboarding "no-op test
 * change (previewed, not applied)" verification relies on.
 */

import type { Json, SiteChangeType } from "@/lib/types/db";
import { jsonEqual } from "./json";
import type { ChangeTarget, DiffHunk, StructuredDiff } from "./types";

/** Render a Json value to comparable lines. `null` = absent (no lines). */
export function toLines(value: Json): string[] {
  if (value === null) return [];
  if (typeof value === "string") return value.split("\n");
  return JSON.stringify(value, null, 2).split("\n");
}

/** Length of the shared leading run of two line arrays. */
function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Length of the shared trailing run, not overlapping an already-counted prefix. */
function commonSuffix(a: string[], b: string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Build the structured diff for one change. Deterministic: shared leading/
 * trailing lines render as `unchanged`; the divergent middle renders as a
 * `removed` hunk then an `added` hunk. Never mutates its inputs.
 */
export function buildStructuredDiff(
  changeType: SiteChangeType,
  target: ChangeTarget,
  before: Json,
  after: Json,
): StructuredDiff {
  const identical = jsonEqual(before, after);
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  const hunks: DiffHunk[] = [];
  let linesRemoved = 0;
  let linesAdded = 0;

  if (identical) {
    if (beforeLines.length > 0) {
      hunks.push({ kind: "unchanged", lines: beforeLines });
    }
  } else {
    const prefix = commonPrefix(beforeLines, afterLines);
    const suffix = commonSuffix(beforeLines, afterLines, prefix);
    const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
    const added = afterLines.slice(prefix, afterLines.length - suffix);

    if (prefix > 0) {
      hunks.push({ kind: "unchanged", lines: beforeLines.slice(0, prefix) });
    }
    if (removed.length > 0) {
      hunks.push({ kind: "removed", lines: removed });
      linesRemoved = removed.length;
    }
    if (added.length > 0) {
      hunks.push({ kind: "added", lines: added });
      linesAdded = added.length;
    }
    if (suffix > 0) {
      hunks.push({
        kind: "unchanged",
        lines: beforeLines.slice(beforeLines.length - suffix),
      });
    }
  }

  const label = identical
    ? `${changeType} @ ${target.url}: no change (no-op)`
    : `${changeType} @ ${target.url}: ${linesRemoved} removed, ${linesAdded} added`;

  return {
    changeType,
    target,
    before,
    after,
    hunks,
    summary: { linesAdded, linesRemoved, identical, label },
  };
}
