#!/usr/bin/env python3
"""Render a board pad-callout pictorial (the amateur "which pad goes where" view) from a JSON spec.

One board = one JSON spec of PHYSICAL facts: row order (top-to-bottom), column count,
exact silk text on each pad, and which pad gets which callout. This script computes every
coordinate, so you never hand-edit SVG geometry. The error class that bit faikin32 three
times -- HV/LV row flip, channel left/right swap, a silk label that differs from the vendor
datasheet (VBUS vs 5V) -- lives only in the spec, where you verify it against a photo of
the actual board before rendering.

Usage:
    python render_pictorial.py spec.json out.svg

Then rasterize out.svg with svg_to_png.sh (cairo is broken on this machine; use headless Chrome).
"""
import argparse
import json
import sys
from xml.sax.saxutils import escape


def txt(text):
    """Escape XML and turn **bold** markers into a bold <tspan>."""
    out = []
    for i, part in enumerate(str(text).split("**")):
        if part == "":
            continue
        esc = escape(part)
        out.append(f'<tspan font-weight="700">{esc}</tspan>' if i % 2 else esc)
    return "".join(out)


def render(spec):
    s = []
    canvas = spec.get("canvas", {"w": 1060, "h": 716})
    W, H = canvas["w"], canvas["h"]
    font = spec.get("font", "Segoe UI, Arial, sans-serif")
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
             f'viewBox="0 0 {W} {H}" font-family="{font}">')
    s.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

    # ---- title band ----
    if spec.get("title"):
        s.append(f'<text x="{W/2}" y="34" text-anchor="middle" font-size="22" '
                 f'font-weight="700" fill="#111">{txt(spec["title"])}</text>')
    if spec.get("subtitle"):
        s.append(f'<text x="{W/2}" y="56" text-anchor="middle" font-size="13" '
                 f'fill="#555">{txt(spec["subtitle"])}</text>')

    # ---- board geometry ----
    b = spec["board"]
    bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
    cols = b["cols"]
    rows = b["rows"]                       # list, top-to-bottom; each {label, callout_dir}
    padmL = b.get("pad_margin", 70)        # gutter from board edge to first/last pad centre
    rmT = b.get("row_margin_top", 50)
    rmB = b.get("row_margin_bottom", 50)
    fill = b.get("fill", "#b3232a")
    stroke = b.get("stroke", "#7a1015")
    silk_fill = b.get("silk_fill", "#ffffff")
    silk_unused = b.get("silk_unused_fill", "#e8a9ab")
    label_fill = b.get("label_fill", "#f4c9cb")

    def pad_x(c):
        return bx + padmL + (c * (bw - 2 * padmL) / (cols - 1) if cols > 1 else 0)

    def row_y(r):
        n = len(rows)
        return by + rmT + (r * (bh - rmT - rmB) / (n - 1) if n > 1 else (bh - rmT - rmB) / 2)

    s.append(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="10" '
             f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>')

    # ---- group (channel) labels ----
    for g in spec.get("groups", []):
        gx = sum(pad_x(c) for c in g["cols"]) / len(g["cols"])
        s.append(f'<text x="{gx:.0f}" y="{by+21}" text-anchor="middle" font-size="14" '
                 f'font-weight="700" fill="{label_fill}">{txt(g["label"])}</text>')

    # ---- row markers on both edges ----
    for r, row in enumerate(rows):
        if not row.get("label"):
            continue
        ry = row_y(r)
        for mx in (bx + 24, bx + bw - 24):
            s.append(f'<text x="{mx:.0f}" y="{ry+4:.0f}" text-anchor="middle" font-size="11" '
                     f'font-weight="700" fill="{label_fill}">{txt(row["label"])}</text>')

    # ---- pads, silk, unused-X, notes, callouts ----
    for p in spec["pads"]:
        r, c = p["row"], p["col"]
        px, py = pad_x(c), row_y(r)
        used = p.get("used", True)
        up = rows[r].get("callout_dir", "up" if r < len(rows) / 2 else "down") == "up"

        s.append(f'<circle cx="{px:.0f}" cy="{py:.0f}" r="8" fill="#ffffff" '
                 f'stroke="{stroke}" stroke-width="1.5"/>')
        if p.get("silk"):
            sy = py + 24 if up else py - 18       # silk faces the board interior
            col = silk_fill if used else silk_unused
            s.append(f'<text x="{px:.0f}" y="{sy:.0f}" text-anchor="middle" font-size="12" '
                     f'font-weight="700" fill="{col}">{txt(p["silk"])}</text>')
        if not used:
            s.append(f'<g stroke="#e7c3c4" stroke-width="2">'
                     f'<line x1="{px-6:.0f}" y1="{py-6:.0f}" x2="{px+6:.0f}" y2="{py+6:.0f}"/>'
                     f'<line x1="{px+6:.0f}" y1="{py-6:.0f}" x2="{px-6:.0f}" y2="{py+6:.0f}"/></g>')
        if p.get("note"):
            ny = py + 68 if up is False else py - 64
            s.append(f'<text x="{px:.0f}" y="{ny:.0f}" text-anchor="middle" font-size="11" '
                     f'fill="#8a8a8a">{txt(p["note"])}</text>')

        co = p.get("callout")
        if co:
            s.append(callout_svg(co, px, py, up, by, bh, bx, bw))

    # ---- power path strip ----
    if spec.get("power_path"):
        s.append(power_path_svg(spec["power_path"]))

    # ---- colour legend ----
    if spec.get("legend"):
        s.append(legend_svg(spec["legend"]))

    # ---- key points ----
    if spec.get("key_points"):
        s.append(key_points_svg(spec["key_points"]))

    s.append("</svg>")
    return "\n".join(s)


def callout_svg(co, px, py, up, by, bh, bx, bw):
    """Draw one pad callout. kind 'stub' = short labelled stub; 'elbow' = vertical to a
    rail then horizontal to a side label, with an optional series-component box."""
    color = co.get("color", "#222")
    kind = co.get("kind", "stub")
    out = []
    if kind == "stub":
        end = py - 50 if up else py + 50
        out.append(f'<polyline points="{px:.0f},{py:.0f} {px:.0f},{end:.0f}" '
                   f'fill="none" stroke="{color}" stroke-width="3"/>')
        ly = end - 10 if up else end + 18
        out.append(f'<text x="{px:.0f}" y="{ly:.0f}" text-anchor="middle" font-size="12" '
                   f'font-weight="700" fill="{color}">{txt(co["label"])}</text>')
        return "".join(out)

    # elbow
    rail = co.get("rail_y", (by - 50) if up else (by + bh + 42))
    side = co.get("side", "left")
    end_x = co.get("end_x", (bx + 2) if side == "left" else (bx + bw + 20))
    out.append(f'<polyline points="{px:.0f},{py:.0f} {px:.0f},{rail:.0f} {end_x:.0f},{rail:.0f}" '
               f'fill="none" stroke="{color}" stroke-width="3"/>')
    ser = co.get("series")
    if ser:
        scol = ser.get("color", color)
        bwid = ser.get("w", 48)
        # font-size 10 is ~6 px/char; warn (don't silently overflow) so the author widens `w`.
        if len(str(ser["text"])) * 6 > bwid:
            print(f'warning: series box (w={bwid}) is narrow for {ser["text"]!r}; '
                  f'set "w" on this callout\'s "series" to avoid label overlap', file=sys.stderr)
        boxx = end_x - bwid if side == "left" else end_x
        out.append(f'<rect x="{boxx:.0f}" y="{rail-10:.0f}" width="{bwid}" height="20" rx="3" '
                   f'fill="#fff" stroke="{scol}" stroke-width="2"/>')
        out.append(f'<text x="{boxx+bwid/2:.0f}" y="{rail+4:.0f}" text-anchor="middle" '
                   f'font-size="10" fill="{scol}">{txt(ser["text"])}</text>')
        lx = boxx - 6 if side == "left" else boxx + bwid + 6
    else:
        lx = end_x - 6 if side == "left" else end_x + 6
    anchor = "end" if side == "left" else "start"
    out.append(f'<text x="{lx:.0f}" y="{rail+4:.0f}" text-anchor="{anchor}" font-size="13" '
               f'font-weight="700" fill="{color}">{txt(co["label"])}</text>')
    return "".join(out)


def power_path_svg(pp):
    x, y = pp["x"], pp["y"]
    w, h = pp.get("w", 712), pp.get("h", 88)
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="#faf6ee" stroke="#e0d6c2"/>']
    out.append(f'<text x="{x+16}" y="{y+24}" font-size="14" font-weight="700" '
               f'fill="#7a5a10">{txt(pp.get("title","Power path"))}</text>')
    bx = x + 16
    boxtop = y + 36
    for i, box in enumerate(pp["boxes"]):
        bwid = box.get("w", 100)
        if i > 0:
            lc = box.get("link_color", "#333")
            out.append(f'<line x1="{bx}" y1="{boxtop+18}" x2="{bx+28}" y2="{boxtop+18}" '
                       f'stroke="{lc}" stroke-width="3"/>')
            bx += 28
        st = box.get("stroke", "#333")
        tf = box.get("text_fill", "#111")
        out.append(f'<rect x="{bx}" y="{boxtop}" width="{bwid}" height="36" rx="4" '
                   f'fill="#fff" stroke="{st}"/>')
        out.append(f'<text x="{bx+bwid/2:.0f}" y="{boxtop+17}" text-anchor="middle" '
                   f'font-weight="700" font-size="12" fill="{tf}">{txt(box["label"])}</text>')
        if box.get("sublabel"):
            out.append(f'<text x="{bx+bwid/2:.0f}" y="{boxtop+31}" text-anchor="middle" '
                       f'font-size="12" fill="{tf}">{txt(box["sublabel"])}</text>')
        bx += bwid
    for j, line in enumerate(pp.get("notes", [])):
        out.append(f'<text x="{bx+16}" y="{boxtop+14+j*16}" font-size="11" '
                   f'fill="#333">{txt(line)}</text>')
    return "".join(out)


def legend_svg(lg):
    x, y = lg["x"], lg["y"]
    ncol = lg.get("columns", 2)
    colw = lg.get("col_width", 105)
    out = [f'<text x="{x}" y="{y}" font-size="14" font-weight="700" '
           f'fill="#333">{txt(lg.get("title","Wire colours"))}</text>']
    ry = y + 16
    for i, item in enumerate(lg["items"]):
        col = i % ncol
        if col == 0 and i > 0:
            ry += 18
        lx = x + col * colw
        out.append(f'<line x1="{lx}" y1="{ry}" x2="{lx+28}" y2="{ry}" '
                   f'stroke="{item["color"]}" stroke-width="3"/>')
        out.append(f'<text x="{lx+34}" y="{ry+4}" font-size="12" '
                   f'fill="#333">{txt(item["text"])}</text>')
    return "".join(out)


def key_points_svg(kp):
    x, y = kp["x"], kp["y"]
    out = [f'<text x="{x}" y="{y}" font-weight="700" font-size="14" '
           f'fill="#111">{txt(kp.get("title","Key points"))}</text>']
    for i, line in enumerate(kp["items"]):
        out.append(f'<text x="{x}" y="{y+22+i*20}" font-size="12.5" '
                   f'fill="#444">{i+1}.  {txt(line)}</text>')
    return "".join(out)


def main():
    ap = argparse.ArgumentParser(description="Render a board pad-callout pictorial SVG from a JSON spec.")
    ap.add_argument("spec", help="input JSON spec")
    ap.add_argument("out", help="output SVG path")
    args = ap.parse_args()
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    svg = render(spec)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"wrote {args.out} ({len(svg)} bytes)")


if __name__ == "__main__":
    main()
