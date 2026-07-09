/**
 * Internal generator toolkit: the issue/claim accumulator every type generator
 * writes into, plus shared node builders (PostalAddress, OpeningHours, Offer,
 * AggregateRating, Review).
 *
 * Not part of the public API — import from "./index" (or "./generate"/"./types")
 * outside this skill.
 */

import type {
  AggregateRatingValueInput,
  ClaimKind,
  GeoCoordinatesInput,
  IssueSeverity,
  JsonLdObject,
  JsonLdValue,
  OfferInput,
  OpeningHoursInput,
  PostalAddressInput,
  ReviewValueInput,
  ClaimSpec,
  ValidationIssue,
} from "./types";
import { DAYS_OF_WEEK } from "./types";
import {
  canonicalPrice,
  isHttpUrl,
  isPositiveInt,
  isRatingInRange,
  isValidCurrency,
  isValidIsoDate,
  isValidIsoDuration,
  isValidLatitude,
  isValidLongitude,
  isValidTime,
  issue,
  ratingBounds,
} from "./validate";

/* ------------------------------------------------------------------ */
/* Accumulator                                                         */
/* ------------------------------------------------------------------ */

export interface Gen {
  issues: ValidationIssue[];
  claims: ClaimSpec[];
}

export function newGen(): Gen {
  return { issues: [], claims: [] };
}

/** What a type generator hands back to `generateSchema`. */
export interface GeneratorOutput {
  node: JsonLdObject;
  claims: ClaimSpec[];
  issues: ValidationIssue[];
}

export function output(gen: Gen, node: JsonLdObject): GeneratorOutput {
  return { node, claims: gen.claims, issues: gen.issues };
}

/** Joins a base path and key: p("employee", "name") → "employee.name". */
export function p(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

/** Sets a property only when the value is present and non-empty. */
export function setIf(node: JsonLdObject, key: string, value: JsonLdValue | undefined): void {
  if (value === undefined) return;
  if (typeof value === "string" && value.trim() === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  node[key] = value;
}

/** Registers a visible-text claim (skipped when the value is empty). */
export function claim(
  gen: Gen,
  path: string,
  label: string,
  value: string,
  kind: ClaimKind = "text",
  severity: IssueSeverity = "error",
): void {
  if (value.trim() === "") return;
  gen.claims.push({ path, label, value, kind, severity });
}

/** Required non-empty string; records MISSING_REQUIRED and returns false when absent. */
export function required(
  gen: Gen,
  path: string,
  label: string,
  value: string | undefined | null,
): value is string {
  if (typeof value === "string" && value.trim() !== "") return true;
  gen.issues.push(
    issue("MISSING_REQUIRED", "error", path, `${label} is required and was missing or empty.`),
  );
  return false;
}

export function recommend(gen: Gen, path: string, label: string): void {
  gen.issues.push(
    issue(
      "MISSING_RECOMMENDED",
      "warning",
      path,
      `${label} is recommended for rich-result eligibility and was not provided.`,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Field checkers (validate + set)                                     */
/* ------------------------------------------------------------------ */

export function checkUrlField(
  gen: Gen,
  path: string,
  label: string,
  value: string | undefined,
  opts: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value.trim() === "") {
    if (opts.required) {
      gen.issues.push(issue("MISSING_REQUIRED", "error", path, `${label} is required.`));
    }
    return undefined;
  }
  if (!isHttpUrl(value)) {
    gen.issues.push(
      issue("INVALID_URL", "error", path, `${label} ("${value}") is not a valid http(s) URL.`),
    );
    return undefined;
  }
  return value;
}

export function checkUrlArrayField(
  gen: Gen,
  path: string,
  label: string,
  values: string[] | undefined,
): string[] {
  const valid: string[] = [];
  (values ?? []).forEach((value, i) => {
    const checked = checkUrlField(gen, `${path}[${i}]`, `${label} #${i + 1}`, value);
    if (checked !== undefined) valid.push(checked);
  });
  return valid;
}

/**
 * Validates a caller-supplied date. Never invents one: an absent optional date
 * stays absent (SKILL.md rule 5).
 */
export function checkDateField(
  gen: Gen,
  path: string,
  label: string,
  value: string | undefined,
  opts: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value.trim() === "") {
    if (opts.required) {
      gen.issues.push(
        issue(
          "MISSING_REQUIRED",
          "error",
          path,
          `${label} is required. It must be the real date — this library never invents dates.`,
        ),
      );
    }
    return undefined;
  }
  if (!isValidIsoDate(value)) {
    gen.issues.push(
      issue(
        "INVALID_DATE",
        "error",
        path,
        `${label} ("${value}") is not a valid ISO 8601 date (expected YYYY-MM-DD or full ISO date-time).`,
      ),
    );
    return undefined;
  }
  return value;
}

export function checkDurationField(
  gen: Gen,
  path: string,
  label: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!isValidIsoDuration(value)) {
    gen.issues.push(
      issue(
        "INVALID_DURATION",
        "error",
        path,
        `${label} ("${value}") is not a valid ISO 8601 duration (e.g. "PT2M12S").`,
      ),
    );
    return undefined;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Shared node builders                                                */
/* ------------------------------------------------------------------ */

export function buildPostalAddress(
  gen: Gen,
  path: string,
  address: PostalAddressInput,
): JsonLdObject {
  const node: JsonLdObject = { "@type": "PostalAddress" };
  if (required(gen, p(path, "streetAddress"), "Street address", address.streetAddress)) {
    node.streetAddress = address.streetAddress;
    // Address rendering varies (abbreviations, line breaks) — warning severity.
    claim(gen, p(path, "streetAddress"), "Street address", address.streetAddress, "text", "warning");
  }
  if (required(gen, p(path, "addressLocality"), "Address locality (city)", address.addressLocality)) {
    node.addressLocality = address.addressLocality;
    claim(gen, p(path, "addressLocality"), "Address locality", address.addressLocality, "text", "warning");
  }
  setIf(node, "addressRegion", address.addressRegion);
  setIf(node, "postalCode", address.postalCode);
  if (required(gen, p(path, "addressCountry"), "Address country", address.addressCountry)) {
    node.addressCountry = address.addressCountry;
  }
  return node;
}

export function buildGeo(gen: Gen, path: string, geo: GeoCoordinatesInput): JsonLdObject | undefined {
  if (!isValidLatitude(geo.latitude) || !isValidLongitude(geo.longitude)) {
    gen.issues.push(
      issue(
        "INVALID_GEO",
        "error",
        path,
        `Geo coordinates (${geo.latitude}, ${geo.longitude}) are out of range.`,
      ),
    );
    return undefined;
  }
  return { "@type": "GeoCoordinates", latitude: geo.latitude, longitude: geo.longitude };
}

export function buildOpeningHours(
  gen: Gen,
  path: string,
  specs: OpeningHoursInput[],
): JsonLdObject[] {
  return specs.map((spec, i) => {
    const node: JsonLdObject = { "@type": "OpeningHoursSpecification" };
    const specPath = `${path}[${i}]`;
    if (spec.dayOfWeek.length === 0) {
      gen.issues.push(
        issue("MISSING_REQUIRED", "error", p(specPath, "dayOfWeek"), "dayOfWeek must not be empty."),
      );
    }
    for (const day of spec.dayOfWeek) {
      if (!(DAYS_OF_WEEK as readonly string[]).includes(day)) {
        gen.issues.push(
          issue(
            "INVALID_DAY_OF_WEEK",
            "error",
            p(specPath, "dayOfWeek"),
            `"${day}" is not a valid day of week.`,
          ),
        );
      }
    }
    node.dayOfWeek = [...spec.dayOfWeek];
    for (const [key, time] of [
      ["opens", spec.opens],
      ["closes", spec.closes],
    ] as const) {
      if (!isValidTime(time)) {
        gen.issues.push(
          issue(
            "INVALID_TIME",
            "error",
            p(specPath, key),
            `${key} ("${time}") must be "HH:MM" 24-hour time.`,
          ),
        );
      } else {
        node[key] = time;
      }
    }
    return node;
  });
}

export function buildOffer(gen: Gen, path: string, offer: OfferInput): JsonLdObject {
  const node: JsonLdObject = { "@type": "Offer" };

  if (offer.price === undefined || offer.price === null) {
    gen.issues.push(issue("MISSING_REQUIRED", "error", p(path, "price"), "Offer price is required."));
  } else {
    const price = canonicalPrice(offer.price);
    if (price === undefined) {
      gen.issues.push(
        issue(
          "INVALID_PRICE",
          "error",
          p(path, "price"),
          `Offer price ("${String(offer.price)}") must be a plain non-negative decimal with at most 2 fraction digits.`,
        ),
      );
    } else {
      node.price = price;
      // Prices in structured data must be the prices shown on the page.
      claim(gen, p(path, "price"), "Offer price", price, "price", "error");
    }
  }

  if (required(gen, p(path, "priceCurrency"), "Offer priceCurrency", offer.priceCurrency)) {
    if (!isValidCurrency(offer.priceCurrency)) {
      gen.issues.push(
        issue(
          "INVALID_CURRENCY",
          "error",
          p(path, "priceCurrency"),
          `priceCurrency ("${offer.priceCurrency}") must be a 3-letter ISO 4217 code.`,
        ),
      );
    } else {
      node.priceCurrency = offer.priceCurrency;
    }
  }

  if (offer.availability !== undefined) {
    node.availability = `https://schema.org/${offer.availability}`;
  }
  setIf(node, "url", checkUrlField(gen, p(path, "url"), "Offer URL", offer.url));
  setIf(
    node,
    "priceValidUntil",
    checkDateField(gen, p(path, "priceValidUntil"), "priceValidUntil", offer.priceValidUntil),
  );
  return node;
}

export function buildAggregateRating(
  gen: Gen,
  path: string,
  rating: AggregateRatingValueInput,
  opts: { requireCount?: boolean } = {},
): JsonLdObject {
  const node: JsonLdObject = { "@type": "AggregateRating" };
  const { worst, best } = ratingBounds(rating.worstRating, rating.bestRating);

  if (!isRatingInRange(rating.ratingValue, rating.worstRating, rating.bestRating)) {
    gen.issues.push(
      issue(
        "RATING_OUT_OF_RANGE",
        "error",
        p(path, "ratingValue"),
        `ratingValue (${rating.ratingValue}) must be between ${worst} and ${best}.`,
      ),
    );
  } else {
    node.ratingValue = rating.ratingValue;
    // A displayed aggregate score MUST be visible where it is claimed — a
    // fabricated star rating inflates social proof (FTC / manual-action risk,
    // doc 05 M10), so this is an error-severity claim that BLOCKS emission on
    // mismatch (frozen-skill tightening 2026-07-09, Orchestrator-authorized;
    // was "warning" before).
    claim(gen, p(path, "ratingValue"), "Aggregate rating value", String(rating.ratingValue), "number", "error");
  }
  node.bestRating = best;
  node.worstRating = worst;

  for (const [key, count] of [
    ["reviewCount", rating.reviewCount],
    ["ratingCount", rating.ratingCount],
  ] as const) {
    if (count === undefined) continue;
    if (!isPositiveInt(count)) {
      gen.issues.push(
        issue("INVALID_COUNT", "error", p(path, key), `${key} (${count}) must be a positive integer.`),
      );
    } else {
      node[key] = count;
      // A displayed review/rating count MUST appear on the page — a fabricated
      // count inflates social proof (FTC / manual-action risk, doc 05 M10), so
      // it is an error-severity, digit-matched claim (frozen-skill tightening
      // 2026-07-09, Orchestrator-authorized; was unregistered — never matched —
      // before). numberBoundaryRegex tolerates thousands separators, so "5123"
      // matches a page rendering "5,123".
      claim(
        gen,
        p(path, key),
        key === "reviewCount" ? "Aggregate review count" : "Aggregate rating count",
        String(count),
        "number",
        "error",
      );
    }
  }

  if (opts.requireCount && rating.reviewCount === undefined && rating.ratingCount === undefined) {
    gen.issues.push(
      issue(
        "MISSING_REQUIRED",
        "error",
        path,
        "AggregateRating requires reviewCount or ratingCount.",
      ),
    );
  }
  return node;
}

export function buildReview(gen: Gen, path: string, review: ReviewValueInput): JsonLdObject {
  const node: JsonLdObject = { "@type": "Review" };
  if (required(gen, p(path, "author"), "Review author", review.author)) {
    node.author = { "@type": "Person", name: review.author };
    claim(gen, p(path, "author.name"), "Review author", review.author, "text", "warning");
  }
  if (required(gen, p(path, "reviewBody"), "Review body", review.reviewBody)) {
    node.reviewBody = review.reviewBody;
    claim(gen, p(path, "reviewBody"), "Review body", review.reviewBody, "text", "error");
  }
  // NOTE (frozen-skill tightening 2026-07-09): unlike the AGGREGATE rating value
  // + counts (buildAggregateRating, now error-gated), an INDIVIDUAL review's star
  // rating is deliberately NOT registered as a visible-text claim. The review
  // BODY above is already error-gated, which closes the fabrication surface (a
  // review whose text is not on the page already rejects); and a single review's
  // rating renders as star glyphs/words ("★★★★★", "five stars") far more often
  // than as a digit, so digit-matching it would systematically false-reject
  // legitimate review markup. The FTC / social-proof exposure lives in the
  // AGGREGATE, which is now fully error-gated. (Scope flagged to Code Review +
  // Compliance for ratification.)
  const { worst, best } = ratingBounds(review.worstRating, review.bestRating);
  if (!isRatingInRange(review.ratingValue, review.worstRating, review.bestRating)) {
    gen.issues.push(
      issue(
        "RATING_OUT_OF_RANGE",
        "error",
        p(path, "reviewRating.ratingValue"),
        `ratingValue (${review.ratingValue}) must be between ${worst} and ${best}.`,
      ),
    );
  } else {
    node.reviewRating = {
      "@type": "Rating",
      ratingValue: review.ratingValue,
      bestRating: best,
      worstRating: worst,
    };
  }
  setIf(
    node,
    "datePublished",
    checkDateField(gen, p(path, "datePublished"), "Review datePublished", review.datePublished),
  );
  return node;
}
