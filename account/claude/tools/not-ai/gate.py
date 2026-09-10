#!/usr/bin/env python3
"""Run the Not Ai deterministic, genre-aware pre-output gate."""

import argparse
from pathlib import Path
import sys

from not_ai_core.gate import evaluate, render
from not_ai_core.policy import POLICIES


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_file", nargs="?", help="Text file to evaluate")
    parser.add_argument("--stdin", action="store_true", help="Read text from standard input")
    parser.add_argument("--genre", default="linkedin", choices=sorted(POLICIES))
    parser.add_argument("--json", action="store_true", help="Emit structured JSON")
    parser.add_argument(
        "--ascii-punctuation",
        action="store_true",
        help="Enforce an explicitly requested ASCII-only house style",
    )
    parser.add_argument(
        "--protect",
        action="append",
        default=[],
        metavar="TEXT",
        help="Require this literal text in the deliverable; may be repeated",
    )
    args = parser.parse_args()
    if args.stdin or not args.input_file:
        text = sys.stdin.read()
    else:
        # CodeQL py/path-injection fires on the two lines below: argv reaches Path() and
        # read_text(). Alerts #16 and #17 are dismissed as "won't fix" (2026-09-10), because
        # the caller and the file sit in the same trust domain. The person typing the filename
        # is the person running the process, so there is no privilege boundary for a traversal
        # to cross. Confining to a base directory breaks documented usage, since the skill's
        # own examples pass arbitrary paths and this repository's tests invoke the gate across
        # drives, and making that base configurable returns argv to the sink.
        #
        # Dismissal rather than an inline directive or a query filter: this repository runs
        # CodeQL default setup with no workflow file, so a config-file filter would mean
        # converting to advanced setup and owning the workflow. Scanning stays enabled on this
        # tree either way, which is deliberate: a genuine polynomial ReDoS was found in the
        # sibling module the same day, and a tree-wide exclusion would have hidden it.
        path = Path(args.input_file)
        if not path.is_file():
            print(f"Error: file not found: {path}", file=sys.stderr)
            return 2
        text = path.read_text(encoding="utf-8")
    result = evaluate(
        text,
        args.genre,
        ascii_punctuation=args.ascii_punctuation,
        protected_terms=args.protect,
    )
    print(render(result, args.json))
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
