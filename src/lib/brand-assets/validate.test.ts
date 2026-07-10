import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_MAX_BYTES,
  buildStoragePath,
  extensionForMime,
  isBrandAssetMime,
  isBrandAssetType,
  isSvgMime,
  isTenantClientScopedPath,
  sniffRasterMagic,
  validateAssetMetadata,
} from "./validate";

function bytes(...b: number[]): Uint8Array {
  return Uint8Array.from(b);
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const T = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";

describe("brand-asset type / MIME guards mirror the 0014 CHECKs", () => {
  it("accepts the 8 asset types and rejects others", () => {
    for (const t of [
      "primary_logo",
      "secondary_logo",
      "mono_logo",
      "reversed_logo",
      "favicon",
      "icon",
      "imagery",
      "other",
    ]) {
      expect(isBrandAssetType(t)).toBe(true);
    }
    expect(isBrandAssetType("wordmark")).toBe(false);
    expect(isBrandAssetType("")).toBe(false);
    expect(isBrandAssetType(null)).toBe(false);
  });

  it("accepts the raster+svg MIME allowlist and rejects others", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]) {
      expect(isBrandAssetMime(m)).toBe(true);
    }
    expect(isBrandAssetMime("image/tiff")).toBe(false);
    expect(isBrandAssetMime("text/html")).toBe(false);
    expect(isBrandAssetMime("application/pdf")).toBe(false);
    expect(isSvgMime("image/svg+xml")).toBe(true);
    expect(isSvgMime("image/png")).toBe(false);
  });

  it("maps MIME → extension", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
  });
});

describe("validateAssetMetadata", () => {
  const base = { type: "primary_logo", contentType: "image/png", sizeBytes: 1024 };

  it("accepts valid raster metadata and trims the label", () => {
    const res = validateAssetMetadata({ ...base, label: "  Primary logo  " });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.type).toBe("primary_logo");
      expect(res.value.contentType).toBe("image/png");
      expect(res.value.label).toBe("Primary logo");
      expect(res.value.variants).toEqual({});
    }
  });

  it("accepts SVG metadata (routing is the action's job, not this validator's)", () => {
    const res = validateAssetMetadata({ ...base, contentType: "image/svg+xml" });
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown type / MIME", () => {
    expect(validateAssetMetadata({ ...base, type: "wordmark" }).ok).toBe(false);
    expect(validateAssetMetadata({ ...base, contentType: "image/tiff" }).ok).toBe(false);
  });

  it("rejects non-positive, non-integer, and over-cap sizes", () => {
    expect(validateAssetMetadata({ ...base, sizeBytes: 0 }).ok).toBe(false);
    expect(validateAssetMetadata({ ...base, sizeBytes: -5 }).ok).toBe(false);
    expect(validateAssetMetadata({ ...base, sizeBytes: 3.5 }).ok).toBe(false);
    expect(validateAssetMetadata({ ...base, sizeBytes: BRAND_ASSET_MAX_BYTES + 1 }).ok).toBe(false);
    expect(validateAssetMetadata({ ...base, sizeBytes: BRAND_ASSET_MAX_BYTES }).ok).toBe(true);
  });

  it("empty/whitespace label becomes null; over-long label rejects", () => {
    const empty = validateAssetMetadata({ ...base, label: "   " });
    expect(empty.ok && empty.value.label).toBe(null);
    expect(validateAssetMetadata({ ...base, label: "x".repeat(121) }).ok).toBe(false);
  });

  it("accepts a bounded object of variants and strips prototype-pollution keys", () => {
    const res = validateAssetMetadata({
      ...base,
      variants: { width: 512, height: 512, ["__proto__"]: { polluted: true } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.variants.width).toBe(512);
      expect(Object.prototype.hasOwnProperty.call(res.value.variants, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it("rejects array variants and oversized variants", () => {
    expect(validateAssetMetadata({ ...base, variants: [1, 2, 3] }).ok).toBe(false);
    const big = { note: "x".repeat(5000) };
    expect(validateAssetMetadata({ ...base, variants: big }).ok).toBe(false);
  });
});

describe("sniffRasterMagic — bytes are truth (the finalize MIME defense)", () => {
  it("detects the allowlisted raster signatures from leading bytes", () => {
    expect(sniffRasterMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffRasterMagic(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
    expect(sniffRasterMagic(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(
      sniffRasterMagic(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))
    ).toBe("image/webp");
  });

  it("returns null for SVG/XML/HTML bytes uploaded on the raster path (the bypass)", () => {
    expect(sniffRasterMagic(utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffRasterMagic(utf8('<?xml version="1.0"?><svg></svg>'))).toBeNull();
    expect(sniffRasterMagic(utf8("<!DOCTYPE html><html></html>"))).toBeNull();
    expect(sniffRasterMagic(utf8("<html><script>alert(1)</script></html>"))).toBeNull();
    // A leading whitespace/BOM before "<svg" is still not a raster signature.
    expect(sniffRasterMagic(utf8("\n  <svg></svg>"))).toBeNull();
  });

  it("returns null for unknown / truncated signatures", () => {
    expect(sniffRasterMagic(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(sniffRasterMagic(bytes(0x89))).toBeNull(); // too short for PNG
    // RIFF but not WEBP at offset 8 (e.g. a WAV) → null.
    expect(sniffRasterMagic(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(sniffRasterMagic(bytes())).toBeNull();
  });
});

describe("buildStoragePath / isTenantClientScopedPath", () => {
  it("builds a tenant/client-scoped path with the MIME extension", () => {
    const path = buildStoragePath(T, C, "image/png", "33333333-3333-4333-8333-333333333333");
    expect(path).toBe(`${T}/${C}/33333333-3333-4333-8333-333333333333.png`);
    expect(isTenantClientScopedPath(path, T, C)).toBe(true);
  });

  it("rejects a path scoped to a DIFFERENT tenant or client", () => {
    const otherT = "99999999-9999-4999-8999-999999999999";
    const path = buildStoragePath(T, C, "image/png");
    expect(isTenantClientScopedPath(path, otherT, C)).toBe(false);
    expect(isTenantClientScopedPath(path, T, otherT)).toBe(false);
  });

  it("rejects traversal, nested folders, backslashes, and absurd lengths", () => {
    expect(isTenantClientScopedPath(`${T}/${C}/../${C}/x.png`, T, C)).toBe(false);
    expect(isTenantClientScopedPath(`${T}/${C}/sub/x.png`, T, C)).toBe(false);
    expect(isTenantClientScopedPath(`${T}/${C}/x\\y.png`, T, C)).toBe(false);
    expect(isTenantClientScopedPath(`${T}/${C}/`, T, C)).toBe(false);
    expect(isTenantClientScopedPath(`${T}/${C}/${"x".repeat(1100)}`, T, C)).toBe(false);
    expect(isTenantClientScopedPath("", T, C)).toBe(false);
    expect(isTenantClientScopedPath(42, T, C)).toBe(false);
  });

  it("rejects when tenant/client ids are not UUIDs (defensive)", () => {
    expect(isTenantClientScopedPath("a/b/c.png", "a", "b")).toBe(false);
  });
});
