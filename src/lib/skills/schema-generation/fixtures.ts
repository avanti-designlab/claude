/**
 * Realistic test fixtures from the five seed verticals (doc 02).
 * Shared by the colocated *.test.ts files — test input only, not shipped API.
 *
 * Every error-severity claim in a "happy" fixture genuinely appears in its
 * page text; reject tests derive mismatches from these.
 */

import type {
  FaqPageInput,
  ItemListInput,
  LocalBusinessInput,
  OrganizationInput,
  PersonInput,
  ProductInput,
  RestaurantInput,
  VideoObjectInput,
} from "./types";

/* ------------------------------------------------------------------ */
/* 2.1 CANNABIS — hyper-local (Store, Product)                          */
/* ------------------------------------------------------------------ */

export const dispensaryEntity: LocalBusinessInput = {
  name: "Urban Leaf Dispensary",
  description:
    "San Diego's trusted cannabis dispensary for premium flower, edibles, and concentrates.",
  url: "https://urbanleafsd.example.com",
  telephone: "+1-619-555-0143",
  address: {
    streetAddress: "1028 Buenos Ave",
    addressLocality: "San Diego",
    addressRegion: "CA",
    postalCode: "92110",
    addressCountry: "US",
  },
  geo: { latitude: 32.7554, longitude: -117.2005 },
  openingHours: [
    {
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      opens: "09:00",
      closes: "21:00",
    },
  ],
  priceRange: "$$",
  sameAs: [
    "https://weedmaps.com/dispensaries/urban-leaf-sd",
    "https://www.leafly.com/dispensary-info/urban-leaf-sd",
  ],
};

export const dispensaryPageText = `
Urban Leaf Dispensary
San Diego's trusted cannabis dispensary for premium flower, edibles, and concentrates.
Visit us at 1028 Buenos Ave, San Diego, CA 92110 — call (619) 555-0143.
Open Monday through Saturday, 9:00 AM to 9:00 PM. Must be 21+ with valid ID.
`;

export const dispensaryProductEntity: ProductInput = {
  name: "Blue Dream 3.5g Flower",
  description:
    "A balanced sativa-dominant hybrid with sweet berry aroma, dominant in myrcene and pinene.",
  brandName: "Urban Leaf",
  sku: "UL-BD-35",
  url: "https://urbanleafsd.example.com/menu/blue-dream-35g",
  offer: {
    price: 24.99,
    priceCurrency: "USD",
    availability: "InStock",
  },
};

export const dispensaryProductPageText = `
Urban Leaf — Blue Dream 3.5g Flower — $24.99
A balanced sativa-dominant hybrid with sweet berry aroma, dominant in myrcene and pinene.
Effects reported: relaxed, creative, uplifted. In stock for pickup and delivery.
`;

/* ------------------------------------------------------------------ */
/* 2.2 REAL ESTATE — semi-local (Person+sameAs, FAQPage, VideoObject)   */
/* ------------------------------------------------------------------ */

export const advisorEntity: PersonInput = {
  name: "Daniel Reyes",
  jobTitle: "Dubai luxury real estate advisor",
  description:
    "Advises international investors and families relocating to Dubai on freehold property, golden visas, and portfolio strategy.",
  url: "https://reyesprivateclients.example.com/about",
  sameAsSources: {
    pressArticles: [
      "https://www.forbes.com/profile/daniel-reyes/",
      "https://forbes.com/profile/daniel-reyes", // duplicate of the above (www + trailing slash)
      "https://gulfnews.com/business/property/dubai-luxury-market-daniel-reyes-1.9921",
    ],
    bylines: ["https://www.arabianbusiness.com/author/daniel-reyes"],
    linkedin: ["https://www.linkedin.com/in/daniel-reyes-dubai"],
    youtube: ["https://www.youtube.com/@ReyesPrivateClients"],
    podcast: ["https://podcasts.apple.com/ae/podcast/the-dubai-property-podcast/id1755500042"],
    credentialRegistries: ["https://www.dubailand.gov.ae/en/eservices/broker/48812"],
  },
  knowsAbout: ["Dubai freehold property", "UAE golden visa", "Off-plan investment"],
};

export const advisorPageText = `
Daniel Reyes is a Dubai luxury real estate advisor. He advises international investors
and families relocating to Dubai on freehold property, golden visas, and portfolio strategy.
As featured in Forbes, Gulf News, and Arabian Business. RERA broker no. 48812.
`;

export const buyerFaqEntity: FaqPageInput = {
  url: "https://reyesprivateclients.example.com/faq/foreign-buyers",
  faqs: [
    {
      question: "Can foreigners buy property in Dubai?",
      answer:
        "Yes. Foreign nationals can buy freehold property in designated zones such as Dubai Marina, Downtown Dubai, and Palm Jumeirah, with full ownership rights.",
    },
    {
      question: "Do foreigners pay property taxes in Dubai?",
      answer:
        "Dubai levies no annual property tax; buyers pay a one-time 4% Dubai Land Department transfer fee at purchase.",
    },
    {
      question: "Can foreigners get a mortgage in Dubai?",
      answer:
        "Yes, non-resident buyers can typically finance up to 50% of the purchase price through UAE banks, while residents can reach 80%.",
    },
  ],
};

export const buyerFaqPageText = `
Buying property in Dubai as a foreign national — your questions answered by Daniel Reyes.

Can foreigners buy property in Dubai?
Yes. Foreign nationals can buy freehold property in designated zones such as Dubai Marina,
Downtown Dubai, and Palm Jumeirah, with full ownership rights.

Do foreigners pay property taxes in Dubai?
Dubai levies no annual property tax; buyers pay a one-time 4% Dubai Land Department
transfer fee at purchase.

Can foreigners get a mortgage in Dubai?
Yes, non-resident buyers can typically finance up to 50% of the purchase price through
UAE banks, while residents can reach 80%.
`;

export const faqVideoEntity: VideoObjectInput = {
  name: "Can foreigners buy property in Dubai? — Explained",
  description:
    "Daniel Reyes explains Dubai's freehold zones, ownership rights, and the buying process for foreign nationals.",
  thumbnailUrl: ["https://reyesprivateclients.example.com/media/faq-foreign-buyers-thumb.jpg"],
  uploadDate: "2026-05-14",
  duration: "PT2M12S",
  contentUrl: "https://reyesprivateclients.example.com/media/faq-foreign-buyers.mp4",
  transcript:
    "One of the questions I hear most often is whether foreigners can really own property in Dubai. The answer is yes.",
};

export const faqVideoPageText = `
Can foreigners buy property in Dubai? — Explained
Daniel Reyes explains Dubai's freehold zones, ownership rights, and the buying process
for foreign nationals.
Transcript: One of the questions I hear most often is whether foreigners can really own
property in Dubai. The answer is yes.
`;

/* ------------------------------------------------------------------ */
/* 2.3 RESTAURANTS — hyper-local (Restaurant + Menu + MenuItem)         */
/* ------------------------------------------------------------------ */

export const restaurantEntity: RestaurantInput = {
  name: "Casa Verde Cocina",
  description: "Neighborhood Mexican kitchen in North Park serving handmade tortillas daily.",
  url: "https://casaverdecocina.example.com",
  telephone: "(619) 555-0126",
  address: {
    streetAddress: "3115 University Ave",
    addressLocality: "San Diego",
    addressRegion: "CA",
    postalCode: "92104",
    addressCountry: "US",
  },
  servesCuisine: ["Mexican"],
  acceptsReservations: true,
  menu: {
    url: "https://casaverdecocina.example.com/menu",
    sections: [
      {
        name: "Tacos",
        items: [
          { name: "Baja Fish Taco", price: 6.5, priceCurrency: "USD" },
          {
            name: "Carnitas Taco",
            description: "Slow-braised pork, salsa verde, onion, cilantro.",
            price: 5.95,
            priceCurrency: "USD",
          },
        ],
      },
      {
        name: "Brunch",
        items: [
          {
            name: "Chilaquiles Verdes",
            price: 14,
            priceCurrency: "USD",
            suitableForDiet: ["Vegetarian"],
          },
        ],
      },
    ],
  },
  aggregateRating: { ratingValue: 4.7, reviewCount: 212 },
};

export const restaurantPageText = `
Casa Verde Cocina — Neighborhood Mexican kitchen in North Park serving handmade
tortillas daily. 3115 University Ave, San Diego, CA 92104 · (619) 555-0126
Rated 4.7 out of 5 by 212 diners.

Menu

Tacos
Baja Fish Taco — $6.50
Carnitas Taco — Slow-braised pork, salsa verde, onion, cilantro. $5.95

Brunch
Chilaquiles Verdes (vegetarian) — $14
`;

/* ------------------------------------------------------------------ */
/* 2.4 HEALTH & LIFE INSURANCE — semi-local (InsuranceAgency, Service)   */
/* ------------------------------------------------------------------ */

export const insuranceAgencyEntity: OrganizationInput = {
  name: "Summit Life & Health",
  url: "https://summitlifehealth.example.com",
  logo: "https://summitlifehealth.example.com/logo.png",
  description:
    "Independent life and health insurance agency helping families across Arizona compare final expense, term life, and Medicare supplement coverage.",
  telephone: "(480) 555-0177",
  address: {
    streetAddress: "2201 E Camelback Rd, Suite 410",
    addressLocality: "Phoenix",
    addressRegion: "AZ",
    postalCode: "85016",
    addressCountry: "US",
  },
  sameAs: [
    "https://www.trustpilot.com/review/summitlifehealth.example.com",
    "https://www.bbb.org/us/az/phoenix/profile/insurance-agency/summit-life-health",
  ],
};

export const insuranceAgencyPageText = `
Summit Life & Health — Independent life and health insurance agency helping families
across Arizona compare final expense, term life, and Medicare supplement coverage.
2201 E Camelback Rd, Suite 410, Phoenix, AZ 85016 · (480) 555-0177
Licensed in Arizona. Reviews on Trustpilot and BBB.
`;

export const insuranceAgentEntity: PersonInput = {
  name: "Maria Delgado",
  jobTitle: "Licensed life insurance agent",
  url: "https://summitlifehealth.example.com/agents/maria-delgado",
  worksFor: { name: "Summit Life & Health", url: "https://summitlifehealth.example.com" },
  sameAsSources: {
    linkedin: ["https://www.linkedin.com/in/maria-delgado-insurance"],
    credentialRegistries: ["https://nipr.com/help/look-up-your-npn?npn=18834412"],
  },
};

export const insuranceAgentPageText = `
Maria Delgado is a licensed life insurance agent with Summit Life & Health.
NPN 18834412 — verify her license through the national producer registry.
She helps Arizona seniors compare final expense and term life policies.
`;

/* ------------------------------------------------------------------ */
/* 2.5 E-COMMERCE — national (Product+Offer+AggregateRating+Review,     */
/*     ItemList, BreadcrumbList)                                       */
/* ------------------------------------------------------------------ */

export const ecomProductEntity: ProductInput = {
  name: "Atlas Trail Runner 2",
  description:
    "A cushioned trail running shoe with a Vibram outsole, 6mm drop, and a roomy toe box built for technical terrain.",
  sku: "NP-ATR2-M10",
  url: "https://northpeak.example.com/shoes/atlas-trail-runner-2",
  image: ["https://northpeak.example.com/img/atr2-hero.jpg"],
  offer: {
    price: 129.99,
    priceCurrency: "USD",
    availability: "InStock",
    url: "https://northpeak.example.com/shoes/atlas-trail-runner-2",
  },
  aggregateRating: { ratingValue: 4.8, reviewCount: 324 },
  reviews: [
    {
      author: "Jordan P.",
      reviewBody:
        "These shoes handled 300 miles of rocky singletrack without falling apart.",
      ratingValue: 5,
      datePublished: "2026-05-30",
    },
  ],
};

export const ecomProductPageText = `
Northpeak Atlas Trail Runner 2 — $129.99 — In stock.
A cushioned trail running shoe with a Vibram outsole, 6mm drop, and a roomy toe box
built for technical terrain.
Rated 4.8 out of 5 (324 reviews).
"These shoes handled 300 miles of rocky singletrack without falling apart." — Jordan P.
`;

export const bestOfListEntity: ItemListInput = {
  name: "Best Trail Running Shoes Under $150",
  itemListOrder: "Descending",
  items: [
    {
      name: "Atlas Trail Runner 2",
      url: "https://northpeak.example.com/shoes/atlas-trail-runner-2",
      description: "Best overall for technical terrain.",
    },
    { name: "Ridgeline Fly", url: "https://northpeak.example.com/shoes/ridgeline-fly" },
    { name: "Creststone GTX", url: "https://northpeak.example.com/shoes/creststone-gtx" },
  ],
};

export const bestOfListPageText = `
Best Trail Running Shoes Under $150 — tested and ranked by our editors.
1. Atlas Trail Runner 2 — Best overall for technical terrain.
2. Ridgeline Fly — the lightweight pick.
3. Creststone GTX — best waterproof option.
`;
