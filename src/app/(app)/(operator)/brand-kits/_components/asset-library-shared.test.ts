import { describe, expect, it } from "vitest";

import {
  BRAND_ASSET_MAX_BYTES,
  ASSET_EMPTY_ERROR,
  ASSET_INVALID_MIME_ERROR,
  ASSET_TOO_LARGE_ERROR,
} from "@/lib/brand-assets/validate";
import { BRAND_ASSET_TYPES } from "@/lib/types/db";
import {
  ASSET_GROUPS,
  ASSET_TYPE_LABEL,
  detectAssetKind,
  formatBytes,
  groupAssets,
  mimeShortLabel,
  precheckFile,
} from "./asset-library-shared";

describe("asset taxonomy coverage", () => {
  it("labels every stored type (no code ever renders raw)", () => {
    for (const t of BRAND_ASSET_TYPES) {
      expect(ASSET_TYPE_LABEL[t]).toBeTruthy();
    }
  });

  it("every stored type is claimed by exactly one display group", () => {
    const seen = new Map<string, number>();
    for (const g of ASSET_GROUPS) for (const t of g.types) seen.set(t, (seen.get(t) ?? 0) + 1);
    for (const t of BRAND_ASSET_TYPES) {
      expect(seen.get(t), `type ${t} must be grouped once`).toBe(1);
    }
  });
});

describe("groupAssets", () => {
  it("returns all groups in order, even when empty", () => {
    const out = groupAssets([]);
    expect(out.map((o) => o.group.id)).toEqual([
      "logos",
      "favicon",
      "icons",
      "imagery",
      "other",
    ]);
    for (const o of out) expect(o.assets).toEqual([]);
  });

  it("partitions the four logo sub-types into the Logos group", () => {
    const assets = [
      { type: "primary_logo" as const, id: "a" },
      { type: "reversed_logo" as const, id: "b" },
      { type: "favicon" as const, id: "c" },
      { type: "icon" as const, id: "d" },
      { type: "imagery" as const, id: "e" },
      { type: "other" as const, id: "f" },
    ];
    const out = groupAssets(assets);
    const logos = out.find((o) => o.group.id === "logos")!;
    expect(logos.assets.map((a) => a.id)).toEqual(["a", "b"]);
    expect(out.find((o) => o.group.id === "favicon")!.assets.map((a) => a.id)).toEqual(["c"]);
    expect(out.find((o) => o.group.id === "icons")!.assets.map((a) => a.id)).toEqual(["d"]);
    expect(out.find((o) => o.group.id === "imagery")!.assets.map((a) => a.id)).toEqual(["e"]);
    expect(out.find((o) => o.group.id === "other")!.assets.map((a) => a.id)).toEqual(["f"]);
  });

  it("preserves input order within a group", () => {
    const assets = [
      { type: "primary_logo" as const, id: "1" },
      { type: "primary_logo" as const, id: "2" },
      { type: "primary_logo" as const, id: "3" },
    ];
    const logos = groupAssets(assets).find((o) => o.group.id === "logos")!;
    expect(logos.assets.map((a) => a.id)).toEqual(["1", "2", "3"]);
  });

  it("falls an unknown type into Other rather than dropping it", () => {
    const assets = [{ type: "totally_new_type" as never, id: "x" }];
    const other = groupAssets(assets).find((o) => o.group.id === "other")!;
    expect(other.assets.map((a) => a.id)).toEqual(["x"]);
  });
});

describe("detectAssetKind", () => {
  it("routes SVG by MIME and by extension (empty-type browsers)", () => {
    expect(detectAssetKind({ name: "logo.svg", type: "image/svg+xml", size: 10 })).toBe("svg");
    expect(detectAssetKind({ name: "logo.svg", type: "", size: 10 })).toBe("svg");
  });

  it("routes raster by MIME and by extension", () => {
    expect(detectAssetKind({ name: "l.png", type: "image/png", size: 10 })).toBe("raster");
    expect(detectAssetKind({ name: "l.JPG", type: "", size: 10 })).toBe("raster");
    expect(detectAssetKind({ name: "l.webp", type: "image/webp", size: 10 })).toBe("raster");
    expect(detectAssetKind({ name: "l.gif", type: "image/gif", size: 10 })).toBe("raster");
  });

  it("rejects anything else as unsupported", () => {
    expect(detectAssetKind({ name: "doc.pdf", type: "application/pdf", size: 10 })).toBe(
      "unsupported",
    );
    expect(detectAssetKind({ name: "page.html", type: "text/html", size: 10 })).toBe(
      "unsupported",
    );
    expect(detectAssetKind({ name: "noext", type: "", size: 10 })).toBe("unsupported");
  });
});

describe("precheckFile mirrors the server floors verbatim", () => {
  it("refuses an unsupported type before size", () => {
    const r = precheckFile({ name: "x.pdf", type: "application/pdf", size: BRAND_ASSET_MAX_BYTES + 1 });
    expect(r).toEqual({ ok: false, error: ASSET_INVALID_MIME_ERROR });
  });

  it("refuses an empty file", () => {
    expect(precheckFile({ name: "x.png", type: "image/png", size: 0 })).toEqual({
      ok: false,
      error: ASSET_EMPTY_ERROR,
    });
  });

  it("refuses over the 10MiB cap", () => {
    expect(
      precheckFile({ name: "x.png", type: "image/png", size: BRAND_ASSET_MAX_BYTES + 1 }),
    ).toEqual({ ok: false, error: ASSET_TOO_LARGE_ERROR });
  });

  it("accepts a valid raster and svg with the routed kind", () => {
    expect(precheckFile({ name: "x.png", type: "image/png", size: 1000 })).toEqual({
      ok: true,
      kind: "raster",
      contentType: "image/png",
    });
    expect(precheckFile({ name: "x.svg", type: "image/svg+xml", size: 1000 })).toEqual({
      ok: true,
      kind: "svg",
    });
    // Exactly at the cap is allowed (the server refuses only ABOVE it).
    expect(precheckFile({ name: "x.png", type: "image/png", size: BRAND_ASSET_MAX_BYTES })).toEqual(
      { ok: true, kind: "raster", contentType: "image/png" },
    );
  });

  it("resolves a raster MIME from the extension when the browser omits type", () => {
    expect(precheckFile({ name: "logo.JPG", type: "", size: 1000 })).toEqual({
      ok: true,
      kind: "raster",
      contentType: "image/jpeg",
    });
  });
});

describe("formatBytes / mimeShortLabel", () => {
  it("formats binary sizes", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("names each MIME", () => {
    expect(mimeShortLabel("image/png")).toBe("PNG");
    expect(mimeShortLabel("image/svg+xml")).toBe("SVG");
    expect(mimeShortLabel("image/jpeg")).toBe("JPG");
    expect(mimeShortLabel("weird/thing")).toBe("Image");
  });
});
