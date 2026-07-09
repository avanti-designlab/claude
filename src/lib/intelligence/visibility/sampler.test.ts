/**
 * M3 sampling-engine suite (sampler.ts).
 *
 * What must hold: the sampler drives ONLY the CitationDataProvider port, in a
 * deterministic sequential order; provider failures become typed, retryable
 * outcomes — a failed sample is ABSENT from measurement, never an invented
 * zero; rate limits retry with bounded backoff; garbage vendor responses are
 * non-measurements; coverage reports partiality structurally.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryCitationDataProvider,
  type CitationDataProvider,
  type CitationPromptRequest,
  type CitationPromptResult,
} from "@/lib/connectors";
import { VISIBILITY_ENGINES } from "@/lib/types/db";
import type { DerivedQuery } from "./derive";
import {
  classifyProviderError,
  measuredSamples,
  runCoverage,
  sampleVisibility,
} from "./sampler";

const RUN_AT = "2026-07-09T12:00:00.000Z";

function query(overrides: Partial<DerivedQuery> = {}): DerivedQuery {
  return {
    prompt: "who is Gable & Grove Realty",
    template: "who is [advisor name]",
    intents: ["entity"],
    priority: "normal",
    location: null,
    ...overrides,
  };
}

const CITED: CitationPromptResult = {
  cited: true,
  position: 1,
  sentiment: "positive",
  citedSource: "https://client.example.com/about",
  raw: { scripted: true },
};

/** Always throws the given cause — the port's failure surface, scripted. */
class FailingProvider implements CitationDataProvider {
  readonly vendor = "failing";
  readonly calls: CitationPromptRequest[] = [];
  constructor(private readonly cause: unknown) {}
  async runPrompt(request: CitationPromptRequest): Promise<CitationPromptResult> {
    this.calls.push(request);
    throw this.cause;
  }
}

/** Returns a non-CitationPromptResult payload — a misbehaving vendor adapter. */
class GarbageProvider implements CitationDataProvider {
  readonly vendor = "garbage";
  async runPrompt(): Promise<CitationPromptResult> {
    return { cited: "yes", nonsense: true } as unknown as CitationPromptResult;
  }
}

/** Fails one engine, delegates the rest — the partial-coverage scenario. */
class EngineDownProvider implements CitationDataProvider {
  readonly vendor = "engine-down";
  constructor(
    private readonly inner: CitationDataProvider,
    private readonly down: string
  ) {}
  async runPrompt(request: CitationPromptRequest): Promise<CitationPromptResult> {
    if (request.engine === this.down) throw new Error("engine offline");
    return this.inner.runPrompt(request);
  }
}

const noDelay = async (): Promise<void> => {};

describe("sampleVisibility — order and shape", () => {
  it("samples query-major × canonical-engine-minor, one outcome per pair", async () => {
    const provider = new InMemoryCitationDataProvider();
    const queries = [query(), query({ prompt: "second prompt", template: "second prompt" })];
    const run = await sampleVisibility(provider, queries, { runAt: RUN_AT, delay: noDelay });

    expect(run.vendor).toBe("in-memory");
    expect(run.runAt).toBe(RUN_AT);
    expect(run.engines).toEqual([...VISIBILITY_ENGINES]);
    expect(run.outcomes).toHaveLength(12);
    expect(provider.calls.map((call) => `${call.prompt}|${call.engine}`)).toEqual(
      queries.flatMap((q) => VISIBILITY_ENGINES.map((engine) => `${q.prompt}|${engine}`))
    );
  });

  it("passes geo context for location-instantiated queries and omits it otherwise", async () => {
    const provider = new InMemoryCitationDataProvider();
    await sampleVisibility(
      provider,
      [
        query({ prompt: "cannabis delivery Dubai", location: "Dubai", geo: { market: "Dubai" } }),
        query(),
      ],
      { runAt: RUN_AT, engines: ["chatgpt"], delay: noDelay }
    );
    expect(provider.calls[0].geo).toEqual({ market: "Dubai" });
    expect(provider.calls[1].geo).toBeUndefined();
  });

  it("is deterministic given identical scripted provider behavior", async () => {
    const script = { promptMatch: "who is", result: CITED };
    const runA = await sampleVisibility(
      new InMemoryCitationDataProvider().script(script),
      [query()],
      { runAt: RUN_AT, delay: noDelay }
    );
    const runB = await sampleVisibility(
      new InMemoryCitationDataProvider().script(script),
      [query()],
      { runAt: RUN_AT, delay: noDelay }
    );
    expect(JSON.stringify(runA)).toBe(JSON.stringify(runB));
  });

  it("fails loud on programmer error BEFORE spending rented calls", async () => {
    const provider = new InMemoryCitationDataProvider();
    await expect(
      sampleVisibility(provider, [query()], { runAt: "not-a-time", delay: noDelay })
    ).rejects.toThrow(/runAt/);
    await expect(
      sampleVisibility(provider, [query()], { runAt: RUN_AT, engines: [], delay: noDelay })
    ).rejects.toThrow(/non-empty/);
    await expect(
      sampleVisibility(provider, [query()], {
        runAt: RUN_AT,
        engines: ["bing" as never],
        delay: noDelay,
      })
    ).rejects.toThrow(/unknown engine/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("sampleVisibility — provider honesty", () => {
  it("retries a rate-limited sample with backoff, then measures", async () => {
    const provider = new InMemoryCitationDataProvider()
      .script({ promptMatch: "who is", result: CITED })
      .failNext(Object.assign(new Error("429"), { status: 429 }));
    const delays: number[] = [];
    const run = await sampleVisibility(provider, [query()], {
      runAt: RUN_AT,
      engines: ["chatgpt"],
      backoffMs: 100,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(run.outcomes[0].status).toBe("measured");
    expect(delays).toEqual([100]); // one retry, linear backoff base × attempt 1
    expect(provider.calls).toHaveLength(2);
  });

  it("exhausts retries on a persistent rate limit and reports attempts honestly", async () => {
    const provider = new FailingProvider(Object.assign(new Error("429"), { status: 429 }));
    const delays: number[] = [];
    const run = await sampleVisibility(provider, [query()], {
      runAt: RUN_AT,
      engines: ["chatgpt"],
      maxAttempts: 3,
      backoffMs: 100,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(run.outcomes[0]).toMatchObject({
      status: "failed",
      failure: { kind: "rate_limited", retryable: true, attempts: 3 },
    });
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry an unclassifiable error — retrying blind is noise", async () => {
    const provider = new FailingProvider(new Error("vendor exploded"));
    const delays: number[] = [];
    const run = await sampleVisibility(provider, [query()], {
      runAt: RUN_AT,
      engines: ["chatgpt"],
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(run.outcomes[0]).toMatchObject({
      status: "failed",
      failure: { kind: "unknown", retryable: false, attempts: 1 },
    });
    expect(delays).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it("treats a garbage vendor response as a NON-measurement (invalid_response)", async () => {
    const run = await sampleVisibility(new GarbageProvider(), [query()], {
      runAt: RUN_AT,
      engines: ["chatgpt"],
      delay: noDelay,
    });
    expect(run.outcomes[0]).toMatchObject({
      status: "failed",
      failure: { kind: "invalid_response", retryable: false },
    });
    expect(measuredSamples(run)).toEqual([]);
  });

  it("keeps failed samples ABSENT from measurement — never an invented zero", async () => {
    const inner = new InMemoryCitationDataProvider().script({
      promptMatch: "who is",
      result: CITED,
    });
    const run = await sampleVisibility(
      new EngineDownProvider(inner, "claude"),
      [query()],
      { runAt: RUN_AT, delay: noDelay }
    );
    const samples = measuredSamples(run);
    expect(samples).toHaveLength(5);
    expect(samples.every((sample) => sample.cited)).toBe(true);
    expect(samples.map((sample) => sample.engine)).not.toContain("claude");
  });
});

describe("runCoverage — structural partial-coverage honesty", () => {
  it("says exactly what was measured, what failed, and which engines are missing", async () => {
    const inner = new InMemoryCitationDataProvider();
    const run = await sampleVisibility(
      new EngineDownProvider(inner, "gemini"),
      [query(), query({ prompt: "second", template: "second" })],
      { runAt: RUN_AT, delay: noDelay }
    );
    expect(runCoverage(run)).toEqual({
      requested: 12,
      measured: 10,
      failed: 2,
      coverage: 10 / 12,
      enginesMissing: ["gemini"],
      failuresByKind: { rate_limited: 0, unavailable: 0, invalid_response: 0, unknown: 2 },
    });
  });

  it("reports a fully-failed run as coverage 0 with every engine missing", async () => {
    const run = await sampleVisibility(
      new FailingProvider(new Error("down")),
      [query()],
      { runAt: RUN_AT, delay: noDelay }
    );
    const coverage = runCoverage(run);
    expect(coverage.measured).toBe(0);
    expect(coverage.coverage).toBe(0);
    expect(coverage.enginesMissing).toEqual([...VISIBILITY_ENGINES]);
  });
});

describe("classifyProviderError — shape-checked, message-blind", () => {
  it("classifies rate limits from status or code", () => {
    expect(classifyProviderError({ status: 429 })).toEqual({
      kind: "rate_limited",
      retryable: true,
    });
    expect(classifyProviderError({ code: "RATE_LIMITED" })).toEqual({
      kind: "rate_limited",
      retryable: true,
    });
  });

  it("classifies transport failures as retryable unavailability", () => {
    expect(classifyProviderError({ status: 503 })).toEqual({
      kind: "unavailable",
      retryable: true,
    });
    expect(classifyProviderError({ code: "ECONNRESET" })).toEqual({
      kind: "unavailable",
      retryable: true,
    });
    expect(classifyProviderError(new TypeError("fetch failed"))).toEqual({
      kind: "unavailable",
      retryable: true,
    });
  });

  it("collapses hostile/malformed error shapes to unknown (never trusts them)", () => {
    expect(classifyProviderError(null).kind).toBe("unknown");
    expect(classifyProviderError("429").kind).toBe("unknown");
    expect(classifyProviderError({ status: "429" }).kind).toBe("unknown");
    expect(classifyProviderError({ code: "a".repeat(64) }).kind).toBe("unknown");
    expect(classifyProviderError({ code: "429; DROP TABLE" }).kind).toBe("unknown");
  });
});
