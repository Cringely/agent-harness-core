---
name: wiring-diagram
description: Use when producing wiring/hookup diagrams for a hardware build (ESP32/XIAO adapter boards, PCBs, cable harnesses) — an amateur pad-callout pictorial matched to the physical board, and/or a WireViz cable harness with colours, gauges, and BOM. Triggers include "wiring diagram", "hookup diagram", "pinout aide", "which pad goes where", "cable harness", "wireviz", and rendering a board SVG to PNG.
---

# Wiring Diagram

## Overview

Two readers need two different diagrams from one build. This skill emits both:

1. **Pictorial pad-callout** (`render_pictorial.py` → SVG → PNG) — the "which pad goes where" view an amateur wires straight from. Drawn to match the **physical board**: pad grid, silk text, per-pad colored callouts, power-path strip, colour legend, key points.
2. **WireViz harness** (`.yml` → `render_harness.sh` → SVG/PNG) — the "build this cable" view: wire colours, gauges, pin-to-pin, and a BOM, for cutting and crimping.

Author both from one understanding of the build. They are separate spec files (a board-centric JSON and a harness-centric YAML) because the two views need different data; forcing one schema would be a framework.

**Core principle:** the human declares physical facts; the generator computes every coordinate. Hand-editing SVG geometry is the error that bit this pipeline three times (row flip, channel swap, wrong silk). Keep that math out of human hands.

## When to Use

- Any hardware build that someone else (or future-you) has to wire by hand.
- You have a pinout/connection list and need a clear build aide, not just a schematic.
- Use **both** outputs by default. Use only the pictorial for a solder-to-a-board job with no cable to cut; only WireViz when there is a harness but no board silk to match.

## Files in this skill

| File | Role |
|---|---|
| `render_pictorial.py` | JSON spec → pictorial SVG. Computes all geometry. |
| `svg_to_png.sh` | Rasterize any SVG → PNG via headless Chrome (cairo is broken here). |
| `render_harness.sh` | WireViz `.yml` → SVG/PNG (handles the not-on-PATH + graphviz + `3.3V` gotchas). |
| `examples/cyt1070.pictorial.json` | Worked pictorial spec — copy this as your template. |
| `examples/cyt1070.harness.yml` | Worked WireViz spec — copy this as your template. |
| `examples/cyt1070.pictorial.{svg,png}`, `cyt1070.harness.{svg,png}` | Reference outputs to eyeball your result against. |

## Flow 1 — Pictorial

1. Copy `examples/cyt1070.pictorial.json`, edit it to your board (schema below).
2. `python render_pictorial.py my.pictorial.json my.pictorial.svg`
3. `bash svg_to_png.sh my.pictorial.svg my.pictorial.png` (add a 3rd arg for scale; default 2x)

### Pictorial spec schema (JSON)

- `title`, `subtitle`, `canvas:{w,h}` — headers and page size.
- `board:{x,y,w,h,cols,rows}` — **required physical layout.** `cols` = column count. `rows` = list **top-to-bottom**, each `{label, callout_dir:"up"|"down"}`. Optional: `pad_margin`, `row_margin_top/bottom`, `fill`, `stroke`, `silk_fill`, `silk_unused_fill`.
- `groups:[{label, cols:[...]}]` — channel labels centered over column sets.
- `pads:[{row, col, silk, used, note, callout}]` — one per pad you draw. `used:false` draws a grey X (unused pad). `callout`:
  - `{kind:"stub", color, label}` — short labelled stub (e.g. a rail: 5 V, GND).
  - `{kind:"elbow", side:"left"|"right", color, label, series?, rail_y?, end_x?}` — vertical to a rail then horizontal to a side label. `series:{text,color?,w?}` draws an inline component box (e.g. a `100-220Ω` resistor); set `w` (box px width, default 48) for text longer than ~8 chars or it overflows (the generator warns on stderr).
- `power_path`, `legend`, `key_points` — optional strips; see the example for the shape. `**bold**` markers work in any label text.

Silk faces the board interior automatically; callouts face outward per `callout_dir`. You never set pad pixel coordinates.

## Flow 2 — WireViz harness

1. Copy `examples/cyt1070.harness.yml`, edit `connectors` / `cables` / `connections`.
2. `bash render_harness.sh my.harness.yml` → keeps `.svg`/`.png`, deletes WireViz's `.html`/`.tsv`/`.gv`.

The script sets up what the environment lacks; do not fight these:
- The `wireviz` console script is **not on PATH** — it calls `python -c "from wireviz.wv_cli import wireviz; wireviz([...])"`.
- WireViz needs graphviz `dot` — the script prepends `/c/Program Files/Graphviz/bin` to PATH.
- **Gotcha:** a bare decimal+letter token like `3.3V` in a label breaks the graphviz tokenizer ("badly delimited number"). Write `3V3` or a spaced `3.3 V`.

## The render recipe (why headless Chrome)

`cairosvg` / `rsvg` / `inkscape` / `magick` are absent or fail to load libcairo on this machine. `svg_to_png.sh` wraps the SVG in a zero-margin HTML file and screenshots it with Chrome. Two things that break it if you deviate: `--screenshot` and the `file://` URL **must be absolute Windows paths** (relative → "Access is denied"), and `--window-size` must equal the SVG's pixel box. Chrome path: `/c/Program Files/Google/Chrome/Application/chrome.exe`; Edge is the fallback. Pillow 12.x is present for any photo resizing.

## Board-matching discipline (the whole point)

The pictorial is worthless if its layout does not match the board in the builder's hand. This bit the seed build three times. The spec already forces the physical facts as required inputs (`rows` top-to-bottom, `cols`, each pad's exact `silk`). Before you render the final PNG, run this gate against a **photo of the actual board** (in `hardware/images/` for faikin32):

1. **Row order / sides.** Is the top row in your `rows` list the top row on the board? Is HV/LV (or whichever side) on the side you labelled?
2. **Channel left/right.** Is `groups` col-0 the physically left-most channel?
3. **Exact silk text.** Does each pad's `silk` match the letters printed on the board — not the datasheet? Vendor docs are **secondary to the physical silk** (the seed board silks the 5 V pad `VBUS`, not `5V`).

### Red flags — stop and re-check the photo

- HV/LV rows or top/bottom swapped.
- Channel 1 and Channel 2 mirrored left-to-right.
- A silk label copied from the datasheet that differs from the board (VBUS vs 5V).

## Verify

Regenerate the worked example and compare to the shipped reference:

```bash
python render_pictorial.py examples/cyt1070.pictorial.json /tmp/out.svg
bash svg_to_png.sh /tmp/out.svg /tmp/out.png
```

Pass = `/tmp/out.png` reproduces `examples/cyt1070.pictorial.png` essentials: 2×6 pad grid with silk, grey-X on the two RX columns, all eight callouts (two with resistor boxes), power-path strip, colour legend, six key points. For the harness, `render_harness.sh examples/cyt1070.harness.yml` reproduces `examples/cyt1070.harness.{svg,png}`.
