/**
 * Business-entity generators: LocalBusiness (incl. Store for cannabis, doc 02 §2.1),
 * Restaurant + Menu + MenuItem (doc 02 §2.3), RealEstateAgent (doc 02 §2.2),
 * Organization incl. InsuranceAgency (doc 02 §2.4).
 */

import type {
  JsonLdObject,
  LocalBusinessInput,
  MenuInput,
  OrganizationInput,
  RealEstateAgentInput,
  RestaurantInput,
} from "./types";
import { canonicalPrice, isValidCurrency, issue } from "./validate";
import {
  type Gen,
  type GeneratorOutput,
  buildAggregateRating,
  buildGeo,
  buildOpeningHours,
  buildPostalAddress,
  checkUrlArrayField,
  checkUrlField,
  claim,
  newGen,
  output,
  p,
  recommend,
  required,
  setIf,
} from "./internal";
import { buildPersonNode } from "./generators-content";

/* ------------------------------------------------------------------ */
/* LocalBusiness / Store                                               */
/* ------------------------------------------------------------------ */

function fillLocalBusinessCore(
  gen: Gen,
  node: JsonLdObject,
  entity: LocalBusinessInput,
): void {
  if (required(gen, "name", "Business name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Business name", entity.name, "text", "error");
  }
  if (entity.address === undefined) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "address", "LocalBusiness requires a postal address."),
    );
  } else {
    node.address = buildPostalAddress(gen, "address", entity.address);
  }
  setIf(node, "url", checkUrlField(gen, "url", "Business URL", entity.url));
  if (entity.telephone !== undefined && entity.telephone.trim() !== "") {
    node.telephone = entity.telephone;
    claim(gen, "telephone", "Business phone", entity.telephone, "phone", "error");
  }
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Business description", entity.description, "text", "warning");
  }
  if (entity.geo !== undefined) {
    setIf(node, "geo", buildGeo(gen, "geo", entity.geo));
  }
  if (entity.openingHours !== undefined && entity.openingHours.length > 0) {
    node.openingHoursSpecification = buildOpeningHours(
      gen,
      "openingHoursSpecification",
      entity.openingHours,
    );
  }
  setIf(node, "priceRange", entity.priceRange);
  setIf(node, "image", checkUrlArrayField(gen, "image", "Business image", entity.image));
  setIf(node, "sameAs", checkUrlArrayField(gen, "sameAs", "Business sameAs", entity.sameAs));
}

export function generateLocalBusiness(
  entity: LocalBusinessInput,
  schemaType: "LocalBusiness" | "Store" = "LocalBusiness",
): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": schemaType };
  fillLocalBusinessCore(gen, node, entity);
  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Restaurant + Menu + MenuItem                                        */
/* ------------------------------------------------------------------ */

/** RestrictedDiet tokens accepted as shorthand for schema.org URLs. */
const DIET_TOKENS = new Set([
  "Vegan",
  "Vegetarian",
  "GlutenFree",
  "Halal",
  "Kosher",
  "LowCalorie",
  "LowFat",
  "LowLactose",
  "LowSalt",
  "Diabetic",
]);

function dietUrl(value: string): string {
  if (DIET_TOKENS.has(value)) return `https://schema.org/${value}Diet`;
  return value;
}

function buildMenu(gen: Gen, base: string, menu: MenuInput): JsonLdObject {
  const node: JsonLdObject = { "@type": "Menu" };
  setIf(node, "url", checkUrlField(gen, p(base, "url"), "Menu URL", menu.url));

  if (!menu.sections || menu.sections.length === 0) {
    gen.issues.push(
      issue(
        "MISSING_REQUIRED",
        "error",
        p(base, "hasMenuSection"),
        "Menu requires at least one section with menu items.",
      ),
    );
    return node;
  }

  node.hasMenuSection = menu.sections.map((section, si) => {
    const sectionPath = `${p(base, "hasMenuSection")}[${si}]`;
    const sectionNode: JsonLdObject = { "@type": "MenuSection" };
    if (required(gen, p(sectionPath, "name"), `Menu section #${si + 1} name`, section.name)) {
      sectionNode.name = section.name;
      claim(gen, p(sectionPath, "name"), `Menu section "${section.name}"`, section.name, "text", "warning");
    }
    if (!section.items || section.items.length === 0) {
      gen.issues.push(
        issue(
          "MISSING_REQUIRED",
          "error",
          p(sectionPath, "hasMenuItem"),
          `Menu section #${si + 1} has no items.`,
        ),
      );
      return sectionNode;
    }
    sectionNode.hasMenuItem = section.items.map((item, ii) => {
      const itemPath = `${p(sectionPath, "hasMenuItem")}[${ii}]`;
      const itemNode: JsonLdObject = { "@type": "MenuItem" };
      if (required(gen, p(itemPath, "name"), `Menu item #${ii + 1} in section #${si + 1}`, item.name)) {
        itemNode.name = item.name;
        // Menu item names are the core visible claim on a menu page.
        claim(gen, p(itemPath, "name"), `Menu item "${item.name}"`, item.name, "text", "error");
      }
      if (item.description !== undefined) {
        setIf(itemNode, "description", item.description);
        claim(
          gen,
          p(itemPath, "description"),
          `Menu item "${item.name}" description`,
          item.description,
          "text",
          "warning",
        );
      }
      if (item.price !== undefined) {
        const price = canonicalPrice(item.price);
        if (price === undefined) {
          gen.issues.push(
            issue(
              "INVALID_PRICE",
              "error",
              p(itemPath, "offers.price"),
              `Menu item price ("${String(item.price)}") must be a plain non-negative decimal.`,
            ),
          );
        } else {
          const offer: JsonLdObject = { "@type": "Offer", price };
          if (item.priceCurrency !== undefined) {
            if (!isValidCurrency(item.priceCurrency)) {
              gen.issues.push(
                issue(
                  "INVALID_CURRENCY",
                  "error",
                  p(itemPath, "offers.priceCurrency"),
                  `priceCurrency ("${item.priceCurrency}") must be a 3-letter ISO 4217 code.`,
                ),
              );
            } else {
              offer.priceCurrency = item.priceCurrency;
            }
          } else {
            recommend(gen, p(itemPath, "offers.priceCurrency"), "Menu item priceCurrency");
          }
          itemNode.offers = offer;
          // Prices shown on the menu must match the page (hard rule 1).
          claim(gen, p(itemPath, "offers.price"), `Menu item "${item.name}" price`, price, "price", "error");
        }
      }
      if (item.suitableForDiet !== undefined && item.suitableForDiet.length > 0) {
        itemNode.suitableForDiet = item.suitableForDiet.map(dietUrl);
      }
      return itemNode;
    });
    return sectionNode;
  });

  return node;
}

export function generateRestaurant(entity: RestaurantInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "Restaurant" };
  fillLocalBusinessCore(gen, node, entity);

  if (entity.servesCuisine !== undefined && entity.servesCuisine.length > 0) {
    node.servesCuisine = [...entity.servesCuisine];
    entity.servesCuisine.forEach((cuisine, i) => {
      claim(gen, `servesCuisine[${i}]`, `Cuisine "${cuisine}"`, cuisine, "text", "warning");
    });
  }
  if (typeof entity.acceptsReservations === "string") {
    setIf(
      node,
      "acceptsReservations",
      checkUrlField(gen, "acceptsReservations", "Reservations URL", entity.acceptsReservations),
    );
  } else if (typeof entity.acceptsReservations === "boolean") {
    node.acceptsReservations = entity.acceptsReservations;
  }

  if (entity.menu === undefined) {
    gen.issues.push(
      issue(
        "MISSING_REQUIRED",
        "error",
        "hasMenu",
        "Restaurant requires a menu (doc 02 §2.3 — menu schema is a core AEO surface).",
      ),
    );
  } else {
    node.hasMenu = buildMenu(gen, "hasMenu", entity.menu);
  }

  if (entity.aggregateRating !== undefined) {
    node.aggregateRating = buildAggregateRating(gen, "aggregateRating", entity.aggregateRating, {
      requireCount: true,
    });
  }

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* RealEstateAgent                                                     */
/* ------------------------------------------------------------------ */

export function generateRealEstateAgent(entity: RealEstateAgentInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "RealEstateAgent" };

  if (required(gen, "name", "Agency name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Agency name", entity.name, "text", "error");
  }
  setIf(node, "url", checkUrlField(gen, "url", "Agency URL", entity.url));
  if (entity.telephone !== undefined && entity.telephone.trim() !== "") {
    node.telephone = entity.telephone;
    claim(gen, "telephone", "Agency phone", entity.telephone, "phone", "error");
  }
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Agency description", entity.description, "text", "warning");
  }
  if (entity.address !== undefined) {
    node.address = buildPostalAddress(gen, "address", entity.address);
  } else {
    // Semi-local vertical (doc 02 §2.2) — address recommended, not required.
    recommend(gen, "address", "Agency postal address");
  }
  setIf(node, "areaServed", entity.areaServed === undefined ? undefined : [...entity.areaServed]);
  setIf(node, "image", checkUrlArrayField(gen, "image", "Agency image", entity.image));
  setIf(node, "sameAs", checkUrlArrayField(gen, "sameAs", "Agency sameAs", entity.sameAs));

  if (entity.agent !== undefined) {
    node.employee = buildPersonNode(gen, "employee", entity.agent);
  }

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Organization / InsuranceAgency                                      */
/* ------------------------------------------------------------------ */

export function generateOrganization(
  entity: OrganizationInput,
  schemaType: "Organization" | "InsuranceAgency" = "Organization",
): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": schemaType };

  if (required(gen, "name", "Organization name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Organization name", entity.name, "text", "error");
  }
  setIf(node, "url", checkUrlField(gen, "url", "Organization URL", entity.url, { required: true }));
  setIf(node, "logo", checkUrlField(gen, "logo", "Organization logo", entity.logo));
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Organization description", entity.description, "text", "warning");
  }
  if (entity.telephone !== undefined && entity.telephone.trim() !== "") {
    node.telephone = entity.telephone;
    claim(gen, "telephone", "Organization phone", entity.telephone, "phone", "error");
  }
  if (entity.address !== undefined) {
    node.address = buildPostalAddress(gen, "address", entity.address);
  }
  setIf(node, "sameAs", checkUrlArrayField(gen, "sameAs", "Organization sameAs", entity.sameAs));

  if (entity.contactPoint !== undefined) {
    const contact: JsonLdObject = { "@type": "ContactPoint" };
    if (required(gen, "contactPoint.telephone", "ContactPoint telephone", entity.contactPoint.telephone)) {
      contact.telephone = entity.contactPoint.telephone;
      claim(gen, "contactPoint.telephone", "Contact phone", entity.contactPoint.telephone, "phone", "error");
    }
    setIf(contact, "contactType", entity.contactPoint.contactType);
    setIf(
      contact,
      "areaServed",
      entity.contactPoint.areaServed === undefined ? undefined : [...entity.contactPoint.areaServed],
    );
    setIf(
      contact,
      "availableLanguage",
      entity.contactPoint.availableLanguage === undefined
        ? undefined
        : [...entity.contactPoint.availableLanguage],
    );
    node.contactPoint = contact;
  }

  return output(gen, node);
}
