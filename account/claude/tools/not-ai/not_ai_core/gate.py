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


# Built from its code point rather than typed as a literal character or a
# backslash escape, per this project's tool-argument-decoding rule: a typed
# escape sequence arrives at the file already decoded, so the safe way to get
# a specific code point into source is to construct it at runtime.
_CURLY_APOSTROPHE = chr(0x2019)  # U+2019 RIGHT SINGLE QUOTATION MARK
# Prose routinely uses the curly apostrophe in place of the straight one, in a
# tokenized word's internal apostrophe as much as in a contraction's suffix,
# so both forms are accepted everywhere below rather than only in one place.
_APOSTROPHE_CLASS = "[" + "'" + _CURLY_APOSTROPHE + "]"

# Issue #166: WORD_RE used to require a straight apostrophe only, so a curly
# apostrophe (the common case for anything pasted out of a word processor, a
# CMS, or most of the web) split one word into two tokens -- "It's" counted
# as "It" and "s" -- which inflated word_count and every rate derived from it
# (contractions_per_1000 among them) on exactly the documents most likely to
# use typographic quotes.
WORD_RE = re.compile(rf"\b[A-Za-z]+(?:{_APOSTROPHE_CLASS}[A-Za-z]+)?\b")
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

# 's is ambiguous between a contraction ("it's" = it is) and a possessive
# ("the company's"). Every other suffix here (n't, 're, 've, ll, d, m) has
# no possessive reading, so a word carrying one is unambiguous. 's alone is
# scoped to the closed set of pronoun/function-word forms below; any other
# "<word>'s" is a possessive and must not inflate the contraction count.
# Issue #122 defect 3, measured on the treatment corpus: 446 reported
# contractions against 53 actual n't forms and 577 possessives -- the count
# was mostly possessive density wearing a contraction label.
#
# Issue #158: the closed set above originally omitted where, how, when and why,
# so "where's", "how's", "when's" and "why's" fell through to "not in the set"
# and were silently treated as possessives -- undercounting real contractions
# rather than overcounting them, the opposite direction from #122's defect but
# the same root cause, an alternation that enumerated the set incompletely.
CONTRACTION_PRONOUN_S = (
    rf"(?:it|he|she|that|there|here|what|who|let|where|how|when|why){_APOSTROPHE_CLASS}s"
)
CONTRACTION_RE = re.compile(
    rf"\b(?:[A-Za-z]+n{_APOSTROPHE_CLASS}t|[A-Za-z]+{_APOSTROPHE_CLASS}(?:re|ve|ll|d|m)|{CONTRACTION_PRONOUN_S})\b",
    re.IGNORECASE,
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

# Issue #122, "contrastive negation": the operator named `X, not Y` and
# `it's not X, but Y` as an overused pattern independently of this gate. The
# diagnosis run harmonised every sub-form that survived across seven corpora
# down to two: a comma followed by "not" and a lowercase word (the lowercase
# requirement excludes "Boston, not New York", two named things rather than a
# value judgment), and the phrase "rather than". Measured rates per 10k words:
# 22.6 third-party control, 24.3 hand-authored human, 39.3 repo docs, 46.9 hook
# comments, 48.9 pre-rules-era, 60.4 commits, 63.6 rules corpus, 75.1 PR
# bodies -- every corpus of ours running at roughly twice both external
# controls. The two sub-forms trade off against each other while the combined
# total stays flat, so only the combined count is reported. Counting one form
# alone would mislead exactly the way the issue's own measurement run found it
# does. No finding fires on this count: an overuse threshold is a judgment
# call about how much is too much, which the issue's numbers inform but do not
# themselves answer, so the gate reports the rate and leaves the threshold to
# the operator rather than picking one unasked.
CONTRASTIVE_NEGATION_COMMA_RE = re.compile(r",\s+not\s+[a-z]")
CONTRASTIVE_NEGATION_RATHER_RE = re.compile(r"\brather than\b", re.IGNORECASE)

# Issue #122, "bold run-in labels": four regexes were tried across five
# corpora in one measurement run, and one of them could not match the
# ordinary `**Label** text` (run-in) form at all -- it only matched a bold
# span that was the entire line ("**Label**" alone) -- which produced a zero
# that got reported as a finding. A bold span anchored at the very start of a
# line's content (after stripping a list marker or blockquote prefix) is a
# label either way. Whether anything follows it on that same line is what
# tells the two forms apart. A bold span anywhere else in a line (ordinary
# mid-sentence emphasis) is neither form and is not counted. Fenced code and
# ATX headings are excluded the same way `_prose_blocks` excludes them from
# sentence measurement: a heading already carries its own structural marker,
# and bold inside a code sample is not a prose label.
BOLD_LABEL_AT_START_RE = re.compile(r"^\*\*(?P<label>[^*\n]+)\*\*(?P<rest>.*)$")


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
    item only while indented at least to the item's own content column. A
    line indented less than that column ends the item and starts a new
    paragraph block instead -- even in the case where CommonMark's lazy
    continuation would keep reading it as the same paragraph (a non-blank
    line that does not itself open a new block continues the paragraph
    regardless of indent). This reader takes the stricter rule everywhere on
    purpose: lazy continuation is exactly the glue between an item and
    unrelated prose after it that this rewrite exists to stop (issue #123f;
    see also the rejected reduced variant recorded on issue #123's "de-indent
    machinery" item, which reopens that same glue case).

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
    fence_length = 0
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
            # CommonMark: a fence closes only on a marker using the same character
            # AND at least as many repeats as the one that opened it. Comparing
            # only the first character (as this used to) means a shorter same-
            # character fence nested inside a longer one -- e.g. a doc that shows
            # a fenced-code example, so its outer fence uses four backticks around
            # content containing a plain ``` -- closes the outer fence early on
            # that inner line. Everything after (the intended closing ```` and any
            # real prose past it) then reads as ordinary markdown instead of
            # staying inside the fence, miscounting both the fence's own content
            # and whatever follows it (issue #123a).
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
            ):
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
            fence_length = len(fence_match.group(1))
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

        # GFM does not require a table's header row to start with "|" --
        # "Name | Role" over "--- | ---" is a legal table with no leading
        # pipe on either line. Requiring TABLE_ROW_RE (leading "|") on the
        # header line rejected that legal form outright, so the header,
        # separator and every body row fell through to plain text and glued
        # into one long pseudo-sentence (issue #123c). The separator row
        # already carries the real signal here: TABLE_SEPARATOR_RE only
        # matches a line made entirely of whitespace, "|", ":" and "-", so
        # requiring the line right after "line" to match it (with both "-"
        # and "|" present) is what tells a table apart from an ordinary
        # sentence that happens to contain "|" -- the header line itself
        # only needs to contain "|" at all, leading or not.
        if (
            "|" in line
            and index + 1 < total
            and TABLE_SEPARATOR_RE.match(lines[index + 1])
            and "-" in lines[index + 1]
            and "|" in lines[index + 1]
        ):
            leading_pipe = bool(TABLE_ROW_RE.match(line))
            flush()
            index += 2
            # Body-row continuation matches the header's own style. A
            # leading-pipe header's body rows must also start with "|" --
            # unchanged from before, and this is what keeps #134's
            # pipe-after-table regression test green: a prose line that
            # merely mentions a shell pipe without a leading "|" still ends
            # the table there. A header with no leading pipe has no leading
            # "|" on its body rows either, so continuation there just
            # requires the line to be non-blank and contain "|".
            while index < total and lines[index].strip() and (
                TABLE_ROW_RE.match(lines[index]) if leading_pipe else "|" in lines[index]
            ):
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
        # Receipt for this de-indent check (issue #123, "de-indent machinery"
        # item): the reviewer of fix/122-gate-segmentation measured five
        # reduced variants of this segmenter against six real documents and
        # rejected four of them on those numbers. The fifth variant, which
        # removes this check outright and lets any less-indented line keep
        # continuing the open list item, produced output identical to the
        # current code on all six documents and had zero lazy-continuation
        # instances across the repository's 157 tracked markdown files at
        # measurement time. It was kept anyway: those 157 files not
        # exercising the case does not mean the case cannot occur, and
        # removing the check reopens exactly the glue this rewrite exists to
        # close -- a de-indented line silently continuing the previous list
        # item instead of starting a new block (see the docstring above).
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


def _bold_label_lines(text: str) -> Iterable[str]:
    """Yield raw lines outside fenced code and ATX headings, one at a time.

    `_prose_blocks` joins paragraph lines into a single string with newlines
    collapsed to spaces, which is right for sentence rhythm but wrong here:
    counting the own-line and run-in bold-label forms separately depends on
    exactly the line boundary `_prose_blocks` throws away, so this walks the
    same fence/heading exclusions on its own rather than reusing that output.

    The fence walk mirrors `_prose_blocks` in the two places that matter here
    too. A fence only closes on a marker using the same character AND at
    least as many repeats as the one that opened it, so a short fence nested
    inside a longer one does not close the outer fence early (issue #123a).
    And an unterminated fence's buffered lines are replayed through this same
    walk and yielded as ordinary lines rather than dropped, so a real label
    after a stray opening marker is still counted (issue #122 finding 2).
    """
    in_fence = False
    fence_char = ""
    fence_length = 0
    fence_lines: list[str] = []
    for line in text.splitlines():
        fence_match = FENCE_RE.match(line)
        if in_fence:
            if (
                fence_match
                and fence_match.group(1)[0] == fence_char
                and len(fence_match.group(1)) >= fence_length
            ):
                in_fence = False
                fence_lines.clear()
            else:
                fence_lines.append(line)
            continue
        if fence_match:
            in_fence = True
            fence_char = fence_match.group(1)[0]
            fence_length = len(fence_match.group(1))
            fence_lines = []
            continue
        if ATX_HEADING_RE.match(line):
            continue
        yield line
    if in_fence and fence_lines:
        yield from _bold_label_lines("\n".join(fence_lines))


def _count_bold_labels(text: str) -> tuple[int, int]:
    """Count `**Label**` markers anchored at a line's start, split by form.

    Returns (own_line, run_in). A list marker or blockquote prefix is
    stripped before matching, so a labelled list item counts the same as a
    bare paragraph line. A trailing colon with nothing else after it still
    reads as own-line: "**Corpora**:" on its own line is the same label the
    unpunctuated form is, not a run-in with an empty body.
    """
    own_line = 0
    run_in = 0
    for line in _bold_label_lines(text):
        list_match = LIST_MARKER_RE.match(line)
        content = list_match.group("content") if list_match else line.strip()
        if content.startswith(">"):
            content = content.lstrip(">").strip()
        match = BOLD_LABEL_AT_START_RE.match(content)
        if not match:
            continue
        rest = match.group("rest").strip()
        if rest in ("", ":"):
            own_line += 1
        else:
            run_in += 1
    return own_line, run_in


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
    contrastive_count = len(CONTRASTIVE_NEGATION_COMMA_RE.findall(text)) + len(
        CONTRASTIVE_NEGATION_RATHER_RE.findall(text)
    )
    bold_own_line, bold_run_in = _count_bold_labels(text)
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
        # A proportion of sentences, not the raw count `_opening_count` returns:
        # issue #122 defect 2 measured this being compared across corpora of
        # different sizes while still an unnormalized count, which is not a
        # comparison a raw count can support. The finding threshold below still
        # reads the raw `max_opening` -- only the reported figure changes.
        "max_same_opening": round(max_opening / len(items), 3) if items else 0.0,
        # Reported per 10k words to match the diagnosis run's own unit. No
        # finding is raised on this count (see CONTRASTIVE_NEGATION_COMMA_RE).
        "contrastive_negation": contrastive_count,
        "contrastive_negation_per_10k": round(contrastive_count * 10000 / len(tokens), 1) if tokens else 0.0,
        "bold_label_own_line": bold_own_line,
        "bold_label_run_in": bold_run_in,
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
