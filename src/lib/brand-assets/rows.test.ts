import { describe, expect, it } from "vitest";
import { brandAssetFromRow, brandAssetInsertRow } from "./rows";

const T = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const PATH = `${T}/${C}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

describe("brandAssetInsertRow", () => {
  it("maps camelCase args to the snake_case insert row", () => {
    const row = brandAssetInsertRow({
      tenantId: T,
      clientId: C,
      type: "primary_logo",
      label: "Primary",
      variants: { width: 512 },
      storagePath: PATH,
      contentType: "image/png",
      sizeBytes: 2048,
    });
    expect(row).toEqual({
      tenant_id: T,
      client_id: C,
      type: "primary_logo",
      label: "Primary",
      variants: { width: 512 },
      storage_path: PATH,
      content_type: "image/png",
      size_bytes: 2048,
    });
  });
});

describe("brandAssetFromRow", () => {
  const good = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: C,
    type: "primary_logo",
    label: "Primary",
    variants: { width: 512 },
    storage_path: PATH,
    content_type: "image/png",
    size_bytes: 2048,
    archived_at: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
  };

  it("shapes a valid row into a BrandAsset", () => {
    const asset = brandAssetFromRow(good);
    expect(asset).not.toBeNull();
    expect(asset).toMatchObject({
      id: good.id,
      clientId: C,
      type: "primary_logo",
      label: "Primary",
      variants: { width: 512 },
      storagePath: PATH,
      contentType: "image/png",
      sizeBytes: 2048,
      archived: false,
    });
  });

  it("marks archived when archived_at is set", () => {
    const asset = brandAssetFromRow({ ...good, archived_at: "2026-07-10T01:00:00Z" });
    expect(asset?.archived).toBe(true);
  });

  it("degrades malformed variants to {} rather than nulling the asset", () => {
    const asset = brandAssetFromRow({ ...good, variants: "not-an-object" });
    expect(asset?.variants).toEqual({});
  });

  it("coerces a numeric-string size_bytes", () => {
    const asset = brandAssetFromRow({ ...good, size_bytes: "4096" });
    expect(asset?.sizeBytes).toBe(4096);
  });

  it("returns null on structurally unusable rows (missing path / bad size / bad ids)", () => {
    expect(brandAssetFromRow({ ...good, storage_path: "" })).toBeNull();
    expect(brandAssetFromRow({ ...good, storage_path: 123 })).toBeNull();
    expect(brandAssetFromRow({ ...good, size_bytes: "not-a-number" })).toBeNull();
    expect(brandAssetFromRow({ ...good, id: 42 })).toBeNull();
    expect(brandAssetFromRow({ ...good, client_id: null })).toBeNull();
  });
});
