/**
 * M9 humanizer PORT fake — identity default, scripted rewrite, journaling, and the
 * unavailable/thrown path. (The port is exercised end-to-end in authenticate.test.)
 */

import { describe, expect, it } from "vitest";
import { ScriptedHumanizerProvider } from "./humanizer";
import type { VoiceProfile } from "@/lib/types/brand";

const VOICE: VoiceProfile = { descriptors: [], samples: [], do: [], dont: [] };

describe("ScriptedHumanizerProvider", () => {
  it("defaults to the IDENTITY rewrite (a humanizer that changed nothing) + journals calls", async () => {
    const hz = new ScriptedHumanizerProvider();
    const out = await hz.humanize({ body: "unchanged draft", voice: VOICE });
    expect(out.text).toBe("unchanged draft");
    expect(hz.calls).toHaveLength(1);
    expect(hz.calls[0].body).toBe("unchanged draft");
  });

  it("rewrite(fn) may return a bare string or a full result; sees the whole request", async () => {
    const hz = new ScriptedHumanizerProvider("hz").rewrite((req) => `voice=${req.voice.descriptors.length}:${req.body}`);
    const out = await hz.humanize({ body: "x", voice: { ...VOICE, descriptors: ["calm"] } });
    expect(out.text).toBe("voice=1:x");
  });

  it("failNext() rejects exactly once (the unavailable path)", async () => {
    const hz = new ScriptedHumanizerProvider("hz").failNext(new Error("down"));
    await expect(hz.humanize({ body: "x", voice: VOICE })).rejects.toThrow("down");
    // Recovers on the next call.
    await expect(hz.humanize({ body: "y", voice: VOICE })).resolves.toMatchObject({ text: "y" });
  });
});
