import type { VisibilityEngine } from "@/lib/types/db";
import { VISIBILITY_ENGINES } from "@/lib/types/db";
import type { VisibilityPromptResult } from "@/lib/intelligence/visibility/reads";
import { StatusPill } from "../../../../../_components/surface";

/**
 * Per-prompt visibility results — the operator's daily question made visible:
 * "which prompts are we cited on, where, and who got cited instead" (doc 05 M3).
 * One row per prompt×engine sample from the LATEST run, grouped by prompt for
 * scanning. Server component, utilitarian (doc 06 §4/§5): no motion, no run
 * button (tracking is vendor-gated — the page owns the pending state).
 *
 * HONESTY: absent ≠ zero. `cited` is a real measured boolean (Cited / Not cited).
 * A dash means the signal WASN'T CAPTURED — an uncited sample carries no position,
 * a vendor may report no sentiment, and `cited_source` is often absent — none of
 * which is "0". Only measured samples are stored, so a prompt/engine missing from
 * the run simply isn't a row here. Vendor sentiment labels render verbatim (real
 * measured data, not an internal code); the display is bounded + truncation-honest.
 */

/** How many prompt groups render before an honest truncation note. */
const MAX_VISIBLE_PROMPTS = 50;

const ENGINE_LABEL: Record<VisibilityEngine, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
  copilot: "Copilot",
  google_aio: "Google AIO",
};

const ENGINE_ORDER = new Map(VISIBILITY_ENGINES.map((engine, i) => [engine, i]));

type PillTone = "muted" | "accent" | "positive" | "warm" | "negative";

/** Known vendor sentiment → label + tone; an unrecognized non-null value renders
 *  verbatim (muted) — it's real measured data, never dropped or invented. */
function sentimentMeta(value: string | null): { label: string; tone: PillTone } | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  switch (trimmed.toLowerCase()) {
    case "positive":
      return { label: "Positive", tone: "positive" };
    case "negative":
      return { label: "Negative", tone: "negative" };
    case "neutral":
      return { label: "Neutral", tone: "muted" };
    default:
      return { label: trimmed, tone: "muted" };
  }
}

interface PromptGroup {
  prompt: string;
  rows: VisibilityPromptResult[];
}

/** Group samples by prompt (first-seen order), engine-ordered within each group. */
function groupByPrompt(rows: VisibilityPromptResult[]): PromptGroup[] {
  const groups: PromptGroup[] = [];
  const byPrompt = new Map<string, PromptGroup>();
  for (const row of rows) {
    let group = byPrompt.get(row.prompt);
    if (!group) {
      group = { prompt: row.prompt, rows: [] };
      byPrompt.set(row.prompt, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  for (const group of groups) {
    group.rows.sort(
      (a, b) =>
        (ENGINE_ORDER.get(a.engine) ?? 99) - (ENGINE_ORDER.get(b.engine) ?? 99)
    );
  }
  return groups;
}

/** Muted em dash — a NOT-CAPTURED signal (never zero). */
function Dash() {
  return (
    <span className="text-muted" aria-label="not captured">
      —
    </span>
  );
}

export function PromptResults({ rows }: { rows: VisibilityPromptResult[] }) {
  if (rows.length === 0) {
    // A stored run has ≥1 measured sample by construction; this is a defensive
    // floor, never a fabricated "no citations" claim.
    return (
      <p className="text-sm text-muted">
        This run recorded no per-prompt samples.
      </p>
    );
  }

  const allGroups = groupByPrompt(rows);
  const groups = allGroups.slice(0, MAX_VISIBLE_PROMPTS);
  const hiddenPrompts = allGroups.length - groups.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <Th className="min-w-[14rem]">Prompt</Th>
              <Th>Engine</Th>
              <Th>Result</Th>
              <Th>Position</Th>
              <Th>Sentiment</Th>
              <Th className="min-w-[10rem]">Source cited</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) =>
              group.rows.map((r, i) => {
                const sentiment = sentimentMeta(r.sentiment);
                return (
                  <tr
                    key={`${group.prompt}::${r.engine}::${i}`}
                    className={
                      "align-top" + (i === 0 ? " border-t border-border" : "")
                    }
                  >
                    {i === 0 ? (
                      <td
                        rowSpan={group.rows.length}
                        className="max-w-[22rem] py-2.5 pr-4 align-top text-ink"
                      >
                        {group.prompt}
                      </td>
                    ) : null}
                    <td className="py-2.5 pr-4 whitespace-nowrap text-muted">
                      {ENGINE_LABEL[r.engine]}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <StatusPill tone={r.cited ? "positive" : "muted"}>
                        {r.cited ? "Cited" : "Not cited"}
                      </StatusPill>
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap tabular-nums text-ink">
                      {r.position !== null ? `#${r.position}` : <Dash />}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {sentiment ? (
                        <StatusPill tone={sentiment.tone}>
                          {sentiment.label}
                        </StatusPill>
                      ) : (
                        <Dash />
                      )}
                    </td>
                    <td className="py-2.5 font-mono text-xs break-all text-muted">
                      {r.citedSource !== null && r.citedSource.trim() !== "" ? (
                        r.citedSource
                      ) : (
                        <Dash />
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {hiddenPrompts > 0 ? (
        <p className="text-xs leading-5 text-muted">
          Showing {groups.length} of {allGroups.length} prompts from this run.
        </p>
      ) : null}
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={
        "py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.12em] text-muted uppercase " +
        className
      }
    >
      {children}
    </th>
  );
}
