import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import { GlowCard, ModeToggle } from "@/components/dashboard-preview";
import { LoginForm } from "@/components/auth/login-form";
import { APP_HOME } from "@/components/app-shell/nav";
import { getClaims } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in — AEO/GEO + Brand Production OS",
  description: "Sign in to your agency workspace.",
};

/**
 * Login screen. A premium first impression in the operator brand: the floating
 * glow hero bubble (the page's one glow moment), Geist type, entrance
 * choreography on load, light/dark via the standard mode mechanism, reduced
 * motion honored through the frozen entrance gates.
 *
 * If the caller is ALREADY signed in (a verified claim exists), we send them
 * into the app rather than showing the form. The claim is read via the
 * signature-verifying `getClaims()`; if env isn't provisioned yet the read
 * fails closed (null) and the form renders — never a 500.
 */

/** Mode-aware on-hero foregrounds (vivid-blue fill light / navy-glow dark). */
const HERO = {
  base: "text-accent-foreground dark:text-ink",
  soft: "text-accent-foreground/85 dark:text-ink/85",
  dim: "text-accent-foreground/70 dark:text-muted",
};

export default async function LoginPage() {
  const claims = await getClaims();
  if (claims) redirect(APP_HOME);

  return (
    <main className="relative flex min-h-full flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
        <ModeToggle />
      </div>

      <div className="flex w-full max-w-md flex-col gap-6">
        {/* HERO — the floating glow bubble; entrance step 0, glow blooms after
            the card lands. Text rides mode-aware token foregrounds. */}
        <Entrance step={0}>
          <GlowCard surface="hero" scale="hero" bloom>
            <div className={"flex flex-col gap-3 p-7 sm:p-9 " + HERO.base}>
              <div className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-md bg-accent-foreground/15 dark:bg-ink/10">
                  <span className="size-2 rounded-[3px] bg-accent-foreground dark:bg-ink" />
                </span>
                <p className="font-display text-lg leading-6 font-bold">Signal</p>
              </div>
              <h1 className="font-display text-3xl leading-[1.05] font-bold tracking-[-0.02em] sm:text-display">
                Welcome back
              </h1>
              <p className={"max-w-sm text-sm " + HERO.soft}>
                Sign in to your agency workspace — your clients, plans, and the
                intelligence behind them.
              </p>
            </div>
          </GlowCard>
        </Entrance>

        <Entrance step={1}>
          <Card className="gap-5 p-6 sm:p-7">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-xl font-bold text-ink">Sign in</h2>
              <p className="text-sm text-muted">
                Use the email and password your agency set up for you.
              </p>
            </div>
            <LoginForm />
          </Card>
        </Entrance>

        <Entrance step={2}>
          <p className="text-center text-xs leading-5 text-muted">
            No account yet? Access is provisioned by your agency admin — ask them
            to add you.
          </p>
        </Entrance>
      </div>
    </main>
  );
}
