import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, CloudOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
} from "../../../../_components/surface";
import { loadAssetLibrary } from "../../_components/asset-reads";
import { AssetLibrary } from "../../_components/asset-library";

export const metadata: Metadata = {
  title: "Brand assets — AEO/GEO + Brand Production OS",
  description: "One client's brand asset library — logos, favicons, iconography, and imagery.",
};

/**
 * The per-client Brand Asset Library (operator-directed: "every client has their
 * own home of assets, branding never mixed"). Client-scoped by the `clientId` in
 * the URL; RLS is the real boundary below. A dedicated sub-route (not a panel on
 * the kit-detail page) because the library is a mutable CRUD surface with its own
 * states, and it must be usable even for a client with NO locked kit yet — the
 * kit-detail page's empty branch would otherwise hide it.
 */
export default async function BrandAssetsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  // Mirror the action write-floor exactly: requireOperator() = is_writer =
  // staff. A non-writer who reaches this operator surface gets a read-only view.
  const claims = await getClaims();
  const canManage = claims ? isStaffRole(claims.role) : false;

  const load = await loadAssetLibrary(clientId);
  if (load.status === "not_found") notFound();

  const header = (title: string) => (
    <Entrance step={0}>
      <PageHeader
        eyebrow="Brand Kits · Assets"
        title={title}
        description="This client's own home for brand assets — logos, favicons, iconography, and imagery. Nothing here is shared with another client."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/brand-kits/${clientId}`}>
              <ArrowLeftIcon aria-hidden /> Brand kit
            </Link>
          </Button>
        }
      />
    </Entrance>
  );

  if (load.status === "env_unset") {
    return (
      <PageContainer>
        {header("Brand assets")}
        <Entrance step={1}>
          <EmptyState
            icon={CloudOffIcon}
            title="Workspace not connected"
            description="Brand assets live in connected storage. Once this workspace's storage is wired up, this client's logos and imagery load here — uploads and previews need the live connection."
          />
        </Entrance>
      </PageContainer>
    );
  }

  if (load.status === "read_failed") {
    return (
      <PageContainer>
        {header("Brand assets")}
        <Entrance step={1}>
          <FailedState subject="this client" />
        </Entrance>
      </PageContainer>
    );
  }

  // The island owns every "ok" sub-state: failed-list (initial === null),
  // empty-library (canManage-aware copy), and the grouped view.
  return (
    <PageContainer>
      {header(load.client.name)}
      <Entrance step={1}>
        <AssetLibrary clientId={clientId} initial={load.assets} canManage={canManage} />
      </Entrance>
    </PageContainer>
  );
}
