# Carousel Studio

Turn a topic into a finished, animated Instagram carousel — **one MP4 per slide, native 1080×1350 (4:5)**. Slides are plain HTML with inline [GSAP](https://gsap.com) timelines that are *deterministically renderable*: headless Chrome seeks the timeline frame-by-frame and screenshots each frame, then ffmpeg encodes each slide to its own video.

```
carousel-studio/
├─ styles/base.css     # the design system — rebrand via 6 CSS variables
├─ lib/
│  ├─ templates.js     # slide templates: cover, step, list, stat, cta
│  └─ icons.js         # real brand logos (simple-icons) + UI glyphs
├─ gen.js              # spec (JSON) -> self-contained slide HTML files
├─ png-carousel.js     # folder of finished PNG slides -> spec (motion presets)
├─ capture.mjs         # headless-Chrome frame capture (+ retry pass)
├─ render.sh           # orchestrates capture -> ffmpeg encode
├─ specs/sample.json   # example carousel spec
├─ assets/             # vendored gsap.min.js + Inter fonts
│  └─ uploads/         # drop your own PNG/exported slides here [gitignored]
├─ slides/             # generated HTML (one per slide)  [gitignored]
└─ output/
   ├─ qa/              # one resting-frame PNG per slide (fast QA)
   ├─ frames/<slide>/  # every captured frame  [gitignored]
   └─ mp4/<slide>.mp4  # final per-slide videos [gitignored]
```

## Setup (once)

```bash
npm install      # pulls a self-contained Chromium (@sparticuz/chromium),
                 # puppeteer-core, GSAP, simple-icons, and a static ffmpeg.
                 # No system Chrome/ffmpeg/apt needed.
```

## Make a carousel

1. **Write a spec** (see `specs/sample.json`). A spec is a topic broken into slides:

   ```json
   {
     "title": "5 AI tools that buy back your week",
     "brand": { "accent": "#2E6BFF" },
     "slides": [
       { "type": "cover", "eyebrow": "Productivity", "title": "...",
         "subtitle": "...", "icons": ["openai","notion","zapier","canva","figma"] },
       { "type": "step", "step": "1", "eyebrow": "Write faster",
         "icon": "openai", "title": "...", "line": "..." },
       { "type": "list", "title": "...", "items": [ {"icon":"zapier","title":"...","line":"..."} ] },
       { "type": "stat", "value": "10", "unit": "hrs", "label": "...", "line": "..." },
       { "type": "cta", "title": "...", "line": "...", "keyword": "TOOLS", "handle": "@you" }
     ]
   }
   ```

2. **Generate** the slide HTML:

   ```bash
   node gen.js specs/sample.json
   ```

3. **QA as static frames first (fast)** — always do this before the slow render:

   ```bash
   bash render.sh --frames-only        # screenshots every frame, skips encoding
   # or open any slides/*.html in a browser to watch it play live
   ```

   Eyeball `output/frames/` (or the per-slide resting frames), fix layout in the
   spec/templates, regenerate, repeat.

4. **Render to MP4s**:

   ```bash
   bash render.sh                       # frames -> output/mp4/<slide>.mp4
   bash render.sh --slide 03            # just one slide while iterating
   ```

## Slide templates

| type   | use                          | key fields |
|--------|------------------------------|------------|
| `cover`| opener; dark headline plate with icons ringed around it | `title`, `subtitle`, `eyebrow`, `icons[]` |
| `step` | one big idea                 | `step`, `icon`, `title`, `line`, `eyebrow` |
| `list` | 2–4 short rows               | `title`, `items[] {icon,title,line}` |
| `stat` | one big number (animated counter) | `value`, `unit`, `label`, `line` |
| `cta`  | comment-keyword call to action | `title`, `line`, `keyword`, `handle` |
| `png`  | animate a finished flat slide image (your own design) | `image`, `motion`, `motionDur` |

**Icons** are resolved by name: a [simple-icons](https://simpleicons.org) slug
(`openai`, `notion`, `figma`, `slack`, …) renders the real brand logo in its
brand color; otherwise a built-in UI glyph is used (`arrow`, `check`, `bolt`,
`target`, `spark`, `clock`, `chart`, `lock`, `rocket`, `message`, `eye`).

## Animate finished PNG slides (no remaking)

Already designed your carousel elsewhere (Canva, Figma, Illustrator → PNG)?
Drop the flat slide images into `assets/uploads/` and the studio adds whole-frame
motion (a fade-in plus a slow Ken Burns drift) and renders one MP4 per slide —
your design is never altered, just moved.

```bash
node png-carousel.js                 # scans assets/uploads/*.png (sorted),
                                     # writes specs/png.json with varied motion
node gen.js specs/png.json
bash render.sh --frames-only         # QA, then drop --frames-only to encode
```

Options: `node png-carousel.js <dir> --motion kenburns-in --dur 5`.
Motion presets: `kenburns-in`, `kenburns-out`, `pan-left`, `pan-right`, `pan-up`
(default `varied` rotates through them so a multi-slide set isn't uniform).

**Whole-frame vs. element-level.** A flat PNG is one baked image, so motion is
applied to the whole frame (move/scale/fade) — it can't make a headline type on
or a number count up. For per-element motion that still preserves your design,
export each slide as **SVG** (named layers → group IDs) and animate the groups,
or export layers as transparent PNGs and composite them.

## Rebrand the whole look — 6 variables

Edit the top of `styles/base.css` (or pass `brand` in a spec to override per-carousel):

```css
--accent: #2E6BFF;   /* the ONE accent color           */
--bg-core:#F5F8FF;   /* soft radial light, frame center */
--bg-edge:#DCE6F7;   /* radial falloff at the edges     */
--plate:  #0C1222;   /* deep dark headline plate        */
--tile:   #FFFFFF;   /* floating card surface           */
--ink:    #0C1222;   /* primary text on light surfaces  */
```

Everything else (shadows, glows, soft tints) is derived with `color-mix`, so
those six values rebrand the entire studio.

## How deterministic rendering works

Each generated slide builds a **paused** GSAP timeline and exposes:

- `window.__ready` — true once fonts are loaded and frame 0 is set
- `window.__dur()` — timeline duration (seconds)
- `window.__seek(t)` — pause and jump to time `t`

`capture.mjs` loads the slide with `?render=1` (which holds at frame 0), reads
the duration, then for each frame seeks to `frame / fps`, waits two paints, and
screenshots at exactly 1080×1350 (`--force-device-scale-factor=1`,
`--allow-file-access-from-files`). It captures frames sequentially per slide,
runs a few slides in parallel (low concurrency), and re-shoots any missing or
blank frames. `render.sh` then ffmpeg-encodes each slide's frames to an MP4
(H.264, yuv420p, faststart — Instagram-friendly).

## Richer motion (optional)

For counters, logo outros, kinetic captions, or data charts, pull a
[HyperFrames](https://github.com/heygen-com/hyperframes) component:

```bash
npx hyperframes add <component-name>
```

Drop it into a slide's markup and drive it from the same GSAP timeline.
