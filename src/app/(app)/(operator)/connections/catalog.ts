import type { LucideIcon } from "lucide-react";
import {
  ClapperboardIcon,
  GlobeIcon,
  LineChartIcon,
  MapPinIcon,
  MegaphoneIcon,
  PenLineIcon,
  PhoneIcon,
  SearchIcon,
  Share2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  WandSparklesIcon,
} from "lucide-react";

/**
 * The connector census — ONE catalog consumed by both the global Connections
 * board and each client's /connections/[clientId] page, so the two can never
 * drift (Orchestrator scope ruling, 2026-07-11, operator-directed).
 *
 * THE SPLIT (ruled against doc 04 §3/§4/§5/§7):
 *  - PLATFORM connectors are TENANT-scoped: connected once, they power every
 *    client (the agency's own AI/vendor subscriptions — "vendor keys live in
 *    the secrets vault, per-tenant"). Includes the social-posting PLUMBING
 *    (the Ayrshare-class subscription) — while each client's CHANNELS are
 *    client-scoped authorizations riding on it, hence the row in each half.
 *  - CLIENT connectors are CLIENT-scoped: every client authorizes their own
 *    accounts (their GA4 property, their Search Console, their Business
 *    Profile, their review profiles, their social identities, their phone
 *    lines, their website). One client's connection never serves another.
 *
 * HONESTY: nothing is wired and no vendor-config storage exists — statuses on
 * both pages are STRUCTURAL. Every `unlocks` sentence names a SHIPPED surface
 * (verified against the live pages); client rows carry BOTH framings (global
 * "each client", per-client "this client") as explicit copy — never derived.
 * The future storage model (client_connections on the doc 03 §4 pattern +
 * auth_ref into the secrets vault) is a recorded wiring-time governed decision;
 * NO schema lands with this catalog.
 */

export interface PlatformConnector {
  /** Stable slug for keys/tests — never rendered. */
  key: string;
  name: string;
  icon: LucideIcon;
  /** ONE honest sentence: what connecting it turns on + the real surface. */
  unlocks: string;
}

export interface ClientConnector {
  key: string;
  name: string;
  icon: LucideIcon;
  /** Global-board framing ("each client's own …"). */
  unlocksGlobal: string;
  /** Per-client-page framing ("this client's …"). */
  unlocksClient: string;
}

/* ------------------------------------------------------------------ */
/* Platform half — connect once, powers every client                   */
/* ------------------------------------------------------------------ */

export const PLATFORM_CONNECTORS: PlatformConnector[] = [
  {
    key: "content_generation",
    name: "Content generation (Anthropic)",
    icon: PenLineIcon,
    unlocks:
      "Writes blog, FAQ, and pillar drafts in each client's locked brand voice — the drafts that move through the Review & Approvals queue.",
  },
  {
    key: "humanizer",
    name: "Humanizer",
    icon: WandSparklesIcon,
    unlocks:
      "Runs each draft through a humanization pass so it reads like a person wrote it; the result shows on the content review screen.",
  },
  {
    key: "ai_detectors",
    name: "AI detectors",
    icon: ShieldCheckIcon,
    unlocks:
      "Scores every draft against AI-detection tools and shows each detector's result on the review screen before anyone approves it.",
  },
  {
    key: "citation_data",
    name: "AI-citation data",
    icon: SparklesIcon,
    unlocks:
      "One data subscription, queried per client: turns on live citation tracking in every client's Visibility tab — which AI engines cite them, and where competitors win the answer.",
  },
  {
    key: "media_generation",
    name: "Media generation (Higgsfield + Motion)",
    icon: ClapperboardIcon,
    unlocks:
      "Generates on-brand images and video from each client's locked brand kit — the engines behind Image & Media.",
  },
  {
    key: "social_plumbing",
    name: "Social posting pipeline",
    icon: Share2Icon,
    unlocks:
      "The scheduling pipeline that publishes approved social posts — one subscription serves every client, and posts are approved in Review & Approvals, never auto-posted. Each client's own channels are authorized separately, per client.",
  },
];

/* ------------------------------------------------------------------ */
/* Client half — set up per client, each with their own accounts       */
/* ------------------------------------------------------------------ */

/** The special-cased website connector key (registration is live today; the row
 *  routes to the client's Properties panel instead of a vendor status). */
export const WEBSITE_CONNECTOR_KEY = "website";

export const CLIENT_CONNECTORS: ClientConnector[] = [
  {
    key: WEBSITE_CONNECTOR_KEY,
    name: "Website",
    icon: GlobeIcon,
    unlocksGlobal:
      "Each client's site — WordPress, Webflow, Wix, or the edge worker — so approved changes publish with a diff preview and one-click rollback. Registered per client on their Properties panel today; live connection methods arrive with the write-method wiring.",
    unlocksClient:
      "This client's site — WordPress, Webflow, Wix, or the edge worker — so approved changes publish with a diff preview and one-click rollback. Registering the site is live on their Properties panel; the connection methods arrive with the write-method wiring.",
  },
  {
    key: "ga4",
    name: "Google Analytics (GA4)",
    icon: LineChartIcon,
    unlocksGlobal:
      "Each client's own Analytics property, so Measurement shows THEIR sessions, engaged sessions, and conversions — never another client's numbers.",
    unlocksClient:
      "This client's own Analytics property — brings their sessions, engaged sessions, and conversions into Measurement.",
  },
  {
    key: "search_console",
    name: "Search Console",
    icon: SearchIcon,
    unlocksGlobal:
      "Each client's own Search Console, adding their search clicks and impressions to Measurement.",
    unlocksClient:
      "This client's own Search Console — adds their search clicks and impressions to Measurement.",
  },
  {
    key: "call_tracking",
    name: "Call tracking",
    icon: PhoneIcon,
    unlocksGlobal:
      "Each client's own tracking numbers, counting their phone-call and form-fill leads in Measurement.",
    unlocksClient:
      "This client's own tracking numbers — counts their phone-call and form-fill leads in Measurement.",
  },
  {
    key: "gbp",
    name: "Google Business Profile",
    icon: MapPinIcon,
    unlocksGlobal:
      "Each client's own Business Profile, turning on local-pack readiness and NAP consistency in their Local SEO tab.",
    unlocksClient:
      "This client's own Business Profile — turns on local-pack readiness, NAP consistency, and profile data in their Local SEO tab.",
  },
  {
    key: "review_platforms",
    name: "Review platforms",
    icon: StarIcon,
    unlocksGlobal:
      "Each client's own review profiles, turning on monitoring and drafted replies in their Reviews tab — replies are always drafted for a human to approve, never auto-sent.",
    unlocksClient:
      "This client's own review profiles — turns on monitoring and drafted replies in their Reviews tab; replies are always drafted for a human to approve, never auto-sent.",
  },
  {
    key: "social_channels",
    name: "Social channels",
    icon: MegaphoneIcon,
    unlocksGlobal:
      "Each client's own social identities, authorized so approved posts publish to THEIR channels — riding on the platform's posting pipeline above.",
    unlocksClient:
      "This client's own social identities — authorized so approved posts publish to their channels, riding on the platform's posting pipeline.",
  },
];
