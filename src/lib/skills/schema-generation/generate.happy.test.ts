/**
 * Happy path per schema type, with realistic fixtures from the five seed
 * verticals (doc 02). Every test asserts: status "ready", correct @type,
 * all claims matched to visible text, and a well-formed script block.
 */

import { describe, expect, it } from "vitest";
import { generateSchema } from "./generate";
import type {
  ArticleInput,
  BreadcrumbListInput,
  EventInput,
  JsonLdObject,
  OrganizationInput,
  PodcastEpisodeInput,
  PodcastSeriesInput,
  RealEstateAgentInput,
  ReviewInput,
  AggregateRatingInput,
  SchemaGenerationReady,
  SchemaGenerationResult,
  ServiceInput,
} from "./types";
import {
  advisorEntity,
  advisorPageText,
  bestOfListEntity,
  bestOfListPageText,
  buyerFaqEntity,
  buyerFaqPageText,
  dispensaryEntity,
  dispensaryPageText,
  dispensaryProductEntity,
  dispensaryProductPageText,
  ecomProductEntity,
  ecomProductPageText,
  faqVideoEntity,
  faqVideoPageText,
  insuranceAgencyEntity,
  insuranceAgencyPageText,
  insuranceAgentEntity,
  insuranceAgentPageText,
  restaurantEntity,
  restaurantPageText,
} from "./fixtures";

function expectReady(result: SchemaGenerationResult): SchemaGenerationReady {
  if (result.status !== "ready") {
    throw new Error(
      `expected ready, got rejected:\n${result.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join("\n")}`,
    );
  }
  // Full correspondence: every encoded claim maps to visible text.
  expect(result.correspondence.length).toBeGreaterThan(0);
  expect(result.correspondence.every((entry) => entry.matched)).toBe(true);
  // Script block shape.
  expect(result.scriptBlock.startsWith('<script type="application/ld+json">\n')).toBe(true);
  expect(result.scriptBlock.endsWith("\n</script>")).toBe(true);
  return result;
}

/** Parses the JSON body back out of the script block. */
function parseBlock(scriptBlock: string): JsonLdObject {
  const body = scriptBlock.split("\n").slice(1, -1).join("\n");
  return JSON.parse(body) as JsonLdObject;
}

describe("cannabis (doc 02 §2.1)", () => {
  it("generates a Store for a dispensary", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Store",
        entity: dispensaryEntity,
        visiblePageText: dispensaryPageText,
      }),
    );
    expect(result.jsonLd["@context"]).toBe("https://schema.org");
    expect(result.jsonLd["@type"]).toBe("Store");
    expect(result.jsonLd.name).toBe("Urban Leaf Dispensary");
    expect((result.jsonLd.address as JsonLdObject).addressLocality).toBe("San Diego");
    expect(result.jsonLd.openingHoursSpecification).toHaveLength(1);
    expect(parseBlock(result.scriptBlock)).toEqual(result.jsonLd);
    // Correspondence report names the visible element each claim maps to.
    const nameEntry = result.correspondence.find((entry) => entry.path === "name");
    expect(nameEntry?.label).toBe("Business name");
    expect(nameEntry?.evidence).toContain("urban leaf dispensary");
  });

  it("generates the same entity as a generic LocalBusiness", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "LocalBusiness",
        entity: dispensaryEntity,
        visiblePageText: dispensaryPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("LocalBusiness");
  });

  it("generates Product+Offer for a menu item with the price shown on the page", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Product",
        entity: dispensaryProductEntity,
        visiblePageText: dispensaryProductPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("Product");
    const offers = result.jsonLd.offers as JsonLdObject;
    expect(offers.price).toBe("24.99");
    expect(offers.priceCurrency).toBe("USD");
    expect(offers.availability).toBe("https://schema.org/InStock");
  });
});

describe("real estate (doc 02 §2.2)", () => {
  it("generates Person with fully aggregated, deduped, order-stable sameAs", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Person",
        entity: advisorEntity,
        visiblePageText: advisorPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("Person");
    expect(result.jsonLd.sameAs).toEqual([
      "https://www.forbes.com/profile/daniel-reyes/",
      "https://gulfnews.com/business/property/dubai-luxury-market-daniel-reyes-1.9921",
      "https://www.arabianbusiness.com/author/daniel-reyes",
      "https://www.linkedin.com/in/daniel-reyes-dubai",
      "https://www.youtube.com/@ReyesPrivateClients",
      "https://podcasts.apple.com/ae/podcast/the-dubai-property-podcast/id1755500042",
      "https://www.dubailand.gov.ae/en/eservices/broker/48812",
    ]);
  });

  it("generates FAQPage with every question and answer on the page", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "FAQPage",
        entity: buyerFaqEntity,
        visiblePageText: buyerFaqPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("FAQPage");
    const questions = result.jsonLd.mainEntity as JsonLdObject[];
    expect(questions).toHaveLength(3);
    expect(questions[0]["@type"]).toBe("Question");
    expect((questions[0].acceptedAnswer as JsonLdObject)["@type"]).toBe("Answer");
    // 3 questions + 3 answers all verified.
    expect(result.correspondence).toHaveLength(6);
  });

  it("generates VideoObject for a FAQ video page with on-page transcript", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "VideoObject",
        entity: faqVideoEntity,
        visiblePageText: faqVideoPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("VideoObject");
    expect(result.jsonLd.uploadDate).toBe("2026-05-14");
    expect(result.jsonLd.duration).toBe("PT2M12S");
  });

  it("generates RealEstateAgent with the advisor nested as employee Person", () => {
    const agency: RealEstateAgentInput = {
      name: "Reyes Private Clients",
      url: "https://reyesprivateclients.example.com",
      telephone: "+971-4-555-0182",
      areaServed: ["Dubai", "Abu Dhabi"],
      agent: advisorEntity,
    };
    const pageText = `${advisorPageText}\nReyes Private Clients · Call +971 4 555 0182 · Serving Dubai and Abu Dhabi.`;
    const result = expectReady(
      generateSchema({ schemaType: "RealEstateAgent", entity: agency, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("RealEstateAgent");
    const employee = result.jsonLd.employee as JsonLdObject;
    expect(employee["@type"]).toBe("Person");
    expect(employee.name).toBe("Daniel Reyes");
    expect(Array.isArray(employee.sameAs)).toBe(true);
    // Address is only recommended for the semi-local vertical.
    expect(result.warnings.some((w) => w.code === "MISSING_RECOMMENDED" && w.path === "address")).toBe(
      true,
    );
  });

  it("generates PodcastSeries and PodcastEpisode", () => {
    const series: PodcastSeriesInput = {
      name: "The Dubai Property Podcast",
      url: "https://reyesprivateclients.example.com/podcast",
      description:
        "Weekly conversations on Dubai real estate, golden visas, and investing from abroad.",
      webFeed: "https://feeds.example.com/dubai-property.rss",
      authorName: "Daniel Reyes",
    };
    const seriesPage = `The Dubai Property Podcast — Weekly conversations on Dubai real estate, golden visas, and investing from abroad. Hosted by Daniel Reyes.`;
    const seriesResult = expectReady(
      generateSchema({ schemaType: "PodcastSeries", entity: series, visiblePageText: seriesPage }),
    );
    expect(seriesResult.jsonLd["@type"]).toBe("PodcastSeries");

    const episode: PodcastEpisodeInput = {
      name: "Golden Visa Rules Explained",
      url: "https://reyesprivateclients.example.com/podcast/ep-42",
      seriesName: "The Dubai Property Podcast",
      seriesUrl: "https://reyesprivateclients.example.com/podcast",
      episodeNumber: 42,
      datePublished: "2026-06-10",
      duration: "PT38M",
      audioUrl: "https://media.example.com/dubai-property/ep42.mp3",
    };
    const episodePage = `Episode 42 — Golden Visa Rules Explained — The Dubai Property Podcast, June 2026.`;
    const episodeResult = expectReady(
      generateSchema({ schemaType: "PodcastEpisode", entity: episode, visiblePageText: episodePage }),
    );
    expect(episodeResult.jsonLd["@type"]).toBe("PodcastEpisode");
    expect(episodeResult.jsonLd.episodeNumber).toBe(42);
    expect((episodeResult.jsonLd.partOfSeries as JsonLdObject).name).toBe(
      "The Dubai Property Podcast",
    );
  });

  it("generates Article with publisher defaulted from the brand context", () => {
    const article: ArticleInput = {
      headline: "How Foreign Nationals Buy Property in Dubai: The Complete 2026 Guide",
      authorName: "Daniel Reyes",
      datePublished: "2026-04-02",
      dateModified: "2026-06-20",
      description:
        "Everything foreign buyers need to know about Dubai freehold zones, fees, and financing.",
      url: "https://reyesprivateclients.example.com/guides/foreign-buyers",
    };
    const pageText = `
How Foreign Nationals Buy Property in Dubai: The Complete 2026 Guide
By Daniel Reyes · Updated June 2026
Everything foreign buyers need to know about Dubai freehold zones, fees, and financing.
`;
    const result = expectReady(
      generateSchema({
        schemaType: "Article",
        entity: article,
        visiblePageText: pageText,
        brand: {
          organizationName: "Reyes Private Clients",
          logoUrl: "https://reyesprivateclients.example.com/logo.png",
        },
      }),
    );
    expect(result.jsonLd["@type"]).toBe("Article");
    const publisher = result.jsonLd.publisher as JsonLdObject;
    expect(publisher.name).toBe("Reyes Private Clients");
    expect((publisher.logo as JsonLdObject).url).toBe(
      "https://reyesprivateclients.example.com/logo.png",
    );
    expect(result.jsonLd.datePublished).toBe("2026-04-02");
    expect(result.jsonLd.dateModified).toBe("2026-06-20");
  });
});

describe("restaurants (doc 02 §2.3)", () => {
  it("generates Restaurant + Menu + MenuItem with prices matching the page", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Restaurant",
        entity: restaurantEntity,
        visiblePageText: restaurantPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("Restaurant");
    const menu = result.jsonLd.hasMenu as JsonLdObject;
    const sections = menu.hasMenuSection as JsonLdObject[];
    expect(sections).toHaveLength(2);
    const tacos = sections[0].hasMenuItem as JsonLdObject[];
    expect(tacos[0].name).toBe("Baja Fish Taco");
    expect((tacos[0].offers as JsonLdObject).price).toBe("6.5");
    const brunch = sections[1].hasMenuItem as JsonLdObject[];
    expect(brunch[0].suitableForDiet).toEqual(["https://schema.org/VegetarianDiet"]);
    expect((result.jsonLd.aggregateRating as JsonLdObject).ratingValue).toBe(4.7);
  });

  it("generates an Event at the restaurant", () => {
    const event: EventInput = {
      name: "Taco Tuesday Live Music Night",
      startDate: "2026-08-11T19:00:00-07:00",
      endDate: "2026-08-11T22:00:00-07:00",
      eventAttendanceMode: "Offline",
      eventStatus: "Scheduled",
      location: { name: "Casa Verde Cocina", address: restaurantEntity.address },
      organizerName: "Casa Verde Cocina",
      offer: { price: 10, priceCurrency: "USD", availability: "InStock" },
    };
    const pageText = `
Taco Tuesday Live Music Night at Casa Verde Cocina — 3115 University Ave, San Diego.
Tickets $10 at the door. Doors at 7 PM, live music until 10 PM.
`;
    const result = expectReady(
      generateSchema({ schemaType: "Event", entity: event, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("Event");
    expect(result.jsonLd.eventStatus).toBe("https://schema.org/EventScheduled");
    expect((result.jsonLd.location as JsonLdObject)["@type"]).toBe("Place");
    expect((result.jsonLd.offers as JsonLdObject).price).toBe("10");
  });

  it("generates a standalone Review of the restaurant", () => {
    const review: ReviewInput = {
      itemReviewed: {
        type: "Restaurant",
        name: "Casa Verde Cocina",
        url: "https://casaverdecocina.example.com",
      },
      author: "Elena M.",
      reviewBody: "The carnitas taco is the best in North Park, and the salsa verde is unreal.",
      ratingValue: 5,
      datePublished: "2026-06-28",
    };
    const pageText = `
"The carnitas taco is the best in North Park, and the salsa verde is unreal."
— Elena M., five stars, June 2026. Casa Verde Cocina.
`;
    const result = expectReady(
      generateSchema({ schemaType: "Review", entity: review, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("Review");
    expect((result.jsonLd.reviewRating as JsonLdObject).ratingValue).toBe(5);
    expect((result.jsonLd.itemReviewed as JsonLdObject)["@type"]).toBe("Restaurant");
  });
});

describe("health & life insurance (doc 02 §2.4)", () => {
  it("generates InsuranceAgency", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "InsuranceAgency",
        entity: insuranceAgencyEntity,
        visiblePageText: insuranceAgencyPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("InsuranceAgency");
    expect(result.jsonLd.name).toBe("Summit Life & Health");
    expect(result.jsonLd.url).toBe("https://summitlifehealth.example.com");
  });

  it("generates a licensed-agent Person with credential-registry sameAs", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Person",
        entity: insuranceAgentEntity,
        visiblePageText: insuranceAgentPageText,
      }),
    );
    expect(result.jsonLd.sameAs).toEqual([
      "https://www.linkedin.com/in/maria-delgado-insurance",
      "https://nipr.com/help/look-up-your-npn?npn=18834412",
    ]);
    expect((result.jsonLd.worksFor as JsonLdObject).name).toBe("Summit Life & Health");
  });

  it("generates a Service for an insurance product line", () => {
    const service: ServiceInput = {
      name: "Final Expense Life Insurance",
      serviceType: "Life insurance",
      providerName: "Summit Life & Health",
      areaServed: ["Arizona"],
      description:
        "Whole life coverage designed to pay funeral and end-of-life costs, with no medical exam required.",
      url: "https://summitlifehealth.example.com/final-expense",
    };
    const pageText = `
Final Expense Life Insurance from Summit Life & Health.
Whole life coverage designed to pay funeral and end-of-life costs, with no medical
exam required. Available across Arizona.
`;
    const result = expectReady(
      generateSchema({ schemaType: "Service", entity: service, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("Service");
    expect((result.jsonLd.provider as JsonLdObject).name).toBe("Summit Life & Health");
  });
});

describe("e-commerce (doc 02 §2.5)", () => {
  it("generates Product + Offer + AggregateRating + Review with brand-context brand", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "Product",
        entity: ecomProductEntity,
        visiblePageText: ecomProductPageText,
        brand: { organizationName: "Northpeak", websiteUrl: "https://northpeak.example.com" },
      }),
    );
    expect(result.jsonLd["@type"]).toBe("Product");
    expect((result.jsonLd.brand as JsonLdObject).name).toBe("Northpeak");
    expect((result.jsonLd.offers as JsonLdObject).price).toBe("129.99");
    const rating = result.jsonLd.aggregateRating as JsonLdObject;
    expect(rating.ratingValue).toBe(4.8);
    expect(rating.reviewCount).toBe(324);
    const reviews = result.jsonLd.review as JsonLdObject[];
    expect(reviews).toHaveLength(1);
    expect((reviews[0].author as JsonLdObject).name).toBe("Jordan P.");
  });

  it("generates an ItemList for a best-of buying guide", () => {
    const result = expectReady(
      generateSchema({
        schemaType: "ItemList",
        entity: bestOfListEntity,
        visiblePageText: bestOfListPageText,
      }),
    );
    expect(result.jsonLd["@type"]).toBe("ItemList");
    expect(result.jsonLd.itemListOrder).toBe("https://schema.org/ItemListOrderDescending");
    const items = result.jsonLd.itemListElement as JsonLdObject[];
    expect(items).toHaveLength(3);
    expect(items[0].position).toBe(1);
    expect(items[2].name).toBe("Creststone GTX");
  });

  it("generates BreadcrumbList allowing the final crumb to omit its URL", () => {
    const breadcrumbs: BreadcrumbListInput = {
      items: [
        { name: "Home", url: "https://northpeak.example.com" },
        { name: "Running Shoes", url: "https://northpeak.example.com/shoes" },
        { name: "Trail" },
      ],
    };
    const pageText = "Home / Running Shoes / Trail\nAtlas Trail Runner 2 product details.";
    const result = expectReady(
      generateSchema({ schemaType: "BreadcrumbList", entity: breadcrumbs, visiblePageText: pageText }),
    );
    const items = result.jsonLd.itemListElement as JsonLdObject[];
    expect(items).toHaveLength(3);
    expect(items[0].item).toBe("https://northpeak.example.com");
    expect(items[2].item).toBeUndefined();
  });

  it("generates a plain Organization with contact point", () => {
    const org: OrganizationInput = {
      name: "Northpeak",
      url: "https://northpeak.example.com",
      logo: "https://northpeak.example.com/logo.svg",
      sameAs: ["https://www.instagram.com/northpeakgear"],
      contactPoint: { telephone: "(800) 555-0122", contactType: "customer service" },
    };
    const pageText =
      "Northpeak — trail running gear built in the Rockies. Customer service: (800) 555-0122.";
    const result = expectReady(
      generateSchema({ schemaType: "Organization", entity: org, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("Organization");
    expect((result.jsonLd.contactPoint as JsonLdObject).telephone).toBe("(800) 555-0122");
  });

  it("generates a standalone AggregateRating referencing the rated business", () => {
    const rating: AggregateRatingInput = {
      itemReviewed: { type: "LocalBusiness", name: "Urban Leaf Dispensary" },
      ratingValue: 4.6,
      reviewCount: 891,
    };
    const pageText = "Urban Leaf Dispensary is rated 4.6 stars from 891 verified reviews.";
    const result = expectReady(
      generateSchema({ schemaType: "AggregateRating", entity: rating, visiblePageText: pageText }),
    );
    expect(result.jsonLd["@type"]).toBe("AggregateRating");
    expect(result.jsonLd.ratingValue).toBe(4.6);
    expect((result.jsonLd.itemReviewed as JsonLdObject).name).toBe("Urban Leaf Dispensary");
  });
});
