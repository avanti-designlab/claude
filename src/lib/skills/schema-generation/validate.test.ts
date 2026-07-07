import { describe, expect, it } from "vitest";
import {
  canonicalPrice,
  isHttpUrl,
  isPositiveInt,
  isRatingInRange,
  isValidCurrency,
  isValidIsoDate,
  isValidIsoDuration,
  isValidTime,
  isoDateToEpoch,
} from "./validate";

describe("isHttpUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(isHttpUrl("https://example.com/page?x=1")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects protocol-less, malformed, and non-http URLs", () => {
    expect(isHttpUrl("linkedin.com/in/foo")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("ftp://example.com/file")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts plain dates and full date-times", () => {
    expect(isValidIsoDate("2026-04-02")).toBe(true);
    expect(isValidIsoDate("2026-08-11T19:00:00-07:00")).toBe(true);
    expect(isValidIsoDate("2026-05-14T09:30Z")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects impossible and malformed dates — no silent rollover", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2025-02-29")).toBe(false); // not a leap year
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("04/02/2026")).toBe(false);
    expect(isValidIsoDate("last Tuesday")).toBe(false);
    expect(isValidIsoDate("2026-04-02T25:00")).toBe(false);
  });

  it("orders dates correctly via isoDateToEpoch", () => {
    expect(isoDateToEpoch("2026-01-05")).toBeLessThan(isoDateToEpoch("2026-03-10"));
    expect(isoDateToEpoch("2026-03-10T08:00:00Z")).toBeLessThan(
      isoDateToEpoch("2026-03-10T09:00:00Z"),
    );
  });
});

describe("isValidIsoDuration", () => {
  it("accepts ISO 8601 durations", () => {
    expect(isValidIsoDuration("PT2M12S")).toBe(true);
    expect(isValidIsoDuration("PT1H5M")).toBe(true);
    expect(isValidIsoDuration("PT38M")).toBe(true);
    expect(isValidIsoDuration("P1DT2H")).toBe(true);
  });

  it("rejects clock formats and empty periods", () => {
    expect(isValidIsoDuration("2:12")).toBe(false);
    expect(isValidIsoDuration("P")).toBe(false);
    expect(isValidIsoDuration("PT")).toBe(false);
    expect(isValidIsoDuration("2 minutes")).toBe(false);
  });
});

describe("isValidTime", () => {
  it("accepts HH:MM 24h times and rejects everything else", () => {
    expect(isValidTime("09:00")).toBe(true);
    expect(isValidTime("21:30")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("9:00")).toBe(false);
    expect(isValidTime("09:60")).toBe(false);
  });
});

describe("canonicalPrice", () => {
  it("canonicalizes numbers and plain decimal strings", () => {
    expect(canonicalPrice(24.99)).toBe("24.99");
    expect(canonicalPrice(14)).toBe("14");
    expect(canonicalPrice("6.50")).toBe("6.50");
    expect(canonicalPrice(0)).toBe("0");
  });

  it("rejects negatives, symbols, and over-precise values", () => {
    expect(canonicalPrice(-5)).toBeUndefined();
    expect(canonicalPrice("$24.99")).toBeUndefined();
    expect(canonicalPrice("24,99")).toBeUndefined();
    expect(canonicalPrice(24.999)).toBeUndefined();
    expect(canonicalPrice(Number.NaN)).toBeUndefined();
  });
});

describe("isValidCurrency", () => {
  it("accepts 3-letter ISO 4217 codes only", () => {
    expect(isValidCurrency("USD")).toBe(true);
    expect(isValidCurrency("AED")).toBe(true);
    expect(isValidCurrency("US$")).toBe(false);
    expect(isValidCurrency("usd")).toBe(false);
    expect(isValidCurrency("")).toBe(false);
  });
});

describe("ratings and counts", () => {
  it("checks rating range with 1–5 defaults and custom bounds", () => {
    expect(isRatingInRange(4.8)).toBe(true);
    expect(isRatingInRange(1)).toBe(true);
    expect(isRatingInRange(5)).toBe(true);
    expect(isRatingInRange(6)).toBe(false);
    expect(isRatingInRange(0)).toBe(false);
    expect(isRatingInRange(9, 0, 10)).toBe(true);
    expect(isRatingInRange(Number.NaN)).toBe(false);
  });

  it("requires counts to be positive integers", () => {
    expect(isPositiveInt(212)).toBe(true);
    expect(isPositiveInt(0)).toBe(false);
    expect(isPositiveInt(-3)).toBe(false);
    expect(isPositiveInt(4.5)).toBe(false);
  });
});
