#!/usr/bin/env bash
# Rasterize an SVG to PNG via headless Chrome.
#
# WHY Chrome and not cairo: on this machine cairosvg / rsvg / inkscape / magick are all
# absent or fail to load libcairo. Headless Chrome is the working path. It needs ABSOLUTE
# WINDOWS paths for --screenshot and the file:// URL (relative paths give "Access is denied")
# and its own throwaway --user-data-dir profile.
#
# Usage: ./svg_to_png.sh in.svg out.png [scale]      # scale default 2 (=> 2x device pixels)
set -euo pipefail

SVG="$1"; PNG="$2"; SCALE="${3:-2}"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -x "$CHROME" ] || CHROME="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

# window-size must match the SVG's pixel box, or the screenshot is cropped/padded.
W=$(grep -oE 'width="[0-9]+' "$SVG" | head -1 | grep -oE '[0-9]+')
H=$(grep -oE 'height="[0-9]+' "$SVG" | head -1 | grep -oE '[0-9]+')

OUTDIR=$(cd "$(dirname "$PNG")" && pwd)
BASE=$(basename "$PNG" .png)
WRAP="$OUTDIR/$BASE.wrap.html"

# minimal wrapper: zero margins so the SVG sits at 0,0
printf '<!doctype html><meta charset=utf-8><style>html,body{margin:0}</style>\n' > "$WRAP"
cat "$SVG" >> "$WRAP"

WIN_PNG=$(cygpath -w "$OUTDIR/$BASE.png")   # MUST be absolute or Chrome errors "path not found"
WIN_PROF=$(cygpath -w "$OUTDIR/.cr-prof")   # reusable throwaway profile; safe to delete
URL="file:///$(cygpath -m "$WRAP")"

"$CHROME" --headless --disable-gpu --no-sandbox \
  --user-data-dir="$WIN_PROF" \
  --force-device-scale-factor="$SCALE" \
  --screenshot="$WIN_PNG" \
  --window-size="$W,$H" \
  --hide-scrollbars "$URL"

rm -f "$WRAP"
echo "wrote $PNG (${W}x${H} @ ${SCALE}x)"
