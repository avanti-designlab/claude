/**
 * Minimal PostgREST-shaped fake for unit-testing the client/plan write paths
 * (src/lib/clients/actions.test.ts, src/lib/plans/actions.test.ts).
 *
 * TEST HARNESS ONLY — never import from product code. It lives outside
 * *.test.ts solely so both suites script one shared surface. Covers exactly
 * the call shapes the actions use:
 *   .insert(v)                             → thenable { error }
 *   .insert(v).select(cols).single()       → { data, error }
 *   .select(cols).eq(…).maybeSingle()      → { data, error }
 *   .select(cols).eq(…)[.order(…)]         → thenable { data, error }
 *   .update(v).eq(…)[.eq(…)].select(cols).single() → { data, error }
 *   .delete().eq(…)[.eq(…)][.in(…)]        → thenable { error }
 *
 * Results are scripted PER TABLE AND OPERATION as a queue: each call consumes
 * the next scripted result; the last (or only) one repeats. An unscripted
 * operation resolves `{ data: null, error: null }`. The fake never simulates
 * filtering — scripts are positional; filters are only RECORDED for asserts.
 */

export interface FakeError {
  message: string;
  /** SQLSTATE/PostgREST code ("23505", "PGRST301") when a test needs one. */
  code?: string;
  /** Extra fields tests may add to prove redaction (details, hint, …). */
  [key: string]: unknown;
}

export interface ScriptedResult {
  data?: unknown;
  error?: FakeError | null;
  /** When set, the operation THROWS this value instead of resolving. */
  throws?: unknown;
}

export interface TableScript {
  insert?: ScriptedResult | ScriptedResult[];
  select?: ScriptedResult | ScriptedResult[];
  update?: ScriptedResult | ScriptedResult[];
  delete?: ScriptedResult | ScriptedResult[];
}

export type FakeScript = Record<string, TableScript>;

export interface RecordedInsert {
  table: string;
  values: unknown;
}

export interface RecordedSelect {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
}

export interface RecordedUpdate {
  table: string;
  values: unknown;
  filters: Record<string, unknown>;
}

export interface RecordedDelete {
  table: string;
  filters: Record<string, unknown>;
}

type Op = "insert" | "select" | "update" | "delete";

interface Settled {
  data: unknown;
  error: FakeError | null;
}

interface FakeSelectChain {
  eq(column: string, value: unknown): FakeSelectChain;
  order(column: string, opts?: { ascending?: boolean }): FakeSelectChain;
  maybeSingle(): Promise<Settled>;
  then(
    resolve: (value: Settled) => void,
    reject?: (reason: unknown) => void
  ): void;
}

interface FakeUpdateChain {
  eq(column: string, value: unknown): FakeUpdateChain;
  select(columns?: string): { single(): Promise<Settled> };
}

interface FakeDeleteChain {
  eq(column: string, value: unknown): FakeDeleteChain;
  in(column: string, values: unknown[]): FakeDeleteChain;
  then(
    resolve: (value: { error: FakeError | null }) => void,
    reject?: (reason: unknown) => void
  ): void;
}

export function fakePostgrest(script: FakeScript) {
  const inserts: RecordedInsert[] = [];
  const selects: RecordedSelect[] = [];
  const updates: RecordedUpdate[] = [];
  const deletes: RecordedDelete[] = [];

  const queues = new Map<string, ScriptedResult[]>();
  function next(table: string, op: Op): ScriptedResult {
    const key = `${table}.${op}`;
    if (!queues.has(key)) {
      const scripted = script[table]?.[op];
      queues.set(
        key,
        scripted === undefined
          ? []
          : Array.isArray(scripted)
            ? [...scripted]
            : [scripted]
      );
    }
    const queue = queues.get(key)!;
    if (queue.length === 0) return {};
    // Consume positionally; the last scripted result repeats.
    return queue.length === 1 ? queue[0] : queue.shift()!;
  }

  function settle(result: ScriptedResult): Settled {
    if ("throws" in result) throw result.throws;
    const error = result.error ?? null;
    return { data: error ? null : (result.data ?? null), error };
  }

  const client = {
    from(table: string) {
      return {
        insert(values: unknown) {
          inserts.push({ table, values });
          const result = next(table, "insert");
          return {
            select() {
              return {
                async single(): Promise<Settled> {
                  return settle(result);
                },
              };
            },
            then(
              resolve: (value: { error: FakeError | null }) => void,
              reject?: (reason: unknown) => void
            ) {
              try {
                resolve({ error: settle(result).error });
              } catch (err) {
                if (reject) reject(err);
                else throw err;
              }
            },
          };
        },

        select(columns: string) {
          const call: RecordedSelect = { table, columns, filters: {} };
          selects.push(call);
          const result = next(table, "select");
          const chain: FakeSelectChain = {
            eq(column, value) {
              call.filters[column] = value;
              return chain;
            },
            order() {
              return chain;
            },
            async maybeSingle() {
              return settle(result);
            },
            then(resolve, reject) {
              try {
                resolve(settle(result));
              } catch (err) {
                if (reject) reject(err);
                else throw err;
              }
            },
          };
          return chain;
        },

        update(values: unknown) {
          const call: RecordedUpdate = { table, values, filters: {} };
          updates.push(call);
          const result = next(table, "update");
          const chain: FakeUpdateChain = {
            eq(column, value) {
              call.filters[column] = value;
              return chain;
            },
            select() {
              return {
                async single(): Promise<Settled> {
                  return settle(result);
                },
              };
            },
          };
          return chain;
        },

        delete() {
          const call: RecordedDelete = { table, filters: {} };
          deletes.push(call);
          const result = next(table, "delete");
          const chain: FakeDeleteChain = {
            eq(column, value) {
              call.filters[column] = value;
              return chain;
            },
            in(column, values) {
              call.filters[column] = values;
              return chain;
            },
            then(resolve, reject) {
              try {
                resolve({ error: settle(result).error });
              } catch (err) {
                if (reject) reject(err);
                else throw err;
              }
            },
          };
          return chain;
        },
      };
    },
  };

  return { client, inserts, selects, updates, deletes };
}
