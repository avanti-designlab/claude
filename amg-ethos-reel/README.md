# AMG × Ethos — Partnership Announcement Reel

A 29-second, 1080×1920 (9:16) Instagram/Facebook Reel announcing that **AMG Insurance Group** is now partnered with **Ethos Life Insurance**. It's built entirely in [Remotion](https://remotion.dev) (React → MP4), so every frame is editable code.

Final files are in `deliverables/`:

| file | use |
|---|---|
| `AMG_x_Ethos_Reel.mp4` | the reel with the original sound design |
| `AMG_x_Ethos_Reel_silent.mp4` | the same cut with no audio, for adding trending IG audio |

## Storyboard (30 fps)

| time | scene | what happens |
|---|---|---|
| 0.0–2.8s | **Hook** | AMG's dot mark assembles dot by dot, then the "Big News" pill and the *Exciting / Announcement* headline reveal from a mask |
| 2.4–6.6s | **Lockup** | A brand-circle wipe opens onto AMG's light stage. AMG assembles, a **+** badge links the brands, and the Ethos swoosh spins in and lands as the "O" in ETHOS |
| 6.1–10.3s | **Headline** | "AMG Insurance Group is now partnered with **Ethos Life Insurance!**" with lime highlighter sweeps and supporting copy |
| 9.9–16.9s | **Product** | A SaaS-style phone mockup runs an online application (about you → coverage → review → submitted ✓) while four benefit cards pop in |
| 16.4–21.4s | **Family** | Golden-hour family footage: "Protect what matters most." with *Your family. Your future. Our priority.* chips |
| 20.9–25.9s | **CTA** | A browser card types the invite link, the cursor clicks **Get started**, then a DM bubble: "Our team is here to help you every step of the way." |
| 25.5–29.3s | **End card** | AMG \| ETHOS lockup, "More than insurance. A brighter tomorrow.", three value tiles, and AMG's contact info: insuranceamg.com · @amginsurance · +1 (248) 592-0080 |

Every transition is a brand-circle wipe (the circle motif from AMG's posts) that starts where the eye already is: the AMG mark, the + badge, the phone, the button.

## Brand system

From the client's approved posts (`AMG_IG_Post_*.pdf`):

- **Colors:** AMG deep green `#1F4833`, mid green `#1E915D`, lime `#BCF031`, light `#F1F1F1`, footer green `#336043`, plus Ethos teal `#054843` for Ethos marks
- **Type:** AMG's posts use Gilroy (commercial). The reel uses **Poppins** (closest free geometric match) for display type, at Bold (700) with ExtraBold (800) only on the opening hook, and **Inter** for UI type
- **Logos:**
  - The AMG dot mark is rebuilt as exact vector geometry (4×4 grid, lime group + white group), so each dot can animate on its own
  - The AMG wordmark and the Ethos logos are auto-traced to vector (`tools/trace.cjs` → `src/logoPaths.ts`)

## Editing

```bash
npm install
npm run studio            # live preview / scrub timeline in the browser
npm run render            # → out/AMG_x_Ethos_Reel.mp4
npm run render:silent     # → out/AMG_x_Ethos_Reel_silent.mp4
npm run sound             # regenerate public/soundtrack.wav (after timing changes)
```

In sandboxes without Chrome download access, set `REMOTION_BROWSER` to a local Chrome Headless Shell binary.

- **Copy:** each scene lives in `src/scenes/*.tsx`. The Ethos application link is `INVITE_URL` in `src/scenes/Cta.tsx`. AMG's website, Instagram and phone are `AMG_WEB`, `AMG_IG` and `AMG_PHONE` in `src/scenes/EndCard.tsx`
- **Timing:** scene start and length are in `T` in `src/theme.ts`. If you change them, mirror `SCENES` in `tools/sound.py` and run `npm run sound`
- **Footage:** `public/family.mp4` (H.264, 9:16). Swap it for any vertical clip
- **Quick QA:** `node tools/qa-stills.mjs 120 400 700` renders those frames plus a contact sheet into `out/qa/`

## Notes

- The phone application flow is a **generic illustrative mockup**, not Ethos's actual UI. Its copy sticks to the claims from the client brief ("simple online application", "quick decisions for many", "convenient & secure process").
- The soundtrack is synthesized from scratch in `tools/sound.py` (pads, beat, whooshes, UI clicks, typing ticks, success chime), so there are no licensing concerns.
- Keep important elements out of IG's overlay zones: the top ~220px, the bottom ~380px, and the right-side action rail.
