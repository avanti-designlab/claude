/**
 * Deterministic structural equality for `Json` values (drift detection).
 *
 * Object key order is ignored; array order is significant. Pure and total — no
 * wall-clock, no throw. Used to compare the approved preview's before-state
 * against the live before-state at apply time (rollback-safety drift check).
 */

import type { Json } from "@/lib/types/db";

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;

  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (ta === "object") {
    const oa = a as { [k: string]: Json };
    const ob = b as { [k: string]: Json };
    const ka = Object.keys(oa);
    const kb = Object.keys(ob);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(ob, k)) return false;
      if (!jsonEqual(oa[k], ob[k])) return false;
    }
    return true;
  }

  // primitives (string | number | boolean) already handled by ===
  return false;
}
