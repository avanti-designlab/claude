/**
 * Pure BrandKit ⇄ `brand_kits` row mapping suite (frozen schema: migration
 * 0003). Pins the column mapping, the always-locked immutable-capture rule, and
 * the defensive read parse (corrupt tokens → unusable; malformed voice/likeness
 * → empty, not a broken kit).
 */

import { describe, expect, it } from "vitest";
import { ingestBrandKit, type IngestionReport } from "./ingest";
import { brandKitFromRow, brandKitInsertRow, brandKitVersionEntry } from "./rows";

function buildKit() {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff" },
    voice: { descriptors: ["confident"], samples: ["We build."] },
    likeness: { higgsfieldElementIds: ["hf_1"] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  return res;
}

describe("brandKitInsertRow", () => {
  it("maps the kit onto the frozen brand_kits columns, always locked, version explicit", () => {
    const { kit, report, logoUrl } = buildKit();
    const row = brandKitInsertRow({
      tenantId: "tenant-1",
      clientId: "client-1",
      kit,
      version: 3,
      logoUrl,
      report,
    });
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.client_id).toBe("client-1");
    expect(row.tokens).toBe(kit.tokens);
    expect(row.voice_profile).toBe(kit.voice_profile);
    expect(row.likeness_refs).toBe(kit.likeness_refs);
    expect(row.assets.logo_url).toBe("https://cdn/logo.svg");
    expect(row.assets.ingestion).toBe(report);
    // Only locked, immutable captures are persisted (see persist.ts header).
    expect(row.locked).toBe(true);
    // Version is the caller's explicit value, not read from the in-memory kit.
    expect(row.version).toBe(3);
  });

  it("stores a null logo when none was provided", () => {
    const res = ingestBrandKit({ colors: { accent: "#2b6cff" } });
    if (!res.ok) throw new Error("fixture");
    const row = brandKitInsertRow({
      tenantId: "t",
      clientId: "c",
      kit: res.kit,
      version: 1,
      logoUrl: res.logoUrl,
      report: res.report,
    });
    expect(row.assets.logo_url).toBeNull();
  });
});

describe("brandKitFromRow — defensive read parse", () => {
  const report: IngestionReport = {
    notes: [{ field: "logo", status: "missing", note: "x" }],
    contrastCorrections: [],
    contrastResolved: true,
    unresolvedContrast: [],
  };
  const goodRow = {
    id: "kit-1",
    client_id: "client-1",
    version: 2,
    tokens: { colors: { accent: "#2b6cff" }, typography: {}, spacing: {} },
    voice_profile: { descriptors: ["confident"], samples: [], do: [], dont: [] },
    likeness_refs: { higgsfieldElementIds: ["hf_1"], motionElementIds: [] },
    assets: { logo_url: "https://cdn/logo.svg", ingestion: report },
    created_at: "2026-07-09T00:00:00Z",
  };

  it("shapes a well-formed row into a LockedBrandKit", () => {
    const kit = brandKitFromRow(goodRow);
    expect(kit).not.toBeNull();
    if (!kit) return;
    expect(kit.id).toBe("kit-1");
    expect(kit.version).toBe(2);
    expect(kit.logoUrl).toBe("https://cdn/logo.svg");
    expect(kit.provenance).toEqual(report);
    expect(kit.voiceProfile.descriptors).toEqual(["confident"]);
  });

  it("returns null when tokens are structurally corrupt (never hand on a broken kit)", () => {
    expect(brandKitFromRow({ ...goodRow, tokens: null })).toBeNull();
    expect(brandKitFromRow({ ...goodRow, tokens: "oops" })).toBeNull();
    expect(brandKitFromRow({ ...goodRow, version: "two" })).toBeNull();
  });

  it("degrades malformed voice/likeness to empty (the not-provided state), not a null kit", () => {
    const kit = brandKitFromRow({ ...goodRow, voice_profile: null, likeness_refs: 7 });
    expect(kit).not.toBeNull();
    if (!kit) return;
    expect(kit.voiceProfile).toEqual({ descriptors: [], samples: [], do: [], dont: [] });
    expect(kit.likenessRefs).toEqual({ higgsfieldElementIds: [], motionElementIds: [] });
  });

  it("nulls logo + provenance when assets is absent/malformed", () => {
    const kit = brandKitFromRow({ ...goodRow, assets: null });
    expect(kit?.logoUrl).toBeNull();
    expect(kit?.provenance).toBeNull();
  });
});

describe("brandKitVersionEntry", () => {
  it("derives provenance counts from assets.ingestion", () => {
    const entry = brandKitVersionEntry({
      id: "kit-1",
      version: 4,
      locked: true,
      assets: {
        logo_url: null,
        ingestion: {
          notes: [{ field: "logo" }, { field: "voice" }],
          contrastCorrections: [{ token: "accent" }],
          contrastResolved: true,
          unresolvedContrast: [],
        },
      },
      created_at: "2026-07-09T00:00:00Z",
    });
    expect(entry).toEqual({
      id: "kit-1",
      version: 4,
      locked: true,
      createdAt: "2026-07-09T00:00:00Z",
      contrastCorrectionCount: 1,
      unspecifiedInputCount: 2,
    });
  });

  it("nulls the counts when provenance is absent", () => {
    const entry = brandKitVersionEntry({
      id: "kit-1",
      version: 1,
      locked: true,
      assets: { logo_url: null },
      created_at: "2026-07-09T00:00:00Z",
    });
    expect(entry.contrastCorrectionCount).toBeNull();
    expect(entry.unspecifiedInputCount).toBeNull();
  });
});
