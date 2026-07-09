"use client";

/**
 * Login form — the one interactive island on the login screen. Calls the
 * frozen `signIn` server action (email + password), then navigates into the
 * app shell on success.
 *
 * Voice (doc 06 §6): errors say what happened + how to fix, in our voice —
 * never a raw Supabase string. Like Supabase, we do NOT reveal whether it was
 * the email or the password that was wrong (a single "they don't match"
 * message), so the form can't be used to probe which emails exist.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth/actions";
import { APP_HOME } from "@/components/app-shell/nav";

/** Map the action's result string to an interface-voice message. */
function friendlyError(raw: string): string {
  if (/required/i.test(raw)) return raw; // our own guard copy, already voiced
  return "That email and password don’t match. Check them and try again.";
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password to sign in.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await signIn({ email: trimmedEmail, password });
      if (result.ok) {
        // The action wrote the session cookies; refresh so the server shell
        // re-reads them, then move into the app.
        router.replace(APP_HOME);
        router.refresh();
        return; // keep the button in its busy state through the navigation
      }
      setError(friendlyError(result.error));
      setSubmitting(false);
    } catch {
      setError(
        "We couldn’t reach the sign-in service. Check your connection and try again."
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
          value={email}
          disabled={submitting}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error ? true : undefined}
          placeholder="you@agency.com"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={submitting}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? true : undefined}
          placeholder="••••••••••"
        />
      </div>

      {error ? (
        // Body-size error text needs 4.5:1 (WCAG 1.4.3), but `text-negative`
        // alone is only 3:1-gated by the palette policy — light mode wears
        // the designer-approved ink-mix (identical-pattern sweep, design
        // review 2026-07-09 Major 4; measured on both chrome layers of both
        // reachable palettes in
        // src/app/(app)/dashboard/error-text-contrast.test.ts).
        <p
          role="alert"
          className="text-sm text-[color-mix(in_oklab,var(--negative)_70%,var(--ink))] dark:text-negative"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={submitting} className="mt-1">
        {submitting ? (
          <>
            <Loader2Icon aria-hidden className="animate-spin" /> Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
