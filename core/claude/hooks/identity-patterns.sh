#!/bin/sh
# Shared identity-string matcher for the two git-hook gates that enforce
# security.md's mandate: the operator's legal name, personal email
# addresses, the workstation username, and the machine hostname must never
# reach a remote repository, and only a human may waive that. Sourced by
# core/claude/hooks/pre-commit and core/claude/hooks/pre-push. This file is
# a POSIX sh function library, not a hook itself -- it carries no shebang-
# driven behaviour of its own and is never invoked directly, only `.`-sourced.
#
# WHY A SHARED LIBRARY INSTEAD OF A SECOND COPY
# install/Export-Account.ps1 already carries pattern-matching logic for the
# same mandate (word-boundary lookarounds over a declared name/email list
# plus the derived workstation username). That script is PowerShell and only
# ever runs on Windows, on demand, by the operator. These two hooks are
# POSIX sh so they run identically under git for Windows, WSL, and Linux, on
# every commit and push regardless of who or what made them -- the exporter
# is not a dependency either hook can take. This file is the sh-side
# equivalent of the exporter's identity gate, shared between pre-commit and
# pre-push so the two cannot silently drift on what counts as an
# identifying string.
#
# WHY grep -E's \b, NOT A LOOKAROUND
# The exporter's regex uses `(?<!...)...(?!...)` lookarounds, which need
# PCRE. GNU grep's -P flag supports lookarounds, but measured on this
# workstation with LANG and LC_ALL both unset -- the default a git hook
# inherits -- `grep -P` exits 2 with "supports only unibyte and UTF-8
# locales" before it reads a single line, and setting LC_ALL=en_US.UTF-8 or
# LC_ALL=C.UTF-8 first makes it work. Unset is not the same claim as no
# locale variable at all being set: #135's review measured, through a
# real git commit, that Git for Windows launches hooks with
# LC_CTYPE=C.UTF-8 regardless of LANG/LC_ALL. `grep -P`'s crash above
# does not depend on LC_CTYPE, so that finding still holds; LC_CTYPE is
# what matters for the byte-vs-character counting elsewhere in this file
# (identity_json_array's own LOCALE note covers where and why). A check
# whose engine can refuse to run depending on the caller's locale is
# exactly the failure this file exists to close, so -P is not used
# anywhere here. GNU grep -E's `\b` extension needs no locale. Measured
# against the exact collision the exporter's own
# comment and its Export-Account.Tests.ps1 fixture record
# (Export-Account.Tests.ps1's "does not read a declared name out of an
# ordinary word that contains it"):
# skills/owasp-llm/references/08-vector-and-embedding-weaknesses.md:117
# reads "adjusting the augmentation process", which contains the operator's
# declared first name as a substring. That test
# fixture uses a synthetic four-letter declaration rather than the real
# name for the reason recorded there -- writing the real name into a file
# in this repo is the thing being prevented -- and this comment does the
# same: `printf 'adjusting\nJust arrived\n' | grep -iE '\bjust\b'` matches
# only the second line, exactly as it would for the real name this
# demonstrates without spelling it out.
#
# WHY grep -E, NEVER grep -F
# 2026-09-05's incident: MSYS grep -F aborted mid-scan on this workstation
# on one check in a batch (a hostname check, specifically), and the
# surrounding `|| echo NONE` printed a clean result over the crash -- every
# -F result in that batch was a false negative. -E is what the recovery
# re-ran with. Nothing in this file uses -F, and identity_control below is
# the check that catches a recurrence of exactly this failure shape,
# whatever causes it this time.
#
# KNOWN LIMIT: NON-ASCII CASE FOLDING
# `grep -i` folds ASCII case only under the locale this file runs with
# (LANG and LC_ALL both unset, by design, above -- though #135's review
# measured Git for Windows setting LC_CTYPE=C.UTF-8 regardless of that,
# a fact this paragraph does not depend on since it is about what grep
# folds, not about byte-vs-character counting; identity_json_array's own
# LOCALE note is where LC_CTYPE actually matters in this file). A
# declared name containing a non-ASCII letter -- "Zoë Farbleworth" -- is
# matched exactly as declared and
# in any all-lowercase or all-uppercase rendering of its ASCII letters, but
# a rendering that also case-folds the non-ASCII letter itself ("ZOË") does
# not fold to match, because grep -i never touches that byte. Measured
# 2026-09-05. Fixing this needs a UTF-8-aware locale (LC_ALL=C.UTF-8 or
# similar) for -i's folding, which reopens the `grep -P` locale-crash class
# of failure this file exists to avoid for a gap this narrow, so it is
# documented here rather than patched. The same byte-orientation is why
# identity_edge_ok below treats a non-ASCII byte at either edge of a
# declared entry as non-word: it is the same limitation, not a second one.

# --- pattern-set construction -------------------------------------------

# ERE-escapes a literal string for use inside the alternation this file
# builds. The bracket expression below is ordered so `]` sits first (POSIX:
# only literal there, never the closing delimiter) and `.` never
# immediately follows the bracket's own opening `[` -- `[.` inside a POSIX
# bracket expression opens a collating-symbol construct ([.ch.]), not a
# literal `[` followed by a literal `.`, and a naive `[.^$(){}...]` ordering
# sends sed hunting for a `.]` that never arrives, failing the whole
# expression with "unterminated `s' command". Measured: reordering so `.`
# is not bracket-adjacent to `[` is what fixes it; every other ERE
# metacharacter in the class is a plain literal inside `[...]` regardless
# of position.
identity_regex_escape() {
    printf '%s' "$1" | sed 's/[].^$(){}?+*|\\[]/\\&/g'
}

# Converts one hex digit character ($1, already validated by the caller as
# [0-9A-Fa-f]) to its decimal value 0-15, using plain `+`/`*` arithmetic:
# POSIX sh's `$(( ))` is not guaranteed to support the `16#XX` base-N
# literal ksh/bash add as an extension, and this file already avoids
# anything outside plain POSIX for the identical reason `grep -P` is
# avoided elsewhere in this header.
#
# Sets the global $identity_hexval rather than printing a value for the
# caller to capture with $(...). #135's review measured about 12 process
# spawns per \uXXXX escape in the printf-and-capture shape this used to
# have (6 cut, 4 of them this function's own command substitution, 2
# printf), enough that one declared entry with 150 escapes took 973s at
# pre-commit -- identity_json_unescape below calls this up to four times
# per escape, and a command substitution forks a subshell to capture
# output even when the command is a shell function, so the fork was the
# same cost regardless of how little work ran inside it. Called as a
# plain function call instead, this costs nothing beyond the case
# dispatch itself.
identity_hex_digit_value() {
    case $1 in
        [0-9]) identity_hexval=$1 ;;
        [Aa]) identity_hexval=10 ;;
        [Bb]) identity_hexval=11 ;;
        [Cc]) identity_hexval=12 ;;
        [Dd]) identity_hexval=13 ;;
        [Ee]) identity_hexval=14 ;;
        [Ff]) identity_hexval=15 ;;
        *) return 1 ;;
    esac
}

# Strips leading whitespace from $1 into the global $identity_trimmed, by
# repeated one-character parameter expansion rather than a sed fork.
# Used where identity_json_array needs this more than once per token
# (comma-and-whitespace between array elements, and whitespace after a
# closing ']') and the amount stripped is always small -- a handful of
# loop iterations beats one process spawn on the cost this file is
# written against (#135's review, same incident as above).
identity_ltrim() {
    identity_trimmed=$1
    while :; do
        case $identity_trimmed in
            [[:space:]]*) identity_trimmed=${identity_trimmed#?} ;;
            *) break ;;
        esac
    done
}

# Decodes JSON string escapes in $1 (the text strictly between a token's
# own quotes -- the caller strips those first). Prints the decoded text
# and returns 0. Returns 1, printing nothing, on an escape this function
# will not decode; the caller (identity_json_array) turns that into a load
# failure naming the identity file rather than silently emitting the
# literal, undecoded escape text the way this file did before issue #91d:
# a name declared as "F\u0069ctional Persona" never matched the plain
# "Fictional Persona" text it was meant to catch, because the \u0069 sat in
# the built grep pattern unchanged -- load succeeded, the per-arm canary
# passed (it is built from this same parse), and the plain text went
# straight through, a silent false negative rather than a loud one.
#
# \" \\ \/ decode always. \b \f \t decode to their real control bytes.
# \n and \r do NOT decode, on purpose: identity_load represents the whole
# parsed pattern set as one newline-delimited list (the `entries` variable
# a `while IFS= read -r entry` loop consumes, and the per-arm canaries
# built the same way), and a decoded \n or \r would inject a raw line
# break into that list, silently splitting one declared entry into two or
# merging it with its neighbour -- a new fail-open path in exchange for
# closing this one. No legitimate name or email plausibly needs an
# embedded line break; a JSON writer's actual reason to escape something
# in a declared identity string is a quote, a backslash, a slash, or (a
# \uXXXX run) something it will not write raw -- PowerShell's
# ConvertTo-Json escapes `'` `<` `>` `&` as \u0027 \u003c \u003e \u0026
# even for otherwise pure-ASCII input, which is the concrete case this
# fix targets, not a hypothetical one.
#
# \uXXXX decodes only for the printable-ASCII range \u0020-\u007e. Outside
# it (a JSON control character, a UTF-16 surrogate half, or a genuine
# non-ASCII code point) this refuses rather than guessing: emitting the
# right bytes needs a multi-byte UTF-8 encoder this POSIX sh + sed + grep
# + cut toolchain does not have, and this file's header already accepts
# an ASCII-only limit for `grep -i` case folding for the identical reason.
# A wrong guess here would build a dead or mismatched pattern arm exactly
# as silently as the undecoded escape did; refusing is loud instead.
#
# Byte-oriented throughout (cut -c, ${#var}, the `?` glob wildcard),
# which needs LC_ALL forced to C to be true, not merely LANG/LC_ALL being
# unset. #135's round-1 review measured, through a real git commit, that
# Git for Windows launches hooks with LC_CTYPE=C.UTF-8 set -- this file's
# header ("WHY grep -E's \b") is correct that a git hook inherits LANG
# and LC_ALL unset, but that is not the same claim as no locale variable
# being set, and LC_CTYPE alone is enough: under C.UTF-8, `cut -c` still
# counts bytes but ${#var} and `?` both count characters, and those
# disagree on any non-ASCII declared entry. identity_json_array, this
# function's only caller, forces LC_ALL=C in its own $(...) subshell
# before ever calling this (see that function's own LOCALE note), which
# is what actually makes "one byte is one character" true here.
#
# COST: #135's round-1 review measured about 12 process spawns per escape in this
# function's previous shape (6 cut, 4 digit subshells, 2 printf) -- one
# declared entry with 150 escapes took 973s at pre-commit, still 973s
# after #91c/#91d landed since this cost predates both. Below, escape
# detection, hex-digit extraction, and the advance past a decoded escape
# or a literal run all use `${var#pattern}`/`${var%%pattern}` parameter
# expansion instead of a `cut`/`sed` subprocess per character: no fork,
# run in the shell that is already running. \uXXXX's byte value is
# likewise computed with plain `/` and `%` arithmetic rather than
# `printf '%03o'`. What is left, one `printf` per escape to turn that
# numeric byte value into an actual character, has no POSIX parameter-
# expansion or arithmetic form -- emitting a byte from a number is not
# string manipulation, and `printf` is the smallest thing in this
# toolchain that can do it.
identity_json_unescape() {
    in=$1
    out=
    while [ -n "$in" ]; do
        case $in in
            '\'*)
                # A single-quoted shell literal is not escape-processed:
                # '\\' between single quotes is the two-character string
                # \\, not one backslash. '\'* -- a lone backslash closing
                # the quote, then an unquoted wildcard -- is what matches
                # "starts with one backslash". $rest, below, is everything
                # after that one backslash; matching on ITS first
                # character with a wildcard case pattern reads the escape
                # type without a `cut` fork to extract it into its own
                # variable first.
                rest=${in#\\}
                case $rest in
                    '"'*) out="${out}\"" ; in=${rest#?} ;;
                    '\'*) out="${out}\\" ; in=${rest#?} ;;
                    /*)   out="${out}/"  ; in=${rest#?} ;;
                    b*)
                        byte=$(printf '\010') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    f*)
                        byte=$(printf '\014') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    t*)
                        byte=$(printf '\011') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    u????*)
                        # Peels the four hex digits straight off $rest (no
                        # `cut`, and no separate $hex variable to strip
                        # back off again for the tail advance): each
                        # ${work%"${work#?}"} isolates $work's own first
                        # character the same way identity_hex_digit_value's
                        # caller used to isolate one out of a four-
                        # character $hex, just run four times in place, and
                        # $work IS the correctly-advanced remainder once
                        # all four are gone -- one fewer thing to
                        # reconstruct, not just one fewer fork. #135's
                        # review (cost, F5 in the original #91 review):
                        # this and the arithmetic below in place of
                        # `printf '%03o'` are what took this escape from
                        # about 3 process spawns down to the one left --
                        # actually emitting a byte from a numeric value has
                        # no POSIX parameter-expansion or arithmetic form,
                        # only `printf`.
                        work=${rest#u}
                        h1=${work%"${work#?}"}
                        work=${work#?}
                        h2=${work%"${work#?}"}
                        work=${work#?}
                        h3=${work%"${work#?}"}
                        work=${work#?}
                        h4=${work%"${work#?}"}
                        work=${work#?}
                        case $h1$h2$h3$h4 in
                            [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]) : ;;
                            *) return 1 ;;
                        esac
                        identity_hex_digit_value "$h1" || return 1 ; d1=$identity_hexval
                        identity_hex_digit_value "$h2" || return 1 ; d2=$identity_hexval
                        identity_hex_digit_value "$h3" || return 1 ; d3=$identity_hexval
                        identity_hex_digit_value "$h4" || return 1 ; d4=$identity_hexval
                        cp=$((d1 * 4096 + d2 * 256 + d3 * 16 + d4))
                        [ "$cp" -ge 32 ] && [ "$cp" -le 126 ] || return 1
                        o1=$((cp / 64))
                        o2=$(((cp / 8) % 8))
                        o3=$((cp % 8))
                        byte=$(printf "\\${o1}${o2}${o3}") || return 1
                        out="${out}${byte}"
                        in=$work
                        ;;
                    *) return 1 ;;
                esac
                ;;
            *)
                # One literal run up to (not including) the next backslash,
                # rather than one byte at a time -- most of a declared
                # entry's text has no escapes in it at all. `${in%%\\*}`
                # is the parameter-expansion form of `sed 's/\\.*$//'`:
                # strip the longest suffix starting at a backslash, i.e.
                # keep everything before the FIRST one.
                lit=${in%%\\*}
                [ -n "$lit" ] || return 1
                out="${out}${lit}"
                in=${in#"$lit"}
                ;;
        esac
    done
    printf '%s' "$out"
}

# Pulls every double-quoted string out of a JSON array value for $2 ("names"
# or "emails") in the raw text $1, one per output line, with JSON string
# escapes decoded (identity_json_unescape, above). No jq dependency,
# matching session-start-drift-check.sh's precedent (jq ships with neither
# this repo nor Git for Windows). Handles the array spanning multiple lines
# by flattening newlines to spaces first; does not attempt general JSON
# parsing beyond the flat {"key": ["a", "b"]} shape
# install/Export-Account.ps1's -IdentityFile doc declares. An absent key or
# an empty array both produce no output, which the caller treats as "zero
# declared entries in this category", not as a malformed file.
#
# Peels one complete string token off the front of the array's contents at
# a time, rather than the single regex this used before that captured
# "everything up to the FIRST `]`" in one shot. Issue #91c: a `]` inside a
# declared entry's own text (a bracketed aside, redacted text, anything)
# is not a delimiter, and that regex stopped there -- the truncated,
# unterminated fragment left over then matched no quoted-string pattern at
# all, so the whole array read as empty rather than merely short one
# entry, silently losing that entry AND every entry declared after it.
# Consuming a whole token at a time (the same quote-and-backslash-aware
# shape the old code used for extraction, applied per-token instead of to
# an already-truncated segment) means a `]` inside a token's own text is
# already inside the token by the time anything looks at it; only a real
# `]`, seen after skipping the comma/whitespace between elements, ends the
# loop.
#
# Returns non-zero, printing nothing further, when a token cannot be
# decoded (identity_json_unescape's fail-closed cases, above) or the
# array's contents are malformed enough that no further complete token can
# be found before running out of input without ever seeing the closing
# `]`. identity_load treats that as a load failure and refuses -- a
# `]`-in-an-entry defect and a \uXXXX-in-an-entry defect are both a case of
# this parser checking less than it claims to, and this file's answer to
# "checks less than it claims" is to refuse, never to guess.
#
# LOCALE (#135's review): forced to C for the whole function, in this
# function's own $(...) subshell only. See identity_json_unescape's own
# LOCALE note for what breaks without it and why here, not there, is
# where forcing it is enough: this is the only caller of that function,
# and both use `cut -c`/`${#var}`/the `?` glob wildcard for length and
# offset work that must agree on bytes vs. characters to be correct.
# Scoped to this $(...) subshell rather than identity_load's own
# environment, so neither identity_load's rest nor the final `grep -iE`
# match sees a changed locale -- that match must keep whatever locale the
# top-level hook actually runs under (this file's header, "WHY grep -E's
# \b").
identity_json_array() {
    LC_ALL=C
    export LC_ALL

    raw=$1
    key=$2
    flat=$(printf '%s' "$raw" | tr '\n' ' ') || return 1
    # #135's round-2 review (N1): unchecked, a crashed sed here (the exact
    # 2026-09-05 incident shape this file's header exists to catch, one
    # tool call in a batch failing silently) reads identically to "the
    # key was never declared" at the line below -- rc 0, empty $tail --
    # so this one channel goes silently empty while the other stays
    # populated and the both-empty refusal never fires. `sed -n` itself
    # exits 0 on a clean no-match, so checking the exit status here does
    # not turn an absent key into a false refusal.
    tail=$(printf '%s' "$flat" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\[/[/p") || {
        echo "identity gate: the '$key' key lookup in '$identity_file' did not run cleanly. Refusing rather than reading a crashed extraction as an absent key." >&2
        return 1
    }
    [ -n "$tail" ] || return 0

    # #135's review (F2): the sed above used to discard the array's own
    # '[' along with everything before it, so a key that IS declared but
    # whose array is truncated right after '[' -- a partial write, an
    # editor that died mid-save -- produced the same empty $tail as a key
    # that was never declared at all, and the `return 0` above then
    # reported it as "zero entries", not as the malformed file it is.
    # Keeping the '[' in the sed's replacement and stripping it here,
    # after the presence check, means "found but truncated" still reaches
    # the loop below as an empty $tail -- which then finds no closing ']'
    # and refuses -- while "key not declared" still returns 0 above,
    # because a key sed never matched leaves $tail genuinely empty before
    # this line ever runs.
    tail=${tail#\[}

    while :; do
        identity_ltrim "$tail"
        rest=$identity_trimmed
        case $rest in
            ,*)
                identity_ltrim "${rest#,}"
                rest=$identity_trimmed
                ;;
        esac
        case $rest in
            ']'*)
                # #135's review (F7): breaking here on the first bare ']'
                # without checking what follows accepts a document where
                # this array's real content ends earlier than the ']'
                # just matched, with a stray value sitting between them --
                # e.g. ["Bob Example"] "Alice Example"], which is not
                # valid JSON. A well-formed object continues with ','
                # (another key) or '}' (the object ends); anything else
                # means this ']' is not trustworthy as this array's close.
                identity_ltrim "${rest#\]}"
                case $identity_trimmed in
                    ''|','*|'}'*) break ;;
                    *)
                        echo "identity gate: the '$key' array in '$identity_file' closes with ']' but is followed by something other than ',' or '}' -- not well-formed JSON here. Refusing rather than silently accepting it." >&2
                        return 1
                        ;;
                esac
                ;;
            '"'*)
                token=$(printf '%s' "$rest" | sed -n 's/^\("\([^"\\]\|\\.\)*"\).*/\1/p')
                if [ -z "$token" ]; then
                    echo "identity gate: could not parse a declared '$key' entry in '$identity_file' -- an unterminated or malformed quoted string. Refusing rather than silently dropping it and whatever follows it." >&2
                    return 1
                fi
                inner=${token#\"}
                inner=${inner%\"}
                case $inner in
                    *'\'*)
                        decoded=$(identity_json_unescape "$inner") || {
                            echo "identity gate: a declared '$key' entry in '$identity_file' uses a JSON escape this parser will not decode (a \\uXXXX outside printable ASCII, or \\n/\\r, which would inject a line break into this file's own newline-delimited entry list). Refusing rather than silently building a pattern arm that would never match the entry's plain form. Rewrite the entry using the literal character instead of the escape." >&2
                            return 1
                        }
                        ;;
                    *)
                        # No backslash at all -- the common case for a
                        # plain declared name or email. Skip
                        # identity_json_unescape entirely rather than
                        # forking a subshell to run a loop that would
                        # just copy the string through unchanged: #135's
                        # review found this is most of the branch's added
                        # cost on an ordinary identity file (no escapes
                        # anywhere), separate from the \uXXXX cost above.
                        decoded=$inner
                        ;;
                esac
                printf '%s\n' "$decoded"
                tail=${rest#"$token"}
                ;;
            *)
                echo "identity gate: could not find the closing ']' for '$key' in '$identity_file' -- the declared array is malformed. Refusing rather than silently returning a truncated list." >&2
                return 1
                ;;
        esac
    done
    return 0
}

# Resolves the identity file, derives the workstation username and machine
# hostname, and builds IDENTITY_PATTERN (one grep -iE alternation covering
# every declared name, every declared email, the username, and the
# hostname) plus IDENTITY_CANARIES (one line per entry in that alternation,
# consumed by identity_control below so every arm gets proved, not just
# one).
#
# THREE RETURN STATES, NOT TWO. 0 configured and loaded. 1 configured and
# BROKEN, which is fail-closed with a message on stderr: a file that exists
# and cannot be read, one that is not JSON-shaped, one declaring no names and
# no emails, an environment where the username or hostname cannot be
# discovered, or a declared entry that could never match anything once
# wrapped in \b (see identity_edge_ok below). 2 not configured at all, which
# prints a notice and lets the caller continue.
#
# That third state is a correction made 2026-09-06, and the reasoning matters
# more than the change. Issue #64's mandate reads "the gate exits non-zero
# when its pattern file is missing or unreadable. It must never scan for
# nothing and report clean", and this file implemented it literally, which
# meant a project that installed the harness had every commit refused from
# its first one. The mandate conflated two states. A file that EXISTS and
# cannot be read means something was declared and the gate cannot see it,
# which is dangerous and still refuses. A file that does not exist means no
# identity was declared, and a gate cannot protect an identity nobody named:
# refusing there protects nothing and only blocks.
#
# "Never scan for nothing and report clean" is still honoured, because state 2
# does not report clean. It says on stderr, on every single commit, that
# identity checks are skipped and how to enable them. Silence would be the
# violation; a notice is not.
#
# Export-Account.ps1's own loader warns and continues on a missing identity
# file, and has since before this hook existed. This now agrees with it.
#
# NO ENV-VAR OVERRIDE FOR THE FILE PATH OR THE DERIVED USERNAME/HOSTNAME.
# An earlier revision read CLAUDE_IDENTITY_FILE, IDENTITY_USERNAME_OVERRIDE
# and IDENTITY_HOSTNAME_OVERRIDE ahead of the real sources below, labelled
# "test seams, not operator-facing knobs" in a comment. Nothing enforced
# that label: pointing CLAUDE_IDENTITY_FILE at an empty or unpopulated file
# disabled every channel silently, with the hook still reporting success --
# worse than --no-verify, because a log shows a gate that ran and passed.
# Measured 2026-09-05. Tests get the same coverage a different way: set
# USERPROFILE (and HOME, for the Git-Bash-on-Windows case below) to a
# fixture directory holding a real .claude-account-identity.json, and set
# USERNAME/COMPUTERNAME directly -- both already read below, so a test
# needs no special-cased knob to control them.
identity_load() {
    # Prove the matcher works before ANYTHING trusts it, the parse below
    # included. identity_json_array uses grep to pull values out of the
    # identity file, so a grep that answers "no match" to everything makes a
    # populated file parse as empty -- and every downstream check then reports
    # accurately on a pattern set that was never built. Found by breaking grep
    # deliberately: the empty-arrays guard fired first and blamed the file,
    # which is a confident, wrong diagnosis of a broken tool.
    #
    # A fixed literal, not a value from the file, because at this point the
    # file has not been read and its contents cannot be assumed. Same grep
    # resolved off the same PATH, same -iE invocation as every later scan.
    if ! printf '%s\n' "identity-gate-canary" | grep -qiE 'identity-gate-canary'; then
        echo "identity gate: the matcher did not find its own canary in a fixed literal, before any file was read. grep is broken, shadowed on PATH, or crashing. Refusing rather than trusting anything it says -- 2026-09-05's incident was exactly this shape, a crashed grep -F whose surrounding '|| echo NONE' printed a clean result over the top." >&2
        return 1
    fi

    identity_file=${USERPROFILE:-$HOME}/.claude-account-identity.json

    # NO FILE AT ALL IS "NOT CONFIGURED", NOT "BROKEN", AND THE TWO ARE NOT THE
    # SAME STATE. This returned 1 until 2026-09-06, which meant a project that
    # installed this harness had every commit refused from the first one, with
    # nothing in the Quick Start saying an identity file had to exist. The
    # repository's whole purpose is installing into other projects, so that made
    # the shipped product unusable for its stated job on day one.
    #
    # The conflation was mine to make and worth naming: a missing file means the
    # operator has declared no identity, and a gate cannot protect an identity
    # nobody declared. Refusing there protects nothing; it only blocks. A file
    # that EXISTS and cannot be read is the genuinely dangerous state, because
    # something was declared and the gate cannot see it, and that still refuses
    # below.
    #
    # Return 2 rather than 0 or 1 so callers can tell the three states apart:
    # 0 configured, 1 broken and must refuse, 2 not configured. The notice goes
    # to stderr on every commit rather than staying silent, because a security
    # gate that is off should say so every time and not once.
    if [ ! -f "$identity_file" ]; then
        echo "identity gate: not configured, so identity checks are SKIPPED. To enable them, create '$identity_file' with the shape {\"names\": [...], \"emails\": [...]} naming the strings that must never reach a remote. Until then this hook checks nothing for identifying content." >&2
        return 2
    fi
    if [ ! -r "$identity_file" ]; then
        echo "identity gate: '$identity_file' exists but is not readable." >&2
        return 1
    fi

    raw=$(cat "$identity_file" 2>/dev/null)
    if [ -z "$raw" ]; then
        echo "identity gate: '$identity_file' is empty." >&2
        return 1
    fi
    case $raw in
        *'{'*'}'*) : ;;
        *)
            echo "identity gate: '$identity_file' does not look like a JSON object. A gate must not silently check less than it claims to; fix the file." >&2
            return 1
            ;;
    esac

    # identity_json_array itself already named the file and the specific
    # defect on stderr before returning non-zero (issue #91c, #91d): an
    # unparseable entry or an escape it will not decode. Propagate rather
    # than re-explain -- fail closed either way.
    names=$(identity_json_array "$raw" names) || return 1
    emails=$(identity_json_array "$raw" emails) || return 1

    # Both empty is fail-closed, and the count check further down does not
    # cover it. That check fires only when the WHOLE pattern set is empty, and
    # the username and hostname arms below always contribute because they are
    # derived from the environment rather than read from the file. So a file
    # declaring `{"names": [], "emails": []}` -- or one whose keys got renamed
    # by an edit -- builds a pattern that still matches a username and a
    # hostname, passes the canary, and reports clean on a staged legal name.
    # Measured on 2026-09-05: with both arrays empty, a commit whose content
    # carried the name in the file was allowed.
    #
    # The name is the channel that actually leaked. Thirty commits carried one
    # in author and committer while a content scan of the same repository
    # reported clean, which is the incident this gate exists for. Degrading
    # silently to username-and-hostname is checking less than the gate claims
    # to, and the JSON-shape refusal above already states that rule; this
    # applies it to the case where the file parses and says nothing.
    if [ -z "$names" ] && [ -z "$emails" ]; then
        echo "identity gate: '$identity_file' parsed but declares no names and no emails. A file that names nothing cannot protect the channel this gate exists for -- populate it, or the gate is checking only the username and hostname it derived from the environment." >&2
        return 1
    fi

    # Derived, not read from the identity file: install/Export-Account.ps1's
    # own doc comment on -IdentityFile draws this line already -- the file
    # declares "the identifying strings that cannot be derived from the
    # environment", and a username or hostname is, by definition, sitting
    # right there in the environment the gate is already running in.
    # $USERNAME/$COMPUTERNAME first (Windows env vars Git Bash also
    # exports), because $HOME's leaf -- what the exporter uses -- carries
    # the same Git-Bash-vs-real-profile hazard hooks/pre-commit's own
    # USERPROFILE fallback exists for, and a git hook's inherited
    # environment cannot be assumed to be an interactive Git Bash session.
    username=${USERNAME:-}
    if [ -z "$username" ]; then
        username=$(whoami 2>/dev/null || id -un 2>/dev/null)
    fi
    if [ -z "$username" ]; then
        echo "identity gate: could not derive the workstation username (\$USERNAME unset, whoami and id -un both failed)." >&2
        return 1
    fi

    hostname_val=${COMPUTERNAME:-}
    if [ -z "$hostname_val" ]; then
        hostname_val=$(hostname 2>/dev/null)
    fi
    if [ -z "$hostname_val" ]; then
        echo "identity gate: could not derive the machine hostname (\$COMPUTERNAME unset, hostname failed)." >&2
        return 1
    fi

    entries=$(printf '%s\n%s\n%s\n%s\n' "$names" "$emails" "$username" "$hostname_val")

    # A single newline character, built once here rather than at every
    # accumulation site below. Needed because ${var:+word} requires "word" to
    # be inline text, and the plain single-quoted assignment spanning two
    # physical lines is the ordinary POSIX sh way to get one literal newline
    # into a variable without spawning a subshell for it.
    identity_nl='
'

    pattern=
    canaries=
    count=0
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        if ! identity_edge_ok "$entry"; then
            echo "identity gate: '$identity_file' or the derived username/hostname declares an entry whose first or last character is not a word character. Wrapped in \\b<entry>\\b, an entry like that can never match anything -- a dead arm that would otherwise report healthy from both identity_load and identity_control (finding 9, 2026-09-05: a name pasted as a whole author line, 'Name <email>', or with a trailing space). The offending value is deliberately not printed; check names/emails in '$identity_file' for a pasted author line or stray leading/trailing punctuation or whitespace." >&2
            return 1
        fi
        escaped=$(identity_regex_escape "$entry")
        pattern="${pattern}${pattern:+|}\\b${escaped}\\b"
        canaries="${canaries}${canaries:+$identity_nl}canary-${entry}-canary"
        count=$((count + 1))
    done <<EOF
$entries
EOF

    if [ "$count" -eq 0 ] || [ -z "$pattern" ]; then
        echo "identity gate: built an empty pattern set from '$identity_file' and the environment." >&2
        return 1
    fi

    IDENTITY_PATTERN=$pattern
    IDENTITY_CANARIES=$canaries
    return 0
}

# True (0) when $1's first and last characters are both a "word" character
# ([A-Za-z0-9_], the exact byte class \b tests a transition against in the
# locale this file already runs under -- LANG and LC_ALL both unset,
# though #135's review measured Git for Windows setting LC_CTYPE=C.UTF-8
# regardless of that; grep -E's \b needs no locale either way, per this
# file's own "WHY grep -E's \b" header section, so that does not change
# the byte class \b tests here). \b requires a word/non-word transition
# at that position; a non-word
# character AT either edge of the literal text makes that transition
# impossible for any real content the entry could appear in, so the arm
# this entry builds can never fire. A non-ASCII character at an edge is
# byte-wise non-word here too (every byte of a multi-byte UTF-8 sequence
# has its high bit set, outside [A-Za-z0-9_]) and gets refused for the same
# reason grep's own \b would not treat it as a word character in this
# locale -- the same ASCII-oriented limitation already accepted for case
# folding elsewhere in this file, not a new one, and fail-closed (refusing
# the whole load) rather than silently building a dead arm.
identity_edge_ok() {
    case $1 in
        '') return 1 ;;
        [A-Za-z0-9_]) return 0 ;;
        [A-Za-z0-9_]*[A-Za-z0-9_]) return 0 ;;
        *) return 1 ;;
    esac
}

# Before trusting any negative result from identity_match below, prove the
# exact matcher (same grep binary resolved off PATH, same -iE invocation,
# same pattern variable) still finds a string built from EVERY entry in the
# pattern set, not only one. A single fixed canary (originally just the
# username) proved the matcher works in general but left every other arm
# unproven -- a declared name could be a completely dead arm (identity_edge_ok
# above closes the known way that happens) while this control still reported
# healthy, because it never actually tried to match that arm. This is also
# what would have caught 2026-09-05's incident in the first place: a grep
# that crashes, or a PATH-shadowed grep that silently answers "no match" to
# everything, fails every one of these canaries before either hook ever
# trusts a clean scan.
identity_control() {
    identity_control_ok=1
    while IFS= read -r canary; do
        [ -n "$canary" ] || continue
        if ! printf '%s\n' "$canary" | grep -qiE "$IDENTITY_PATTERN"; then
            identity_control_ok=0
        fi
    done <<EOF
$IDENTITY_CANARIES
EOF
    if [ "$identity_control_ok" -eq 0 ]; then
        echo "identity gate: the matcher did not find the canary for at least one declared entry. Refusing rather than trusting a scan where an arm may be dead -- 2026-09-05's incident was exactly this shape for the whole matcher; this is the same check applied per declared entry, so one dead arm does not read as a healthy gate. The failing entry is deliberately not printed." >&2
        return 1
    fi
    return 0
}

# True (exit 0) when $1 carries any pattern in the resolved set. Never
# echoes $1 or the matched substring: the exporter's own identity gate
# names the file and the class of match and deliberately never the matched
# value, because printing it would put the string this gate exists to
# contain into console output, CI logs, and any transcript of the run. This
# function is the one shared call site every real check below goes through,
# so the exact invocation identity_control just proved works is the one
# that runs against real content.
identity_match() {
    # Not configured (identity_load returned 2, IDENTITY_PATTERN never set):
    # match nothing. Guarding here rather than at each of the six call sites
    # across the two hooks, because a call site added later would not know to
    # guard itself, and an unset pattern handed to `grep -iE` matches every
    # line rather than none -- the failure would be a gate that refuses
    # everything, not one that lets things past, but it is still wrong and it
    # would look like the gate working.
    [ -n "${IDENTITY_PATTERN:-}" ] || return 1
    printf '%s\n' "$1" | grep -qiE "$IDENTITY_PATTERN"
}
