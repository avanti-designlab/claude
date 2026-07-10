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
import { BrandKitForm, type RevisePrefill } from "../../_components/brand-kit-form";

export const metadata: Metadata = {
  title: "Revise brand kit — AEO/GEO + Brand Production OS",
  description: "Create the next version of a client's locked brand kit.",
};

/**
 * Revise a client's brand kit. Pre-fills the form from the CURRENT locked kit and
 * creates the next version on confirm (the current version stays immutable — its
 * history is preserved). A client with no kit routes to the create flow instead;
 * an out-of-scope id is a clean not-found.
 */
export default async function ReviseKitPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const client = await loadClientHeader(clientId);
  if (!client) notFound();

  const current = await readLockedBrandKit({ clientId });
  if (!current.ok) {
    if (current.reason === "not_found") notFound();
    return (
      <PageContainer>
        <Entrance step={0}>
          <PageHeader eyebrow="Revise brand kit" title={client.name} />
        </Entrance>
        <Entrance step={1}>
          <FailedState subject="this brand kit" />
        </Entrance>
      </PageContainer>
    );
  }
  // No kit to revise — send them to create the first one.
  if (current.kit === null) redirect(`/brand-kits/new/${clientId}`);

  const kit = current.kit;
  const prefill: RevisePrefill = {
    version: kit.version,
    colors: kit.tokens.colors,
    typography: {
      display: kit.tokens.typography.display,
      body: kit.tokens.typography.body,
      mono: kit.tokens.typography.mono,
    },
    voice: kit.voiceProfile,
    likeness: kit.likenessRefs,
    logoUrl: kit.logoUrl,
  };

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Revise brand kit"
          title={client.name}
          description={`Pre-filled from version ${kit.version}. Locking creates the next version — existing versions stay immutable, their history preserved.`}
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href={`/brand-kits/${clientId}`}>
                <ArrowLeftIcon aria-hidden /> Back to kit
              </Link>
            </Button>
          }
        />
      </Entrance>
      {/* No Entrance wrapper: forms stay OUT of the load choreography (doc 06
          §4 / moments policy — dense forms appear instantly). */}
      <BrandKitForm
        mode="revise"
        clientId={clientId}
        clientName={client.name}
        prefill={prefill}
      />
    </PageContainer>
  );
}
