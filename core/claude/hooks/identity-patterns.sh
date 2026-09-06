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
# LC_ALL=C.UTF-8 first makes it work. A check whose engine can refuse to run
# depending on the caller's locale is exactly the failure this file exists
# to close, so -P is not used anywhere here. GNU grep -E's `\b` extension
# needs no locale. Measured against the exact collision the exporter's own
# comment and its Export-Account.Tests.ps1 fixture record (Export-Account.
# Tests.ps1's "does not read a declared name out of an ordinary word that
# contains it"): skills/owasp-llm/references/08-vector-and-embedding-
# weaknesses.md:117 reads "adjusting the augmentation process", which
# contains the operator's declared first name as a substring. That test
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

# Pulls every double-quoted string out of a JSON array value for $2 ("names"
# or "emails") in the raw text $1, one per output line. No jq dependency,
# matching session-start-drift-check.sh's precedent (jq ships with neither
# this repo nor Git for Windows). Handles the array spanning multiple lines
# by flattening newlines to spaces first; does not attempt general JSON
# parsing beyond the flat {"key": ["a", "b"]} shape
# install/Export-Account.ps1's -IdentityFile doc declares. An absent key or
# an empty array both produce no output, which the caller treats as "zero
# declared entries in this category", not as a malformed file.
identity_json_array() {
    raw=$1
    key=$2
    flat=$(printf '%s' "$raw" | tr '\n' ' ')
    seg=$(printf '%s' "$flat" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p")
    [ -n "$seg" ] || return 0
    printf '%s' "$seg" | grep -o '"\([^"\\]\|\\.\)*"' | sed 's/^"//; s/"$//; s/\\"/"/g'
}

# Resolves the identity file, derives the workstation username and machine
# hostname, and builds IDENTITY_PATTERN (one grep -iE alternation covering
# every declared name, every declared email, the username, and the
# hostname) plus IDENTITY_CANARY (one concrete value guaranteed to be in the
# pattern set, consumed by identity_control below). Every failure mode is
# fail-closed with a message on stderr and a non-zero return: a missing or
# unreadable file, a file that is not JSON-shaped, or an environment where
# the username or hostname cannot be discovered. This is deliberately
# stricter than Export-Account.ps1's own loader, which warns and continues
# on a missing identity file because its derived-username arm still runs
# either way -- issue #64's mandate for this gate is explicit: "the gate
# exits non-zero when its pattern file is missing or unreadable. It must
# never scan for nothing and report clean."
#
# CLAUDE_IDENTITY_FILE, IDENTITY_USERNAME_OVERRIDE and
# IDENTITY_HOSTNAME_OVERRIDE are test seams, not operator-facing knobs --
# nothing in install/Install-Harness.ps1 sets them. Real runs resolve the
# file from ${USERPROFILE:-$HOME}, the same precedence hooks/pre-commit
# already uses for the reason recorded there: Git Bash's $HOME can point at
# a Documents subfolder rather than the real Windows profile that
# .claude-account-identity.json actually lives under.
identity_load() {
    identity_file=${CLAUDE_IDENTITY_FILE:-${USERPROFILE:-$HOME}/.claude-account-identity.json}

    if [ ! -f "$identity_file" ]; then
        echo "identity gate: no identity file at '$identity_file'. Refusing to scan for nothing and report clean -- see install/Export-Account.ps1's -IdentityFile doc for the shape ({\"names\": [...], \"emails\": [...]})." >&2
        return 1
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

    names=$(identity_json_array "$raw" names)
    emails=$(identity_json_array "$raw" emails)

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
    username=${IDENTITY_USERNAME_OVERRIDE:-${USERNAME:-}}
    if [ -z "$username" ]; then
        username=$(whoami 2>/dev/null || id -un 2>/dev/null)
    fi
    if [ -z "$username" ]; then
        echo "identity gate: could not derive the workstation username (\$USERNAME unset, whoami and id -un both failed)." >&2
        return 1
    fi

    hostname_val=${IDENTITY_HOSTNAME_OVERRIDE:-${COMPUTERNAME:-}}
    if [ -z "$hostname_val" ]; then
        hostname_val=$(hostname 2>/dev/null)
    fi
    if [ -z "$hostname_val" ]; then
        echo "identity gate: could not derive the machine hostname (\$COMPUTERNAME unset, hostname failed)." >&2
        return 1
    fi

    entries=$(printf '%s\n%s\n%s\n%s\n' "$names" "$emails" "$username" "$hostname_val")

    pattern=
    count=0
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        escaped=$(identity_regex_escape "$entry")
        pattern="${pattern}${pattern:+|}\\b${escaped}\\b"
        count=$((count + 1))
    done <<EOF
$entries
EOF

    if [ "$count" -eq 0 ] || [ -z "$pattern" ]; then
        echo "identity gate: built an empty pattern set from '$identity_file' and the environment." >&2
        return 1
    fi

    IDENTITY_PATTERN=$pattern
    IDENTITY_CANARY=$username
    return 0
}

# Before trusting any negative result from identity_match below, prove the
# exact matcher (same grep binary resolved off PATH, same -iE invocation,
# same pattern variable) still finds a string built from a real entry in the
# pattern set. This is what would have caught 2026-09-05's incident: a grep
# that crashes, or a PATH-shadowed grep that silently answers "no match" to
# everything, fails this check before either hook ever trusts a clean scan.
identity_control() {
    canary="canary-${IDENTITY_CANARY}-canary"
    if ! printf '%s\n' "$canary" | grep -qiE "$IDENTITY_PATTERN"; then
        echo "identity gate: the matcher did not find its own canary string. Refusing rather than trusting a scan that may not have actually run -- 2026-09-05's incident was exactly this shape, a crashed grep -F whose surrounding '|| echo NONE' printed a clean result over the top." >&2
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
    printf '%s\n' "$1" | grep -qiE "$IDENTITY_PATTERN"
}
