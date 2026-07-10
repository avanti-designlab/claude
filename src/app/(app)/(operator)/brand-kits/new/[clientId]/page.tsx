import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import { readLockedBrandKit } from "@/lib/production/brand-kit/actions";
import { FailedState, PageContainer, PageHeader } from "../../../../_components/surface";
import { loadClientHeader } from "../../_components/kit-reads";
import { BrandKitForm } from "../../_components/brand-kit-form";

export const metadata: Metadata = {
  title: "Ingest a brand kit — AEO/GEO + Brand Production OS",
  description: "Encode a client's brand into a locked, enforceable kit.",
};

/**
 * The ingest form for one client. Guards up front: an out-of-scope id is a clean
 * not-found (RLS returns nothing); a client that ALREADY has a kit routes to its
 * detail (create refuses a second kit — revise keeps history); only a client with
 * no kit yet reaches the form. Nothing is written here — the form's confirm step
 * calls the frozen create action.
 */
export default async function IngestFormPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const client = await loadClientHeader(clientId);
  if (!client) notFound();

  const existing = await readLockedBrandKit({ clientId });
  if (!existing.ok) {
    if (existing.reason === "not_found") notFound();
    return (
      <PageContainer>
        <Entrance step={0}>
          <PageHeader eyebrow="Ingest a brand kit" title={client.name} />
        </Entrance>
        <Entrance step={1}>
          <FailedState subject="this client's brand kit" />
        </Entrance>
      </PageContainer>
    );
  }
  // Already locked in — send them to the detail, where they can revise.
  if (existing.kit !== null) redirect(`/brand-kits/${clientId}`);

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Ingest a brand kit"
          title={client.name}
          description="Capture the brand once. You'll review the accessible result before locking — locked kits are immutable, and a later change creates a new version."
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/brand-kits/new">
                <ArrowLeftIcon aria-hidden /> Change client
              </Link>
            </Button>
          }
        />
      </Entrance>
      {/* No Entrance wrapper: forms stay OUT of the load choreography (doc 06
          §4 / moments policy — dense forms appear instantly). */}
      <BrandKitForm mode="create" clientId={clientId} clientName={client.name} />
    </PageContainer>
  );
}
