/**
 * Content + entity generators: FAQPage, Article, Person (+sameAs), VideoObject,
 * PodcastSeries, PodcastEpisode.
 */

import type {
  ArticleInput,
  FaqPageInput,
  JsonLdObject,
  PersonInput,
  PodcastEpisodeInput,
  PodcastSeriesInput,
  SchemaBrandContext,
  VideoObjectInput,
} from "./types";
import { aggregateSameAs } from "./same-as";
import { isHttpUrl, isPositiveInt, isoDateToEpoch, issue, referenceEpoch } from "./validate";
import {
  type Gen,
  type GeneratorOutput,
  checkDateField,
  checkDurationField,
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

/* ------------------------------------------------------------------ */
/* FAQPage                                                             */
/* ------------------------------------------------------------------ */

export function generateFaqPage(entity: FaqPageInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "FAQPage" };

  if (!entity.faqs || entity.faqs.length === 0) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "mainEntity", "FAQPage requires at least one FAQ pair."),
    );
    return output(gen, node);
  }

  node.mainEntity = entity.faqs.map((faq, i) => {
    const base = `mainEntity[${i}]`;
    const question: JsonLdObject = { "@type": "Question" };
    if (required(gen, p(base, "name"), `FAQ question #${i + 1}`, faq.question)) {
      question.name = faq.question;
      claim(gen, p(base, "name"), `FAQ question #${i + 1}`, faq.question, "text", "error");
    }
    if (required(gen, p(base, "acceptedAnswer.text"), `FAQ answer #${i + 1}`, faq.answer)) {
      question.acceptedAnswer = { "@type": "Answer", text: faq.answer };
      claim(gen, p(base, "acceptedAnswer.text"), `FAQ answer #${i + 1}`, faq.answer, "text", "error");
    }
    return question;
  });

  setIf(node, "url", checkUrlField(gen, "url", "FAQ page URL", entity.url));
  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Article                                                             */
/* ------------------------------------------------------------------ */

const HEADLINE_MAX = 110;

export function generateArticle(
  entity: ArticleInput,
  brand?: SchemaBrandContext,
  referenceDate?: string,
): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "Article" };

  if (required(gen, "headline", "Article headline", entity.headline)) {
    node.headline = entity.headline;
    claim(gen, "headline", "Article headline", entity.headline, "text", "error");
    if (entity.headline.length > HEADLINE_MAX) {
      gen.issues.push(
        issue(
          "HEADLINE_TOO_LONG",
          "warning",
          "headline",
          `Headline is ${entity.headline.length} chars; Google truncates past ~${HEADLINE_MAX}.`,
        ),
      );
    }
  }

  if (required(gen, "author.name", "Article author name", entity.authorName)) {
    const author: JsonLdObject = { "@type": "Person", name: entity.authorName };
    setIf(author, "url", checkUrlField(gen, "author.url", "Author URL", entity.authorUrl));
    node.author = author;
    // The byline / author box must be on the page (doc 02 §2.2 entity signals).
    claim(gen, "author.name", "Article author name", entity.authorName, "text", "error");
  }

  const datePublished = checkDateField(gen, "datePublished", "datePublished", entity.datePublished, {
    required: true,
  });
  setIf(node, "datePublished", datePublished);
  const dateModified = checkDateField(gen, "dateModified", "dateModified", entity.dateModified);
  setIf(node, "dateModified", dateModified);
  if (datePublished !== undefined && dateModified !== undefined) {
    if (isoDateToEpoch(dateModified) < isoDateToEpoch(datePublished)) {
      gen.issues.push(
        issue(
          "DATE_ORDER",
          "error",
          "dateModified",
          `dateModified (${dateModified}) is before datePublished (${datePublished}).`,
        ),
      );
    }
  }
  if (datePublished !== undefined && isoDateToEpoch(datePublished) > referenceEpoch(referenceDate)) {
    gen.issues.push(
      issue(
        "FUTURE_DATE",
        "warning",
        "datePublished",
        `datePublished (${datePublished}) is in the future — dates must reflect real events.`,
      ),
    );
  }

  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Article description", entity.description, "text", "warning");
  }
  setIf(node, "image", checkUrlArrayField(gen, "image", "Article image", entity.image));
  setIf(node, "url", checkUrlField(gen, "url", "Article URL", entity.url));

  const publisherName = entity.publisherName ?? brand?.organizationName;
  const publisherLogo = entity.publisherLogoUrl ?? brand?.logoUrl;
  if (publisherName !== undefined && publisherName.trim() !== "") {
    const publisher: JsonLdObject = { "@type": "Organization", name: publisherName };
    const logoUrl = checkUrlField(gen, "publisher.logo.url", "Publisher logo URL", publisherLogo);
    if (logoUrl !== undefined) publisher.logo = { "@type": "ImageObject", url: logoUrl };
    node.publisher = publisher;
  } else {
    recommend(gen, "publisher", "Article publisher (from input or brand context)");
  }

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Person (+ sameAs)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds a Person node with full sameAs aggregation. Reused by the Person root
 * generator and by RealEstateAgent's nested `employee` person.
 */
export function buildPersonNode(gen: Gen, base: string, entity: PersonInput): JsonLdObject {
  const node: JsonLdObject = { "@type": "Person" };

  if (required(gen, p(base, "name"), "Person name", entity.name)) {
    node.name = entity.name;
    claim(gen, p(base, "name"), "Person name", entity.name, "text", "error");
  }
  if (entity.jobTitle !== undefined) {
    setIf(node, "jobTitle", entity.jobTitle);
    claim(gen, p(base, "jobTitle"), "Person job title", entity.jobTitle, "text", "warning");
  }
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, p(base, "description"), "Person description", entity.description, "text", "warning");
  }
  setIf(node, "url", checkUrlField(gen, p(base, "url"), "Person URL", entity.url));
  setIf(node, "image", checkUrlField(gen, p(base, "image"), "Person image", entity.image));

  // HARD RULE 2: aggregate ALL provided press/profile URLs — deduped, order-stable.
  const sameAs = aggregateSameAs(entity.sameAsSources);
  sameAs.forEach((url, i) => {
    if (!isHttpUrl(url)) {
      gen.issues.push(
        issue(
          "INVALID_URL",
          "error",
          `${p(base, "sameAs")}[${i}]`,
          `sameAs entry ("${url}") is not a valid http(s) URL — entity signals must be real, resolvable URLs.`,
        ),
      );
    }
  });
  if (sameAs.length > 0) {
    node.sameAs = sameAs;
  } else {
    gen.issues.push(
      issue(
        "WEAK_ENTITY_SIGNAL",
        "warning",
        p(base, "sameAs"),
        "No press/profile URLs provided — Person.sameAs is the highest-value entity signal (SKILL.md rule 2); provide every known press article, byline, profile, and credential registry.",
      ),
    );
  }

  if (entity.worksFor !== undefined) {
    const org: JsonLdObject = { "@type": "Organization", name: entity.worksFor.name };
    setIf(
      org,
      "url",
      checkUrlField(gen, p(base, "worksFor.url"), "worksFor URL", entity.worksFor.url),
    );
    node.worksFor = org;
  }
  setIf(node, "knowsAbout", entity.knowsAbout === undefined ? undefined : [...entity.knowsAbout]);

  return node;
}

export function generatePerson(entity: PersonInput): GeneratorOutput {
  const gen = newGen();
  const node = buildPersonNode(gen, "", entity);
  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* VideoObject                                                         */
/* ------------------------------------------------------------------ */

export function generateVideoObject(entity: VideoObjectInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "VideoObject" };

  if (required(gen, "name", "Video name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Video name", entity.name, "text", "error");
  }
  if (required(gen, "description", "Video description", entity.description)) {
    node.description = entity.description;
    claim(gen, "description", "Video description", entity.description, "text", "warning");
  }

  if (!entity.thumbnailUrl || entity.thumbnailUrl.length === 0) {
    gen.issues.push(
      issue("MISSING_REQUIRED", "error", "thumbnailUrl", "VideoObject requires at least one thumbnail URL."),
    );
  } else {
    setIf(node, "thumbnailUrl", checkUrlArrayField(gen, "thumbnailUrl", "Thumbnail URL", entity.thumbnailUrl));
  }

  setIf(
    node,
    "uploadDate",
    checkDateField(gen, "uploadDate", "uploadDate", entity.uploadDate, { required: true }),
  );
  setIf(node, "duration", checkDurationField(gen, "duration", "Video duration", entity.duration));
  const contentUrl = checkUrlField(gen, "contentUrl", "Video content URL", entity.contentUrl);
  const embedUrl = checkUrlField(gen, "embedUrl", "Video embed URL", entity.embedUrl);
  setIf(node, "contentUrl", contentUrl);
  setIf(node, "embedUrl", embedUrl);
  if (entity.contentUrl === undefined && entity.embedUrl === undefined) {
    recommend(gen, "contentUrl", "contentUrl or embedUrl");
  }
  if (entity.transcript !== undefined) {
    setIf(node, "transcript", entity.transcript);
    // The FAQ-video page pattern renders the transcript on-page (doc 02 §2.2).
    claim(gen, "transcript", "Video transcript", entity.transcript, "text", "warning");
  }
  setIf(node, "url", checkUrlField(gen, "url", "Video page URL", entity.url));

  return output(gen, node);
}

/* ------------------------------------------------------------------ */
/* Podcast                                                             */
/* ------------------------------------------------------------------ */

export function generatePodcastSeries(entity: PodcastSeriesInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "PodcastSeries" };

  if (required(gen, "name", "Podcast series name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Podcast series name", entity.name, "text", "error");
  }
  setIf(node, "url", checkUrlField(gen, "url", "Podcast series URL", entity.url, { required: true }));
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Podcast series description", entity.description, "text", "warning");
  }
  setIf(node, "webFeed", checkUrlField(gen, "webFeed", "Podcast web feed", entity.webFeed));
  if (entity.authorName !== undefined && entity.authorName.trim() !== "") {
    node.author = { "@type": "Person", name: entity.authorName };
    claim(gen, "author.name", "Podcast author", entity.authorName, "text", "warning");
  }
  setIf(node, "image", checkUrlField(gen, "image", "Podcast image", entity.image));
  setIf(node, "sameAs", checkUrlArrayField(gen, "sameAs", "Podcast sameAs", entity.sameAs));

  return output(gen, node);
}

export function generatePodcastEpisode(entity: PodcastEpisodeInput): GeneratorOutput {
  const gen = newGen();
  const node: JsonLdObject = { "@type": "PodcastEpisode" };

  if (required(gen, "name", "Podcast episode name", entity.name)) {
    node.name = entity.name;
    claim(gen, "name", "Podcast episode name", entity.name, "text", "error");
  }
  setIf(node, "url", checkUrlField(gen, "url", "Podcast episode URL", entity.url, { required: true }));
  if (entity.description !== undefined) {
    setIf(node, "description", entity.description);
    claim(gen, "description", "Podcast episode description", entity.description, "text", "warning");
  }
  if (entity.seriesName !== undefined && entity.seriesName.trim() !== "") {
    const series: JsonLdObject = { "@type": "PodcastSeries", name: entity.seriesName };
    setIf(series, "url", checkUrlField(gen, "partOfSeries.url", "Series URL", entity.seriesUrl));
    node.partOfSeries = series;
    claim(gen, "partOfSeries.name", "Podcast series name", entity.seriesName, "text", "warning");
  }
  if (entity.episodeNumber !== undefined) {
    if (!isPositiveInt(entity.episodeNumber)) {
      gen.issues.push(
        issue(
          "INVALID_COUNT",
          "error",
          "episodeNumber",
          `episodeNumber (${entity.episodeNumber}) must be a positive integer.`,
        ),
      );
    } else {
      node.episodeNumber = entity.episodeNumber;
    }
  }
  setIf(node, "datePublished", checkDateField(gen, "datePublished", "datePublished", entity.datePublished));
  setIf(node, "duration", checkDurationField(gen, "duration", "Episode duration", entity.duration));
  const audioUrl = checkUrlField(gen, "associatedMedia.contentUrl", "Episode audio URL", entity.audioUrl);
  if (audioUrl !== undefined) {
    node.associatedMedia = { "@type": "MediaObject", contentUrl: audioUrl };
  }

  return output(gen, node);
}
