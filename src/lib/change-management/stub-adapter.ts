/**
 * In-memory WriteMethodAdapter + registry — for tests and until the real
 * WordPress / Webflow / Wix / edge-worker adapters land in 1.3.
 *
 * The adapter models a client site as a keyed store of on-page state and RECORDS
 * every read/apply/revert so tests can prove: a write happened, a rollback wrote
 * the before-state back through the SAME adapter, and failures propagate. It can
 * be told to fail a specific op at a specific target for failure-injection
 * tests (auto-revert-failed, batch stop-on-failure).
 */

import type { Json, SiteChangeMethod } from "@/lib/types/db";
import type {
  AdapterRegistry,
  AdapterWrite,
  WriteMethodAdapter,
} from "./ports";
import type { ChangeTarget } from "./types";

export type AdapterOp = "read" | "apply" | "revert";

export interface AdapterCall {
  op: AdapterOp;
  key: string;
  value?: Json;
}

function targetKey(target: ChangeTarget): string {
  return `${target.url}::${target.locator ?? ""}`;
}

export class RecordingWriteAdapter implements WriteMethodAdapter {
  readonly method: SiteChangeMethod;
  readonly calls: AdapterCall[] = [];
  private readonly state = new Map<string, Json>();
  private readonly failApplyKeys = new Set<string>();
  private readonly failRevertKeys = new Set<string>();

  constructor(method: SiteChangeMethod, initial?: Record<string, Json>) {
    this.method = method;
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.state.set(key, value);
      }
    }
  }

  // The interface passes an AdapterContext; the in-memory stub does not need it.
  async readCurrent(target: ChangeTarget): Promise<Json> {
    const key = targetKey(target);
    this.calls.push({ op: "read", key });
    return this.state.has(key) ? (this.state.get(key) as Json) : null;
  }

  async apply(write: AdapterWrite): Promise<void> {
    const key = targetKey(write.target);
    if (this.failApplyKeys.has(key)) {
      throw new Error(`stub adapter: forced apply failure at ${key}`);
    }
    this.state.set(key, write.after);
    this.calls.push({ op: "apply", key, value: write.after });
  }

  async revert(write: AdapterWrite): Promise<void> {
    const key = targetKey(write.target);
    if (this.failRevertKeys.has(key)) {
      throw new Error(`stub adapter: forced revert failure at ${key}`);
    }
    this.state.set(key, write.before);
    this.calls.push({ op: "revert", key, value: write.before });
  }

  /* -------- test controls -------- */

  /** Seed/override the live on-page state (used to simulate drift). */
  setCurrent(target: ChangeTarget, value: Json): void {
    this.state.set(targetKey(target), value);
  }

  /** Read the live on-page state without recording a call. */
  current(target: ChangeTarget): Json {
    const key = targetKey(target);
    return this.state.has(key) ? (this.state.get(key) as Json) : null;
  }

  failApplyAt(target: ChangeTarget): void {
    this.failApplyKeys.add(targetKey(target));
  }

  failRevertAt(target: ChangeTarget): void {
    this.failRevertKeys.add(targetKey(target));
  }

  count(op: AdapterOp): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

/** Simple method→adapter registry. */
export class MapAdapterRegistry implements AdapterRegistry {
  private readonly byMethod = new Map<SiteChangeMethod, WriteMethodAdapter>();

  constructor(adapters: WriteMethodAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: WriteMethodAdapter): this {
    this.byMethod.set(adapter.method, adapter);
    return this;
  }

  get(method: SiteChangeMethod): WriteMethodAdapter | undefined {
    return this.byMethod.get(method);
  }
}
