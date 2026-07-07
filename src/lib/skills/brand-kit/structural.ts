/**
 * Dependency-free structural helpers for plain-JSON kit data: clone, freeze,
 * merge. Kits are pure data (they live in jsonb columns), so plain
 * object/array handling is all that is needed.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-clone plain JSON data. The clone is fully mutable even if the source was frozen. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = deepClone(v);
    return out as T;
  }
  return value;
}

/** Recursively freeze an object graph. Mutating any level then throws (strict mode). */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    return Object.freeze(value) as T;
  }
  return value;
}

/**
 * Deep-merge `patch` into a clone of `base`. Plain objects merge recursively;
 * arrays and primitives replace wholesale; `undefined` patch values are
 * ignored (they mean "no change", matching optional fields).
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return deepClone(base);
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = deepClone(base) as Record<string, unknown>;
    for (const [key, patchValue] of Object.entries(patch)) {
      if (patchValue === undefined) continue;
      out[key] = key in out ? deepMerge(out[key], patchValue) : deepClone(patchValue);
    }
    return out as T;
  }
  return deepClone(patch) as T;
}
