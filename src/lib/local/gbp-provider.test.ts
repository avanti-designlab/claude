import { describe, expect, it } from "vitest";
import type { GbpProfileInput } from "@/lib/skills/aeo-audit";
import {
  GBP_NOT_CONNECTED,
  InMemoryGbpDataProvider,
  NotConnectedGbpProvider,
  type GbpDataProvider,
  type GbpLocationResult,
} from "./gbp-provider";

const PROFILE: GbpProfileInput = {
  locationName: "North Park",
  primaryCategory: "Cannabis store",
  description: "A dispensary.",
  phone: "619-555-0100",
  address: "3814 Ray St",
  websiteUrl: "https://x.test",
  hoursComplete: true,
  photoCount: 12,
  attributesComplete: true,
  postsLast30Days: 4,
};

describe("NotConnectedGbpProvider — honest absence", () => {
  it("returns not-connected for every location (never an invented profile)", async () => {
    const provider: GbpDataProvider = new NotConnectedGbpProvider();
    const result = await provider.fetchLocation({ name: "North Park", address: "3814 Ray St" });
    expect(result).toEqual({ connected: false });
    expect(provider.vendor).toBe("not-connected");
  });
});

describe("InMemoryGbpDataProvider — scriptable fake (no SDK, no network)", () => {
  it("returns a scripted connected profile and journals the call", async () => {
    const provider = new InMemoryGbpDataProvider().script("North Park", { connected: true, profile: PROFILE });
    const result = await provider.fetchLocation({ name: "North Park", address: "3814 Ray St" });
    expect(result).toEqual<GbpLocationResult>({ connected: true, profile: PROFILE });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].name).toBe("North Park");
  });

  it("defaults to not-connected for an unscripted location", async () => {
    const provider = new InMemoryGbpDataProvider();
    expect(await provider.fetchLocation({ name: "Elsewhere", address: null })).toEqual(GBP_NOT_CONNECTED);
  });

  it("failNext throws once (exercises the provider-unavailable path)", async () => {
    const provider = new InMemoryGbpDataProvider().failNext(new Error("boom"));
    await expect(provider.fetchLocation({ name: "North Park", address: null })).rejects.toThrow("boom");
    // Recovers on the next call.
    expect(await provider.fetchLocation({ name: "North Park", address: null })).toEqual(GBP_NOT_CONNECTED);
  });
});
