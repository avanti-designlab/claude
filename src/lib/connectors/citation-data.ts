/**
 * CitationDataProvider — the provider-agnostic AI-engine citation interface
 * (doc 04 §3 + §7; doc 07 §1.2).
 *
 * LOCKED DECISION (doc 04 §3): buy/rent citation data via available APIs —
 * do NOT build scrapers. This interface is what keeps that cheap to change:
 * M3 (visibility tracker) and M4 (competitor analysis) call THIS interface,
 * never a vendor SDK. Swapping Profound for another vendor — or a future
 * in-house engine — changes one adapter, not the modules, and requires zero
 * data-model changes because every vendor response is normalized into the
 * `visibility_results` shape before storage (history survives the swap).
 *
 * Code Review rule (doc 04 §7): a vendor SDK import outside its adapter is a
 * rejection. Real adapters (ProfoundAdapter, ...) land when M3 is built at
 * 1.4; this module ships the interface, the normalizer, and a scriptable
 * in-memory fake so M3 can be built and tested without a vendor account.
 */

import {
  VISIBILITY_ENGINES,
  type Json,
  type VisibilityEngine,
  type VisibilityResultRow,
} from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Interface (doc 04 §7)                                               */
/* ------------------------------------------------------------------ */

/** Geographic context for a prompt run (local-intent tracking, M14). */
export interface CitationGeo {
  /** Free-form market label, e.g. "San Diego, CA". */
  market?: string;
  /** ISO country code, e.g. "US". */
  country?: string;
}

/** One prompt posed to one AI engine. */
export interface CitationPromptRequest {
  engine: VisibilityEngine;
  prompt: string;
  geo?: CitationGeo;
}

/**
 * The vendor-independent result shape (doc 04 §7's
 * `{ cited, position, sentiment, cited_source, raw }`). Adapters MUST
 * normalize into this — modules never see vendor payloads except via `raw`,
 * which is retained verbatim for audit/debugging only.
 */
export interface CitationPromptResult {
  /** Was the client cited/mentioned in the engine's answer? */
  cited: boolean;
  /** 1-based citation position; null when uncited or vendor can't say. */
  position: number | null;
  /** Vendor sentiment label, if provided (value set is doc-silent; §9). */
  sentiment: string | null;
  /** The URL/source the engine cited, if any (M4 input). */
  citedSource: string | null;
  /** Verbatim vendor payload — never interpreted by modules. */
  raw: Json;
}

/**
 * The provider-agnostic connector interface. Implementations:
 * ProfoundAdapter | <OtherVendor>Adapter | (future) InHouseAdapter — plus
 * {@link InMemoryCitationDataProvider} for tests. Vendor keys live in the
 * secrets vault (doc 04 §5), resolved at call time by the adapter — they are
 * NEVER constructor-visible state on this interface.
 */
export interface CitationDataProvider {
  /** Stable vendor id for provenance, e.g. "profound", "in-memory". */
  readonly vendor: string;
  runPrompt(request: CitationPromptRequest): Promise<CitationPromptResult>;
}

/* ------------------------------------------------------------------ */
/* Normalization into visibility_results (vendor-independent storage)  */
/* ------------------------------------------------------------------ */

/** Insert shape for a `visibility_results` row (contract §5). */
export type VisibilityResultInsert = Omit<VisibilityResultRow, "id" | "captured_at">;

/**
 * Normalize one prompt run into the `visibility_results` insert shape —
 * the ONLY form modules persist (doc 04 §7: stored data is
 * vendor-independent, so history stays intact across a vendor switch).
 * Note `raw` is deliberately NOT part of the stored row.
 */
export function toVisibilityResultInsert(
  scope: { tenantId: string; clientId: string },
  request: CitationPromptRequest,
  result: CitationPromptResult
): VisibilityResultInsert {
  if (!VISIBILITY_ENGINES.includes(request.engine)) {
    throw new Error(
      `unknown visibility engine '${request.engine}' (allowed: ${VISIBILITY_ENGINES.join(", ")})`
    );
  }
  if (request.prompt.trim() === "") {
    throw new Error("visibility prompt must be non-empty");
  }
  const position =
    result.position !== null && Number.isInteger(result.position) && result.position >= 1
      ? result.position
      : null;
  return {
    tenant_id: scope.tenantId,
    client_id: scope.clientId,
    engine: request.engine,
    prompt: request.prompt,
    cited: result.cited,
    // Contract: position nullable, >= 1. An uncited result carries no position.
    position: result.cited ? position : null,
    sentiment: result.sentiment,
    cited_source: result.citedSource,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory fake (M3/M4 tests; no vendor account needed)              */
/* ------------------------------------------------------------------ */

/** A scripted response rule: first matching rule wins. */
export interface CitationScript {
  engine?: VisibilityEngine;
  /** Substring or regex matched against the prompt. */
  promptMatch: string | RegExp;
  result: CitationPromptResult;
}

/** Not-cited default for unscripted prompts. */
export const UNCITED_RESULT: CitationPromptResult = {
  cited: false,
  position: null,
  sentiment: null,
  citedSource: null,
  raw: { source: "in-memory", scripted: false },
};

/**
 * Scriptable, journaling test double. Behaves like a vendor adapter without
 * any network: script responses, then assert on `calls`. Fault injection via
 * `failNext` exercises module retry/error paths.
 */
export class InMemoryCitationDataProvider implements CitationDataProvider {
  readonly vendor = "in-memory";
  readonly calls: CitationPromptRequest[] = [];
  private scripts: CitationScript[] = [];
  private nextError: Error | null = null;

  script(rule: CitationScript): this {
    this.scripts.push(rule);
    return this;
  }

  /** The next runPrompt() call rejects with `error`. */
  failNext(error: Error = new Error("citation provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  async runPrompt(request: CitationPromptRequest): Promise<CitationPromptResult> {
    this.calls.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const rule = this.scripts.find(
      (s) =>
        (s.engine === undefined || s.engine === request.engine) &&
        (typeof s.promptMatch === "string"
          ? request.prompt.includes(s.promptMatch)
          : s.promptMatch.test(request.prompt))
    );
    return rule ? rule.result : UNCITED_RESULT;
  }
}
