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
  const [prefill, setPrefill] = React.useState<ExtractFormPrefill | null>(null);
  const formRegionRef = React.useRef<HTMLDivElement>(null);
  // Focus the form region only when a prefill is APPLIED (not on mount).
  const appliedRef = React.useRef(false);

  React.useEffect(() => {
    if (appliedRef.current) formRegionRef.current?.focus();
  }, [prefill]);

  return (
    <div className="flex flex-col gap-8">
      <ExtractPanel
        clientId={clientId}
        clientName={clientName}
        initialState={initialExtractState}
        onUse={(p) => {
          appliedRef.current = true;
          setPrefill(p);
        }}
      />
      <div ref={formRegionRef} tabIndex={-1} className="outline-none">
        <BrandKitForm
          key={prefill?.draftId ?? "blank"}
          mode="create"
          clientId={clientId}
          clientName={clientName}
          extractPrefill={prefill ?? undefined}
        />
      </div>
    </div>
  );
}
