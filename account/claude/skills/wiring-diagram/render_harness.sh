#!/usr/bin/env bash
# Generate a WireViz cable-harness diagram from a .yml (the "build this cable" view:
# colours, gauges, pin-to-pin, BOM).
#
# GOTCHAS this script handles:
#  - The `wireviz` console script is NOT on PATH here; call the module directly.
#  - WireViz needs graphviz `dot`; we add it to PATH.
#  - A bare decimal+letter token like 3.3V in a label breaks the graphviz tokenizer
#    ("badly delimited number"). Write 3V3 or a spaced "3.3 V" in the yml instead.
#
# Usage: ./render_harness.sh harness.yml
set -euo pipefail

# Normalize to a forward-slash path: WireViz's Windows Python chokes on a POSIX /c/ path,
# and backslashes in the python -c string literal blow up ("\U..." unicodeescape). cygpath -m
# gives C:/... which works in both. (Same path discipline as svg_to_png.sh.)
YML="$(cygpath -m "$1" 2>/dev/null || echo "$1")"
export PATH="$PATH:/c/Program Files/Graphviz/bin"

python -c "from wireviz.wv_cli import wireviz; wireviz(['$YML'])"

# WireViz emits .svg .png .html .tsv .gv (+ .bom.tsv). Keep .svg/.png/.yml; drop the rest.
base="${YML%.yml}"
rm -f "$base.html" "$base.tsv" "$base.gv" "$base.bom.tsv"
echo "kept $base.svg / $base.png (+ source $YML)"
