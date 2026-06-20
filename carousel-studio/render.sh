#!/usr/bin/env bash
# render.sh — capture frames with headless Chrome, then encode each slide to MP4.
#
#   bash render.sh                 # full pipeline: frames -> one MP4 per slide
#   bash render.sh --frames-only   # QA pass: capture frames, skip encoding (fast)
#   bash render.sh --slide 03      # only this slide (matches filename substring)
#
# Output:
#   output/frames/<slide>/f00000.png ...   (QA these first)
#   output/mp4/<slide>.mp4                  (1080x1350, 30fps, H.264)
set -euo pipefail
cd "$(dirname "$0")"

FRAMES_ONLY=0
SLIDE_ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --frames-only) FRAMES_ONLY=1; shift;;
    --slide) SLIDE_ARG=(--slide "$2"); shift 2;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done

if [[ ! -d node_modules ]]; then echo "Run 'npm install' first."; exit 1; fi

# resolve the bundled ffmpeg binary (ffmpeg-static, no system install needed)
FFMPEG="$(node -e "import('ffmpeg-static').then(m=>process.stdout.write(m.default))")"
echo "ffmpeg: $FFMPEG"

echo "==> Capturing frames (headless Chromium, 1080x1350, scale 1)"
node capture.mjs "${SLIDE_ARG[@]}" --concurrency 2

if [[ "$FRAMES_ONLY" == "1" ]]; then
  echo "==> Frames-only mode. QA them in output/frames/, then run without --frames-only."
  exit 0
fi

echo "==> Encoding each slide to its own MP4"
mkdir -p output/mp4
FPS="$(node -e "console.log(JSON.parse(require('fs').readFileSync('slides/manifest.json')).fps)")"

for dir in output/frames/*/; do
  base="$(basename "$dir")"
  [[ -f "$dir/f00000.png" ]] || { echo "skip $base (no frames)"; continue; }
  out="output/mp4/${base}.mp4"
  echo "  -> $out"
  # yuv420p + even dims (1080x1350 already even) for max compatibility (IG/Reels)
  "$FFMPEG" -y -loglevel error \
    -framerate "$FPS" -i "$dir/f%05d.png" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -movflags +faststart -r "$FPS" \
    -vf "scale=1080:1350:flags=lanczos" \
    "$out"
done

echo ""
echo "Done. MP4s in output/mp4/:"
ls -1 output/mp4/*.mp4 2>/dev/null || echo "  (none)"
