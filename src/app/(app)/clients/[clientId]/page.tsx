import { notFound, redirect } from "next/navigation";

import { getClaims } from "@/lib/auth/session";
import { isUuidV4 } from "@/lib/clients/validate";
import { WORKSPACE_DEFAULT_TAB } from "./(workspace)/tabs";

/**
 * `/clients/[clientId]` has no page of its own — it routes the caller to the
 * right entry: staff land on the workspace's default tab (Overview); a
 * `client_viewer` lands on their own white-label report. A malformed id 404s
 * before any redirect. RLS still gates the destination reads.
 */
export default async function ClientEntryPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const claims = await getClaims();
  if (claims?.role === "client_viewer") {
    redirect(`/clients/${clientId}/dashboard`);
  }
  redirect(`/clients/${clientId}/${WORKSPACE_DEFAULT_TAB}`);
}
