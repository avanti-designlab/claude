import { describe, expect, it } from "vitest";
import type { ClientLocation } from "@/lib/types/db";
import { parseClientLocations } from "./locations";

describe("parseClientLocations", () => {
  it("parses a {name, address} entry and extracts a ZIP from the address", () => {
    const locs: ClientLocation[] = [{ name: "North Park", address: "3814 Ray St, San Diego, CA 92104" }];
    const [loc] = parseClientLocations(locs);
    expect(loc).toMatchObject({
      index: 0,
      name: "North Park",
      address: "3814 Ray St, San Diego, CA 92104",
      phone: null, // ClientLocation carries no phone → honest null
      zip: "92104",
      usable: true,
    });
  });

  it("reads a numeric geo {lat,lng}; ignores an out-of-range pair", () => {
    const good = parseClientLocations([{ name: "A", address: "x", geo: { lat: 32.7, lng: -117.1 } }] as ClientLocation[]);
    expect(good[0].geo).toEqual({ latitude: 32.7, longitude: -117.1 });

    const bad = parseClientLocations([{ name: "A", address: "x", geo: { lat: 999, lng: -117.1 } }] as ClientLocation[]);
    expect(bad[0].geo).toBeNull();
  });

  it("trims blanks and marks an entry with neither name nor address as not usable", () => {
    const [loc] = parseClientLocations([{ name: "   ", address: "" }] as ClientLocation[]);
    expect(loc.name).toBeNull();
    expect(loc.address).toBeNull();
    expect(loc.usable).toBe(false);
  });

  it("degrades a malformed (non-object) entry to an unusable record — never throws", () => {
    const parsed = parseClientLocations(["nope", 42, null] as unknown as ClientLocation[]);
    expect(parsed).toHaveLength(3);
    expect(parsed.every((l) => !l.usable && l.name === null && l.address === null)).toBe(true);
  });

  it("returns [] for a non-array input", () => {
    expect(parseClientLocations("North Park" as unknown)).toEqual([]);
    expect(parseClientLocations(undefined)).toEqual([]);
  });

  it("preserves the original index for multi-location identity", () => {
    const parsed = parseClientLocations([
      { name: "One", address: "a" },
      { name: "Two", address: "b" },
    ] as ClientLocation[]);
    expect(parsed.map((l) => l.index)).toEqual([0, 1]);
  });
});
