/**
 * Commerce + structural generators: Product (+Offer +AggregateRating +Review,
 * doc 02 §2.5), standalone Review / AggregateRating, Service (doc 02 §2.4),
 * ItemList (category/best-of), Event, BreadcrumbList.
 */

import type {
  AggregateRatingInput,
  BreadcrumbListInput,
  EventInput,
  ItemListInput,
  JsonLdObject,
  ProductInput,
  ReviewInput,
  ReviewedItemInput,
  SchemaBrandContext,
  ServiceInput,
} from "./types";
import { isoDateToEpoch, issue } from "./validate";
import {
  type Gen,
  type GeneratorOutput,
  buildAggregateRating,
  buildOffer,
  buildPostalAddress,
  buildReview,
  checkDateField,
  checkUrlArrayField,
  checkUrlField,
  claim,
  newGen,
  output,
  p,
  required,
  setIf,
} from "./internal";

/* ------------------------------------------------------------------ */
/* Product (+ Offer + AggregateRating + Review)                        */
/* ------------------------------------------------------------------ */

export function generateProduct(
  entity: ProductInput,
  brand?: SchemaBrandContext,
): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "Product" };

  if (required(gen, "name", "Product name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Product name", entity.name, "text", "error");
  }
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Product description", entity.description, "text", "warning");
  }
  setIf(node, "image", checkUrlArrayField(gen, "image", "Product image", entity.image));
  setIf(node, "sku", entity.sku);
  setIf(node, "gtin", entity.gtin);
  setIf(node, "url", checkUrlField(gen, "url", "Product URL", entity.url));

  const brandName = entity.brandName ?? brand?.organizationName;
  if (brandName !== undefined && brandName.trim() !== "") {
    node.brand = { "@type": "Brand", name: brandName };
    claim(gen, "brand.name", "Product brand", brandName, "text", "warning");
  }

  if (entity.offer !== undefined) {
    node.offers = buildOffer(gen, "offers", entity.offer);
  }
  if (entity.aggregateRating !== undefined) {
    node.aggregateRating = buildAggregateRating(gen, "aggregateRating", entity.aggregateRating, {
      requireCount: true,
    });
  }
  if (entity.reviews !== undefined && entity.reviews.length > 0) {
    node.review = entity.reviews.map((review, i) => buildReview(gen, `review[${i}]`, review));
  }

  // Google Product rich results require offers, review, or aggregateRating.
  if (
    entity.offer === undefined &&
    entity.aggregateRating === undefined &&
    (entity.reviews === undefined || entity.reviews.length === 0)
  ) {
    gen.issues.push(
      issue(
        "MISSING_REQUIRED",
        "error",
        "offers",
        "Product requires at least one of offers, aggregateRating, or reviews (Google rich-results requirement).",
      ),
    );
  }

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Standalone Review / AggregateRating                                 */
/* ------------------------------------------------------------------ */

function buildReviewedItem(gen: Gen, base: string, item: ReviewedItemInput): JsonLdObject {
  const node: JsonLdObject = { "@type": item.type };
  if (required(gen, p(base, "name"), "Reviewed item name", item.name)) {
    node.name = item.name;
    claim(gen, p(base, "name"), "Reviewed item name", item.name, "text", "error");
  }
  setIf(node, "url", checkUrlField(gen, p(base, "url"), "Reviewed item URL", item.url));
  return node;
}

export function generateReview(entity: ReviewInput): GeneratorOutput {
  const gen = newGen();
  if (entity.itemReviewed === undefined) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "itemReviewed", "Review requires itemReviewed."),
    );
    return output(gen, { "@type": "Review" });
  }
  const node = buildReview(gen, "", entity);
  node.itemReviewed = buildReviewedItem(gen, "itemReviewed", entity.itemReviewed);
  return output(gen, node);
}

export function generateAggregateRating(entity: AggregateRatingInput): GeneratorOutput {
  const gen = newGen();
  const node = buildAggregateRating(gen, "", entity, { requireCount: true });
  if (entity.itemReviewed === undefined) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "itemReviewed", "AggregateRating requires itemReviewed."),
    );
  } else {
    node.itemReviewed = buildReviewedItem(gen, "itemReviewed", entity.itemReviewed);
  }
  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function generateService(entity: ServiceInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "Service" };

  if (required(gen, "name", "Service name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Service name", entity.name, "text", "error");
  }
  setIf(node, "serviceType", entity.serviceType);
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Service description", entity.description, "text", "warning");
  }
  if (required(gen, "provider.name", "Service provider name", entity.providerName)) {
    const provider: JsonLdObject = { "@type": "Organization", name: entity.providerName };
    setIf(provider, "url", checkUrlField(gen, "provider.url", "Provider URL", entity.providerUrl));
    node.provider = provider;
    claim(gen, "provider.name", "Service provider", entity.providerName, "text", "warning");
  }
  setIf(node, "areaServed", entity.areaServed === undefined ? undefined : [...entity.areaServed]);
  setIf(node, "url", checkUrlField(gen, "url", "Service URL", entity.url));
  if (entity.offer !== undefined) {
    node.offers = buildOffer(gen, "offers", entity.offer);
  }

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* ItemList (category / best-of)                                       */
/* ------------------------------------------------------------------ */

export function generateItemList(entity: ItemListInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "ItemList" };

  if (entity.name !== undefined) {
    setIf(node, "name", entity.name);
    claim(gen, "name", "List name", entity.name, "text", "warning");
  }
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "List description", entity.description, "text", "warning");
  }
  if (entity.itemListOrder !== undefined) {
    node.itemListOrder = `https://schema.org/ItemListOrder${entity.itemListOrder}`;
  }

  if (!entity.items || entity.items.length === 0) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "itemListElement", "ItemList requires at least one item."),
    );
    return output(gen, node);
  }

  node.itemListElement = entity.items.map((item, i) => {
    const base = `itemListElement[${i}]`;
    const listItem: JsonLdObject = { "@type": "ListItem", position: i + 1 };
    if (required(gen, p(base, "name"), `List item #${i + 1} name`, item.name)) {
      listItem.name = item.name;
      claim(gen, p(base, "name"), `List item "${item.name}"`, item.name, "text", "error");
    }
    setIf(listItem, "url", checkUrlField(gen, p(base, "url"), `List item #${i + 1} URL`, item.url));
    if (item.description !== undefined) {
      setIf(listItem, "description", item.description);
      claim(
        gen,
        p(base, "description"),
        `List item "${item.name}" description`,
        item.description,
        "text",
        "warning",
      );
    }
    return listItem;
  });

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Event                                                               */
/* ------------------------------------------------------------------ */

const ATTENDANCE_MODE: Record<string, string> = {
  Offline: "https://schema.org/OfflineEventAttendanceMode",
  Online: "https://schema.org/OnlineEventAttendanceMode",
  Mixed: "https://schema.org/MixedEventAttendanceMode",
};

const EVENT_STATUS: Record<string, string> = {
  Scheduled: "https://schema.org/EventScheduled",
  Cancelled: "https://schema.org/EventCancelled",
  MovedOnline: "https://schema.org/EventMovedOnline",
  Postponed: "https://schema.org/EventPostponed",
  Rescheduled: "https://schema.org/EventRescheduled",
};

export function generateEvent(entity: EventInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "Event" };

  if (required(gen, "name", "Event name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Event name", entity.name, "text", "error");
  }

  const startDate = checkDateField(gen, "startDate", "Event startDate", entity.startDate, {
    required: true,
  });
  setIf(node, "startDate", startDate);
  const endDate = checkDateField(gen, "endDate", "Event endDate", entity.endDate);
  setIf(node, "endDate", endDate);
  if (startDate !== undefined && endDate !== undefined) {
    if (isoDateToEpoch(endDate) < isoDateToEpoch(startDate)) {
      gen.issues.push(
        issue("DATE_ORDER", "error", "endDate", `endDate (${endDate}) is before startDate (${startDate}).`),
      );
    }
  }

  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Event description", entity.description, "text", "warning");
  }
  setIf(node, "image", checkUrlArrayField(gen, "image", "Event image", entity.image));
  if (entity.eventAttendanceMode !== undefined) {
    node.eventAttendanceMode = ATTENDANCE_MODE[entity.eventAttendanceMode];
  }
  if (entity.eventStatus !== undefined) {
    node.eventStatus = EVENT_STATUS[entity.eventStatus];
  }

  const onlineUrl = checkUrlField(gen, "location.url", "Event online URL", entity.onlineUrl);
  const locations: JsonLdObject[] = [];
  if (entity.location !== undefined) {
    const place: JsonLdObject = { "@type": "Place" };
    if (required(gen, "location.name", "Event venue name", entity.location.name)) {
      place.name = entity.location.name;
      claim(gen, "location.name", "Event venue", entity.location.name, "text", "error");
    }
    if (entity.location.address !== undefined) {
      place.address = buildPostalAddress(gen, "location.address", entity.location.address);
    }
    locations.push(place);
  }
  if (onlineUrl !== undefined) {
    locations.push({ "@type": "VirtualLocation", url: onlineUrl });
  }
  if (locations.length === 0) {
    gen.issues.push(
      issue(
        "MISSING_REQUIRED",
        "error",
        "location",
        "Event requires a physical location or an online URL (Google rich-results requirement).",
      ),
    );
  } else {
    node.location = locations.length === 1 ? locations[0] : locations;
  }

  if (entity.organizerName !== undefined && entity.organizerName.trim() !== "") {
    const organizer: JsonLdObject = { "@type": "Organization", name: entity.organizerName };
    setIf(organizer, "url", checkUrlField(gen, "organizer.url", "Organizer URL", entity.organizerUrl));
    node.organizer = organizer;
    claim(gen, "organizer.name", "Event organizer", entity.organizerName, "text", "warning");
  }
  if (entity.offer !== undefined) {
    node.offers = buildOffer(gen, "offers", entity.offer);
  }
  setIf(node, "url", checkUrlField(gen, "url", "Event URL", entity.url));

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* BreadcrumbList                                                      */
/* ------------------------------------------------------------------ */

export function generateBreadcrumbList(entity: BreadcrumbListInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "BreadcrumbList" };

  if (!entity.items || entity.items.length === 0) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "itemListElement", "BreadcrumbList requires at least one item."),
    );
    return output(gen, node);
  }

  const last = entity.items.length - 1;
  node.itemListElement = entity.items.map((item, i) => {
    const base = `itemListElement[${i}]`;
    const listItem: JsonLdObject = { "@type": "ListItem", position: i + 1 };
    if (required(gen, p(base, "name"), `Breadcrumb #${i + 1} name`, item.name)) {
      listItem.name = item.name;
      // Breadcrumb trails are visible UI.
      claim(gen, p(base, "name"), `Breadcrumb "${item.name}"`, item.name, "text", "error");
    }
    if (item.url === undefined || item.url.trim() === "") {
      // Google: the URL may be omitted only for the last item (the current page).
      if (i !== last) {
        gen.issues.push(
          issue(
            "MISSING_REQUIRED",
            "error",
            p(base, "item"),
            `Breadcrumb #${i + 1} requires a URL (only the final breadcrumb may omit it).`,
          ),
        );
      }
    } else {
      setIf(listItem, "item", checkUrlField(gen, p(base, "item"), `Breadcrumb #${i + 1} URL`, item.url));
    }
    return listItem;
  });

  return output(gen, node);
}
