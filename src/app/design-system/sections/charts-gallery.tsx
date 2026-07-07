"use client";

/**
 * The Recharts visual language with realistic tracker data. One identity
 * color (the tenant accent = the client), neutral competitors, reserved
 * status colors with glyphs — a chart never picks its own colors.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EngineCitations, ShareOfVoice, VisibilityTrend } from "@/components/charts";
import { Section } from "./section";

const TREND = [
  { date: "Apr 14", score: 41 },
  { date: "Apr 21", score: 43 },
  { date: "Apr 28", score: 42 },
  { date: "May 5", score: 47 },
  { date: "May 12", score: 51 },
  { date: "May 19", score: 50 },
  { date: "May 26", score: 56 },
  { date: "Jun 2", score: 58 },
  { date: "Jun 9", score: 61 },
  { date: "Jun 16", score: 60 },
  { date: "Jun 23", score: 65 },
  { date: "Jun 30", score: 68 },
];

const SHARE_OF_VOICE = [
  { name: "Harborline Realty", share: 34, isClient: true },
  { name: "Compass SD", share: 27 },
  { name: "Shoreline Group", share: 19 },
  { name: "Pacific Key Homes", share: 12 },
  { name: "Casa Vista", share: 8 },
];

const ENGINES = [
  { engine: "ChatGPT", status: "cited" as const, detail: "3 citations" },
  { engine: "Claude", status: "cited" as const, detail: "2 citations" },
  { engine: "Perplexity", status: "cited" as const, detail: "#1 source" },
  { engine: "Google AI Overviews", status: "lost" as const, detail: "dropped Jun 30" },
  { engine: "Gemini", status: "missing" as const },
  { engine: "Copilot", status: "missing" as const },
];

export function ChartsGallery() {
  return (
    <Section
      id="charts"
      overline="04 · Data visualization"
      title="The chart language"
      description="Quiet hairline grids, muted mono numerals, raised-surface tooltips. The accent follows the client; competitors recede; status is never color alone."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Visibility score</CardTitle>
            <CardDescription>Weekly tracker runs, last 12 weeks</CardDescription>
          </CardHeader>
          <CardContent>
            <VisibilityTrend data={TREND} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Share of voice</CardTitle>
            <CardDescription>AI citations vs named competitors, June</CardDescription>
          </CardHeader>
          <CardContent>
            <ShareOfVoice data={SHARE_OF_VOICE} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Citations by engine</CardTitle>
          <CardDescription>
            Status per engine — color always paired with a glyph and a label
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EngineCitations data={ENGINES} />
        </CardContent>
      </Card>
    </Section>
  );
}
