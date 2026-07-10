"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Error boundary for a client-workspace tab (client component, as Next
 * requires). The workspace layout persists around this, so the operator keeps
 * the client header and tabs; only the failed tab content is replaced with an
 * honest, calm retry. No stack traces — the error is logged for observability.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card className="flex flex-col items-center gap-5 border-dashed py-16 text-center">
      <div className="flex max-w-md flex-col gap-2 px-6">
        <h2 className="font-display text-xl font-bold tracking-tight text-ink">
          This tab didn&apos;t load
        </h2>
        <p className="text-sm leading-6 text-muted">
          Something went wrong loading this tab — your data isn&apos;t affected
          by viewing errors. Try again; the rest of this client&apos;s
          workspace still works.
        </p>
      </div>
      <Button onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </Card>
  );
}
