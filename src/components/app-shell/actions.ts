"use server";

import { redirect } from "next/navigation";

import { signOut } from "@/lib/auth/actions";
import { LOGIN_PATH } from "./nav";

/**
 * Sign out, then send the browser back to the login screen. Wraps the frozen
 * `signOut` action (which clears the session cookies) and adds the navigation
 * the top-bar form wants. Runs as a form action, so it works without client JS.
 */
export async function signOutAndRedirect(): Promise<void> {
  await signOut();
  redirect(LOGIN_PATH);
}
