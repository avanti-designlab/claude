"use client";

/**
 * The client-name block at the end of step 3. Continue out of step 3 is the
 * real write (client + server-generated plan persist together), so the name
 * is collected here — pre-filled from the first property's hostname (else the
 * first location) via `suggestClientName`, editable until the operator types.
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ClientNameFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export function ClientNameField({ value, onChange }: ClientNameFieldProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-ink">Save this client</h3>
        <p className="text-sm text-muted">
          Continue saves this client — with your primary website — to your
          workspace and generates their plan. You can refine everything later.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="client-name" className="text-muted">
          Client name
        </Label>
        <Input
          id="client-name"
          value={value}
          placeholder="e.g. Gable & Grove Realty"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}
