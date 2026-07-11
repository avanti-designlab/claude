"use client";

/**
 * The create-kit page's client shell: the paste-URL extract panel above the
 * ingest form, with the ONE piece of state they share — a reviewed draft the
 * operator chose to "use in the form". Applying a draft REMOUNTS the form
 * (key = draftId): the form reads its prefill once in its state initializers,
 * so a proposal can only ever replace form contents through the panel's
 * explicit, confirmed action — never by a background poll while typing.
 * Focus moves to the form after applying, so keyboard/screen-reader users land
 * where the values went (the panel also announces it politely).
 */

import * as React from "react";

import type { BrandExtractState } from "../_actions/extract";
import { BrandKitForm, type ExtractFormPrefill } from "./brand-kit-form";
import { ExtractPanel } from "./extract-panel";

export function CreateKitWithExtract({
  clientId,
  clientName,
  initialExtractState,
}: {
  clientId: string;
  clientName: string;
  initialExtractState: BrandExtractState;
}) {
  // Every CONFIRMED apply gets its own generation, so re-applying the same
  // draft (e.g. after changing the logo pick, or to reset edits back to the
  // proposal) is a REAL remount — the confirm's "anything typed is replaced"
  // promise is always true, never a silent no-op (Design M2).
  const [applied, setApplied] = React.useState<{
    generation: number;
    prefill: ExtractFormPrefill;
  } | null>(null);
  const formRegionRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (applied) formRegionRef.current?.focus();
  }, [applied]);

  return (
    <div className="flex flex-col gap-8">
      <ExtractPanel
        clientId={clientId}
        clientName={clientName}
        initialState={initialExtractState}
        onUse={(p) =>
          setApplied((prev) => ({
            generation: (prev?.generation ?? 0) + 1,
            prefill: p,
          }))
        }
      />
      <div ref={formRegionRef} tabIndex={-1} className="outline-none">
        <BrandKitForm
          key={applied ? `${applied.prefill.draftId}:${applied.generation}` : "blank"}
          mode="create"
          clientId={clientId}
          clientName={clientName}
          extractPrefill={applied?.prefill}
        />
      </div>
    </div>
  );
}
