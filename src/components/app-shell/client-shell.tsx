import { LogOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOutAndRedirect } from "./actions";

/**
 * The CLIENT-VIEWER shell — deliberately brand-free (doc 06 §3: "client-viewers
 * never see platform branding; only the agency's"). No Signal wordmark, no
 * operator nav: the white-label report inside owns the surface and wears the
 * tenant's brand. All this chrome adds is a quiet sign-out — a client_viewer's
 * only operator-neutral affordance.
 *
 * Role confinement is enforced by RLS + the operator-surface guards; this shell
 * simply gives that role a home that never leaks the operator app around it.
 */
export function ClientShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border bg-surface/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/70 sm:px-6">
        <form action={signOutAndRedirect} className="ml-auto">
          <Button type="submit" variant="ghost" size="sm" className="text-muted">
            <LogOutIcon aria-hidden /> Sign out
          </Button>
        </form>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
