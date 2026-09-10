"""Deterministic pre-output gate.

This module distinguishes mechanical errors from editorial signals. It never
claims to determine authorship, factual truth, semantic equivalence, or whether
a sentence is sufficiently "human". Those questions need source context and
editorial review.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import re
from statistics import pstdev
from typing import Iterable

from .policy import GenrePolicy, get_policy


WORD_RE = re.compile(r"\b[A-Za-z]+(?:'[A-Za-z]+)?\b")
# A literal space, not \s+. The only call site splits `normalized`, which line 216 has
# already collapsed to single spaces, so the quantifier could never match more than one
# character and only offered the regex engine somewhere to backtrack. CodeQL flagged it
# as a polynomial ReDoS (js/polynomial-redos equivalent) on 2026-09-10; the fix is
# output-identical on every document in this repository, verified before and after.
SENTENCE_RE = re.compile(r"(?<=[.!?]) (?=[A-Z\"'])")

# Markdown structure that is not prose. sentence_length_sd, opening_types,
# max_same_opening, long_over_30, short_under_8 and max_consecutive_short all
# describe the rhythm of written sentences, and a fenced code block, a heading,
# and a table row carry none of that rhythm to measure. Folding them into the
# same punctuation-based split as running text is what produced a 38.6
# words-per-sentence reading on this repository's own docs (issue #122): a
# heading has no terminal period, so it glues onto the paragraph under it; a
# table's `|`-delimited cells never terminate either; and a list item without
# a trailing period glues onto its neighbour or the paragraph that follows the
# list. Every one of those five joins produces one artificially long
# "sentence" out of several real ones, which is exactly the failure mode
# `_prose_blocks` below exists to stop.
FENCE_RE = re.compile(r"^ {0,3}(```+|~~~+)")
ATX_HEADING_RE = re.compile(r"^ {0,3}#{1,6}(?:\s|$)")
LIST_MARKER_RE = re.compile(r"^(?:\s*)(?:[-*+]|\d+[.)])\s+(?P<content>\S.*)$")
TABLE_ROW_RE = re.compile(r"^\s*\|")
TABLE_SEPARATOR_RE = re.compile(r"^[\s|:-]+$")

CONTRACTION_RE = re.compile(
    r"\b(?:[A-Za-z]+n't|[A-Za-z]+'(?:re|ve|ll|d|m|s))\b", re.IGNORECASE
)
PARTICIPIAL_OPENER_RE = re.compile(r"^(?:[A-Za-z]+ing)\b[^.!?]{0,100},")
TIER_ONE = {
    "camaraderie", "tapestry", "palpable", "intricate", "vibrant",
    "cacophony", "solace", "fleeting", "ignite", "unravel", "grapple",
    "amidst", "unspoken", "underscore", "unease", "pang", "waft", "prioritize",
}
TIER_TWO = {
    "delve", "leverage", "utilize", "facilitate", "comprehensive", "robust",
    "seamless", "pivotal", "foster", "meticulous", "nuanced", "multifaceted",
    "transformative", "groundbreaking", "empower", "synergy", "holistic",
    "dynamic", "impactful", "landscape", "realm", "revolutionize", "harness",
    "unlock", "elevate", "garner", "showcase", "bolster", "interplay",
    "testament", "boasts", "enhance", "crucial", "enduring", "valuable",
}
MECHANICAL_PATTERNS = {
    "template-transition": r"\b(?:furthermore|moreover|additionally|in conclusion|to summarize)\b",
    "empty-frame": r"\b(?:it is (?:worth|important) to note that|in today's fast-paced world)\b",
    "copula-avoidance": r"\b(?:serves as|stands as|functions as|operates as|marks a)\b",
    "negative-parallelism": r"\bnot just\b[^.!?]{0,80}\bbut\b",
}


@dataclass(frozen=True)
class Finding:
    rule: str
    severity: str
    message: str
    sentence: int | None = None
    span: str | None = None


@dataclass(frozen=True)
class GateResult:
    genre: str
    word_count: int
    counts: dict[str, float | int]
    findings: tuple[Finding, ...]

    @property
    def passed(self) -> bool:
        return not any(finding.severity == "error" for finding in self.findings)

    def as_dict(self) -> dict:
        return {
            "genre": self.genre,
            "passed": self.passed,
            "word_count": self.word_count,
            "counts": self.counts,
            "findings": [asdict(finding) for finding in self.findings],
        }


def words(text: str) -> list[str]:
    return WORD_RE.findall(text)


def _prose_blocks(text: str) -> tuple[list[str], bool]:
    """Partition markdown into paragraph- and list-item-sized units of prose.

    Excludes fenced code (program text, not prose), ATX (`#`-style) headings,
    and GFM tables. Headings are dropped entirely rather than kept as their
    own one-line "sentence": a heading is a label with no subject-verb rhythm
    to measure, and counting it as a sentence would still misrepresent the
    prose-rhythm stats this module reports, just in the opposite direction
    (many short "sentences" instead of one long one). A list item is its own
    unit even with no terminal punctuation, so one bullet no longer glues onto
    the next or onto the paragraph after the list; a line continues the open
    item only while indented at least to the item's own content column,
    matching how the list reads. A line indented less than that column ends
    the item and starts a new paragraph block instead.

    This is a deliberately narrow reading of markdown, not a CommonMark
    implementation: 4-space indented code blocks and setext (underline-style)
    headings aren't recognised, because this repository's docs use fenced
    code and `#`-headings exclusively. Extend the patterns above if that
    changes.

    A fence that never closes was never rendered as code by anything reading
    this document either, so its remainder is recovered as prose rather than
    dropped (issue #122 finding 2: a stray opening marker used to swallow
    every real sentence after it, silently, all the way to end of file). The
    second return value is `True` when that recovery happened, so the caller
    can still surface the malformed fence instead of passing silently on a
    document whose structure is broken even though its prose got measured.
    """
    lines = text.splitlines()
    blocks: list[str] = []
    current: list[str] = []
    content_col: int | None = None
    in_fence = False
    fence_char = ""
    fence_lines: list[str] = []

    def flush() -> None:
        nonlocal content_col
        if current:
            blocks.append(" ".join(current))
            current.clear()
        content_col = None

    index = 0
    total = len(lines)
    while index < total:
        line = lines[index]

        fence_match = FENCE_RE.match(line)
        if in_fence:
            if fence_match and fence_match.group(1)[0] == fence_char:
                in_fence = False
                fence_lines.clear()
            else:
                fence_lines.append(line)
            index += 1
            continue
        if fence_match:
            flush()
            in_fence = True
            fence_char = fence_match.group(1)[0]
            fence_lines = []
            index += 1
            continue

        stripped = line.strip()
        if not stripped:
            flush()
            index += 1
            continue

        if ATX_HEADING_RE.match(line):
            flush()
            index += 1
            continue

        if (
            TABLE_ROW_RE.match(line)
            and index + 1 < total
            and TABLE_SEPARATOR_RE.match(lines[index + 1])
            and "-" in lines[index + 1]
            and "|" in lines[index + 1]
        ):
            flush()
            index += 2
            while index < total and lines[index].strip() and "|" in lines[index]:
                index += 1
            continue

        list_match = LIST_MARKER_RE.match(line)
        if list_match:
            flush()
            current.append(list_match.group("content"))
            content_col = list_match.start("content")
            index += 1
            continue

        indent = len(line) - len(line.lstrip())
        if content_col is not None and indent < content_col:
            flush()
        current.append(stripped)
        index += 1

    flush()
    unterminated = in_fence
    if unterminated and fence_lines:
        recovered, _ = _prose_blocks("\n".join(fence_lines))
        blocks.extend(recovered)
    return blocks, unterminated


def sentences(text: str) -> tuple[list[str], bool]:
    items: list[str] = []
    blocks, unterminated_fence = _prose_blocks(text)
    for block in blocks:
        normalized = re.sub(r"\s+", " ", block).strip()
        if not normalized:
            continue
        items.extend(
            sentence.strip() for sentence in SENTENCE_RE.split(normalized) if len(words(sentence)) >= 2
        )
    return items, unterminated_fence


def _find(pattern: str, text: str) -> Iterable[re.Match[str]]:
    return re.finditer(pattern, text, re.IGNORECASE)


def _opening_count(items: list[str]) -> tuple[int, int]:
    openings = [words(item)[0].lower() for item in items if words(item)]
    if not openings:
        return 0, 0
    return len(set(openings)), max(openings.count(opening) for opening in set(openings))


def _max_consecutive_short(lengths: list[int], threshold: int = 8) -> int:
    """Return the longest run of sentences shorter than the threshold."""
    longest = current = 0
    for length in lengths:
        current = current + 1 if length < threshold else 0
        longest = max(longest, current)
    return longest


def evaluate(
    text: str,
    genre: str = "linkedin",
    *,
    ascii_punctuation: bool = False,
    protected_terms: Iterable[str] = (),
) -> GateResult:
    """Evaluate text with deterministic, genre-aware checks.

    Empty output, an unterminated fence, and explicitly missing protected
    terms are errors. Typography becomes an error only when the caller
    requests an ASCII house style. Everything else directs editorial
    attention without demanding a rewrite.
    """
    policy: GenrePolicy = get_policy(genre)
    tokens = words(text)
    items, unterminated_fence = sentences(text)
    lengths = [len(words(item)) for item in items]
    distinct_openings, max_opening = _opening_count(items)
    max_short_run = _max_consecutive_short(lengths)
    contraction_count = len(CONTRACTION_RE.findall(text))
    counts: dict[str, float | int] = {
        "dashes": text.count("—") + text.count("–"),
        "curly_quotes": sum(text.count(mark) for mark in "“”‘’"),
        "contractions": contraction_count,
        "contractions_per_1000": round(contraction_count * 1000 / len(tokens), 1) if tokens else 0.0,
        "sentences": len(items),
        "short_under_8": sum(length < 8 for length in lengths),
        "max_consecutive_short": max_short_run,
        "long_over_30": sum(length > 30 for length in lengths),
        "sentence_length_sd": round(pstdev(lengths), 1) if len(lengths) > 1 else 0.0,
        "opening_types": distinct_openings,
        "max_same_opening": max_opening,
    }
    findings: list[Finding] = []
    if not text.strip():
        findings.append(Finding("nonempty", "error", "Text is empty."))
        return GateResult(policy.name, 0, counts, tuple(findings))
    if unterminated_fence:
        findings.append(Finding(
            "unterminated-fence",
            "error",
            "A fenced code block has no closing marker. Its trailing content was "
            "recovered as prose for measurement, but the document is malformed "
            "until the fence is closed.",
        ))
    punctuation_severity = "error" if ascii_punctuation else "review"
    punctuation_context = (
        "The requested ASCII house style does not allow this punctuation."
        if ascii_punctuation
        else "Keep it when it matches the writer, locale, or publication style."
    )
    if counts["dashes"]:
        findings.append(Finding(
            "typography",
            punctuation_severity,
            f"The text contains em or en dashes. {punctuation_context}",
        ))
    if counts["curly_quotes"]:
        findings.append(Finding(
            "typography",
            punctuation_severity,
            f"The text contains curly quotes or apostrophes. {punctuation_context}",
        ))
    normalized = text.casefold()
    for term in dict.fromkeys(protected_terms):
        if not isinstance(term, str) or not term.strip():
            raise ValueError("protected terms must be non-empty strings")
        if term.casefold() not in normalized:
            findings.append(Finding(
                "protected-content",
                "error",
                "Expected protected text is missing from the deliverable.",
                span=term,
            ))
    lowered = [token.lower() for token in tokens]
    for tier, vocabulary, severity in (("tier-1-vocabulary", TIER_ONE, "warning"), ("tier-2-vocabulary", TIER_TWO, "review")):
        for term in sorted(set(lowered) & vocabulary):
            findings.append(Finding(tier, severity, "Review whether this word is precise and needed.", span=term))
    for rule, pattern in MECHANICAL_PATTERNS.items():
        for match in _find(pattern, text):
            findings.append(Finding(rule, "review", "Read this pattern in context; rewrite only if it adds no meaning.", span=match.group(0)))
    for index, item in enumerate(items, 1):
        if PARTICIPIAL_OPENER_RE.search(item):
            findings.append(Finding("participial-opener", "review", "Check whether this opener has a clear subject and earns its complexity.", index, item[:120]))
    if policy.require_contractions and len(tokens) >= 80 and contraction_count == 0:
        findings.append(Finding("contractions", "review", "This conversational genre has no contractions; preserve formality only if it matches the author.", None))
    if len(items) >= 5 and (distinct_openings < 3 or max_opening >= 3):
        findings.append(Finding("sentence-openings", "review", "Several sentences start alike; vary only where it improves the passage.", None))
    if len(items) >= 6 and counts["sentence_length_sd"] < 4:
        findings.append(Finding("sentence-rhythm", "review", "Sentence lengths are unusually uniform; inspect the paragraph rhythm.", None))
    if len(items) >= 4 and max_short_run >= 3 and not policy.allow_fragments:
        findings.append(Finding(
            "choppy-run",
            "review",
            "Several very short sentences appear in a row; combine only those that express one connected idea.",
            None,
        ))
    return GateResult(policy.name, len(tokens), counts, tuple(findings))


def render(result: GateResult, as_json: bool = False) -> str:
    if as_json:
        return json.dumps(result.as_dict(), indent=2, ensure_ascii=False)
    count = result.counts
    status = "pass" if result.passed else "fail"
    lines = [
        f"gate: {status} | genre {result.genre} | words {result.word_count}",
        "counts: " + " | ".join(f"{key} {value}" for key, value in count.items()),
    ]
    if result.findings:
        lines.append("findings:")
        lines.extend(f"- [{item.severity}] {item.rule}: {item.message}" + (f" ({item.span})" if item.span else "") for item in result.findings)
    else:
        lines.append("findings: none")
    return "\n".join(lines)
