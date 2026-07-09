/**
 * `runVisibilityTracking` server-action suite (actions.ts).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the vendor-resolution seam); the role
 * guard, uuid + competitor clamps, server-side query derivation, the sampler,
 * scoring, and persistence all run for real. Pins the frozen
 * `RunVisibilityTrackingResult` contract and the review-gated hard properties:
 *  - staff-only (RLS mirror), claim-sourced tenant, junk ids never hit Postgres;
 *  - dormant verticals track nothing (Gate 1a);
 *  - provider honesty end-to-end: a partial run scores only what was measured
 *    and warns structurally; a fully-failed run stores nothing and fails typed;
 *  - a measured-but-unstored run fails typed (never a phantom trend point);
 *  - every degraded/failed path emits only redacted telemetry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryCitationDataProvider,
  type CitationDataProvider,
  type CitationPromptRequest,
  type CitationPromptResult,
} from "@/lib/connectors";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import {
  runVisibilityTracking,
  type RunVisibilityTrackingResult,
} from "./actions";

const { getClaimsMock, createClientMock, resolveProviderMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  resolveProviderMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./provider", () => ({
  resolveCitationDataProvider: resolveProviderMock,
}));

const STAFF_CLAIMS = {
  tenantId: "11111111-2222-4333-8444-555555555555",
  role: "operator" as const,
  sub: "user-1",
};

const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

/** Real-estate client (Gate 1a active vertical) with two markets. */
const CLIENT_ROW = {
  id: CLIENT_ID,
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  locations: [
    { name: "Dubai", address: "1 Marina Walk" },
    { name: "Abu Dhabi", address: "2 Corniche Rd" },
  ],
};

/** A provider that always cites the client at position 1. */
function citingProvider(): CitationDataProvider {
  return new InMemoryCitationDataProvider().script({
    promptMatch: /.*/,
    result: {
      cited: true,
      position: 1,
      sentiment: "positive",
      citedSource: "https://client.example.com/about",
      raw: {},
    },
  });
}

/** A provider that fails one engine (partial coverage), cites on the rest. */
class OneEngineDownProvider implements CitationDataProvider {
  readonly vendor = "engine-down";
  constructor(private readonly down: string) {}
  async runPrompt(request: CitationPromptRequest): Promise<CitationPromptResult> {
    if (request.engine === this.down) throw new Error("engine offline");
    return {
      cited: true,
      position: 2,
      sentiment: null,
      citedSource: null,
      raw: {},
    };
  }
}

/**
 * A provider that always throws an UNCLASSIFIABLE (non-retryable) error — a
 * total provider failure with no backoff waiting. The sampler's retryable
 * backoff path is exercised separately in sampler.test.ts with an injected
 * no-delay clock; keeping this provider non-retryable keeps the action suite
 * clock-free (a retryable total outage would make the real sampler back off
 * on every sample — correct in production, untestable without real timers).
 */
class DeadProvider implements CitationDataProvider {
  readonly vendor = "dead";
  async runPrompt(): Promise<CitationPromptResult> {
    throw new Error("provider exploded");
  }
}

function setup(script: FakeScript, provider: CitationDataProvider | null) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(STAFF_CLAIMS);
  createClientMock.mockResolvedValue(fake.client);
  resolveProviderMock.mockReturnValue(provider);
  return fake;
}

function okResult(result: RunVisibilityTrackingResult) {
  if (!result.ok) throw new Error(`expected ok:true, got: ${result.error}`);
  return result;
}
function failResult(result: RunVisibilityTrackingResult) {
  if (result.ok) throw new Error("expected ok:false, got ok:true");
  return result;
}

const PARTIAL_MARKER = "[visibility-run-partial]";
const WRITE_MARKER = "[visibility-write-failure]";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    return call[0] as string;
  });
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  resolveProviderMock.mockReset();
  // Failing providers here throw NON-retryable errors so the sampler's real
  // backoff timer is never reached — the retryable/backoff path is covered
  // with an injected no-delay clock in sampler.test.ts.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

/* ------------------------------------------------------------------ */
/* authz + input clamps                                                */
/* ------------------------------------------------------------------ */

describe("runVisibilityTracking — authz and input clamps", () => {
  it("wrong role: forbidden, no Supabase client and no provider touched", async () => {
    getClaimsMock.mockResolvedValue({
      tenantId: "t1",
      role: "client_viewer",
      clientId: CLIENT_ID,
      sub: "viewer-1",
    });
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("forbidden");
    expect(createClientMock).not.toHaveBeenCalled();
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(
      runVisibilityTracking({ clientId: CLIENT_ID })
    ).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID clientId: not_found before any DB call", async () => {
    getClaimsMock.mockResolvedValue(STAFF_CLAIMS);
    for (const bad of ["not-a-uuid", "", "42 or 1=1"]) {
      const result = failResult(await runVisibilityTracking({ clientId: bad }));
      expect(result.reason).toBe("not_found");
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("malformed competitor list: refused whole (never silently repaired)", async () => {
    getClaimsMock.mockResolvedValue(STAFF_CLAIMS);
    const cases: unknown[] = [
      [{ name: "", domains: ["x.com"] }],
      [{ name: "No domains", domains: [] }],
      [{ name: "Bad host", domains: ["not a domain"] }],
      [{ name: "Dupe", domains: ["a.com"] }, { name: "dupe", domains: ["b.com"] }],
      "not-an-array",
      Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, domains: ["x.com"] })),
    ];
    for (const competitors of cases) {
      const result = failResult(
        await runVisibilityTracking({
          clientId: CLIENT_ID,
          competitors: competitors as never,
        })
      );
      expect(result.reason).toBe("invalid_competitors");
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* lookup / playbook / query-set gates                                 */
/* ------------------------------------------------------------------ */

describe("runVisibilityTracking — pre-sample gates", () => {
  it("client not visible under RLS: not_found, no provider call", async () => {
    setup({ clients: { select: { data: null } } }, citingProvider());
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("not_found");
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("client READ failure is lookup_failed (retryable), never a false not_found", async () => {
    setup(
      { clients: { select: { error: { message: "connection reset" } } } },
      citingProvider()
    );
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("lookup_failed");
  });

  it("dormant vertical: no_playbook, no provider call", async () => {
    setup(
      { clients: { select: { data: { ...CLIENT_ROW, vertical: "restaurants" } } } },
      citingProvider()
    );
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("no_playbook");
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("empty query set (nothing honestly fillable): empty_query_set, no provider call", async () => {
    // Real-estate with NO locations + a name leaves only "who is <name>";
    // to force a truly empty set, blank the name too — then no template fills.
    setup(
      {
        clients: {
          select: { data: { ...CLIENT_ROW, name: "   ", locations: [] } },
        },
      },
      citingProvider()
    );
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("empty_query_set");
    expect(resolveProviderMock).not.toHaveBeenCalled();
  });

  it("no provider connected yet: no_provider (honest, typed — never a fake run)", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } } }, null);
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("no_provider");
    expect(fake.inserts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the happy path + provider honesty end-to-end                        */
/* ------------------------------------------------------------------ */

describe("runVisibilityTracking — run + persistence", () => {
  it("full run: derives, samples all engines, stores measured rows, returns metrics", async () => {
    const fake = setup(
      { clients: { select: { data: CLIENT_ROW } }, visibility_results: { insert: {} } },
      citingProvider()
    );
    const result = okResult(
      await runVisibilityTracking({
        clientId: CLIENT_ID,
        competitors: [{ name: "Rival", domains: ["rival.com"] }],
      })
    );
    expect(result.warning).toBeUndefined();
    expect(result.run.vendor).toBe("in-memory");
    expect(result.run.vertical).toBe("real-estate");
    // real-estate + 2 locations derives 5 queries (see derive.test.ts) × 6 engines.
    expect(result.run.queryCount).toBe(5);
    expect(result.run.coverage.requested).toBe(30);
    expect(result.run.coverage.measured).toBe(30);
    expect(result.run.coverage.coverage).toBe(1);
    expect(result.run.score).toBe(100); // all cited at position 1
    expect(result.run.persisted).toBe(30);
    // One append-only batch into the frozen table, pinned to the run key.
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].table).toBe("visibility_results");
    const rows = fake.inserts[0].values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.captured_at))).toEqual(new Set([result.run.runAt]));
    expect(rows.every((r) => r.tenant_id === STAFF_CLAIMS.tenantId)).toBe(true);
    expect(rows.every((r) => r.client_id === CLIENT_ID)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("raw");
    expect(loggedLines()).toEqual([]);
  });

  it("partial run: scores ONLY what was measured, warns structurally, logs ONE redacted line", async () => {
    setup(
      { clients: { select: { data: CLIENT_ROW } }, visibility_results: { insert: {} } },
      new OneEngineDownProvider("gemini")
    );
    const result = okResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    // 5 queries × 6 engines = 30 requested; gemini (5) fails → 25 measured.
    expect(result.run.coverage.requested).toBe(30);
    expect(result.run.coverage.measured).toBe(25);
    expect(result.run.coverage.enginesMissing).toEqual(["gemini"]);
    expect(result.run.persisted).toBe(25); // failed samples ABSENT — no fake zeros
    expect(result.run.score).toBe(75); // position-2 credit over measured only
    // gemini reads null (absent), not 0.
    const gemini = result.run.perEngine.find((e) => e.engine === "gemini");
    expect(gemini).toEqual({ engine: "gemini", sampled: 0, cited: 0, score: null });
    expect(result.warning).toContain("measured 25 of 30");
    const partial = loggedLines().filter((l) => l.startsWith(PARTIAL_MARKER));
    expect(partial).toHaveLength(1);
    expect(partial[0]).toBe(
      "[visibility-run-partial] requested=30 measured=25 rate_limited=0 unavailable=0 invalid_response=0 unknown=5"
    );
    expect(partial[0]).not.toContain("Gable");
  });

  it("total provider failure: provider_failed, nothing stored (no invented zeros)", async () => {
    const fake = setup(
      { clients: { select: { data: CLIENT_ROW } }, visibility_results: { insert: {} } },
      new DeadProvider()
    );
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("provider_failed");
    expect(fake.inserts).toEqual([]);
    // Degraded run still logs exactly the partial line, redacted.
    expect(loggedLines()).toEqual([
      "[visibility-run-partial] requested=30 measured=0 rate_limited=0 unavailable=0 invalid_response=0 unknown=30",
    ]);
  });

  it("measured but unstored: write_failed (never a phantom trend point), ONE redacted write line", async () => {
    setup(
      {
        clients: { select: { data: CLIENT_ROW } },
        visibility_results: {
          insert: {
            error: {
              message: `quoting prompt "who is Gable & Grove Realty"`,
              code: "PGRST301",
            },
          },
        },
      },
      citingProvider()
    );
    const result = failResult(await runVisibilityTracking({ clientId: CLIENT_ID }));
    expect(result.reason).toBe("write_failed");
    const writeLines = loggedLines().filter((l) => l.startsWith(WRITE_MARKER));
    expect(writeLines).toEqual([
      "[visibility-write-failure] stage=results_insert code=PGRST301",
    ]);
    expect(writeLines[0]).not.toContain("Gable");
  });
});
