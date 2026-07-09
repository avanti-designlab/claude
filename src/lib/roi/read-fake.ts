/**
 * Minimal PostgREST-shaped fake for the M16 ROI READ paths (reads.test.ts).
 * TEST HARNESS ONLY — never import from product code.
 *
 * Modeled on the visibility read fake (intelligence/visibility/read-fake.ts)
 * but adds the `.in(col, values)` filter the ROI reads use to narrow `metrics`
 * to the ROI sources at the database (that module belongs to another owner, so
 * this slice carries its own copy). Covers exactly what reads.ts uses:
 *   .select(cols).eq(…)[.in(…)][.gte(…)].order(…).limit(n)  → thenable {data,error}
 *
 * Results are scripted per select call as a queue: each call consumes the next
 * scripted result; the last (or only) one repeats. The fake never simulates
 * filtering — scripts are positional; filters/order/limit are only RECORDED.
 */

export interface FakeReadError {
  message: string;
  code?: string;
  [key: string]: unknown;
}

export interface ScriptedRead {
  data?: unknown;
  error?: FakeReadError | null;
  /** When set, the read THROWS this value instead of resolving. */
  throws?: unknown;
}

export interface RecordedRead {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  order: Array<{ column: string; ascending: boolean }>;
  limit: number | null;
}

interface Settled {
  data: unknown;
  error: FakeReadError | null;
}

interface FakeReadChain {
  eq(column: string, value: unknown): FakeReadChain;
  in(column: string, values: unknown[]): FakeReadChain;
  gte(column: string, value: unknown): FakeReadChain;
  order(column: string, opts?: { ascending?: boolean }): FakeReadChain;
  limit(count: number): FakeReadChain;
  then(resolve: (value: Settled) => void, reject?: (reason: unknown) => void): void;
}

export function fakeRoiReadPostgrest(scripted: ScriptedRead | ScriptedRead[]) {
  const queue = Array.isArray(scripted) ? [...scripted] : [scripted];
  const reads: RecordedRead[] = [];

  function next(): ScriptedRead {
    if (queue.length === 0) return {};
    return queue.length === 1 ? queue[0] : queue.shift()!;
  }

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: RecordedRead = { table, columns, filters: {}, order: [], limit: null };
          reads.push(call);
          const result = next();
          const chain: FakeReadChain = {
            eq(column, value) {
              call.filters[column] = value;
              return chain;
            },
            in(column, values) {
              call.filters[`${column} in`] = values;
              return chain;
            },
            gte(column, value) {
              call.filters[`${column}>=`] = value;
              return chain;
            },
            order(column, opts) {
              call.order.push({ column, ascending: opts?.ascending ?? true });
              return chain;
            },
            limit(count) {
              call.limit = count;
              return chain;
            },
            then(resolve, reject) {
              try {
                if ("throws" in result) throw result.throws;
                const error = result.error ?? null;
                resolve({ data: error ? null : (result.data ?? null), error });
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

  return { client, reads };
}
