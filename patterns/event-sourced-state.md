# Event-Sourced State

## One table, several consumers

Every step an agent takes, waking up, calling the planner, running a plan step, hitting an
error, gets appended as a row to one events table: an agent id, a timestamp, a type string, and a
JSON payload. Nothing is ever updated or deleted from it in normal operation. That single append-
only log turns out to answer several unrelated questions at once, because each of them is really
just a different query over the same rows.

A live dashboard feed is nothing more than the most recent rows for an agent, newest first, and a
cost ledger is a sum over the payloads of one event type (a planner call) within a time window.
Crash recovery reads the log back on startup and rebuilds whatever in-memory state depended on it.
A restart-safe rate check, "how many times has this agent replanned in the last hour", is a single
indexed count query against the same table rather than a counter kept in memory, which would reset
to zero on every restart and let exactly the kind of burst a rate ceiling exists to catch slip
through right after a deploy. All four consumers read the same rows; none of them owns a private
copy of the state.

## Schema-tolerant loading

Schemas tighten over time: a field that used to accept anything gets narrowed to a fixed set of
values, or a required field is added. That's a normal, healthy change, but anything persisted
under the old, looser schema can fail to parse under the new one: a stored plan written by
yesterday's build might
no longer parse under today's schema. If the loader lets that parse failure throw, the whole
process can crash on startup and keep crashing every time it retries, since the same bad row is
still sitting there waiting to be read again.

The fix is to treat every load of persisted data as something that can fail, and to fail soft: catch
the parse error, log it, record an event noting the row was discarded and why, delete the bad row so
it can't cause the same crash next time, and fall back to a safe default (no plan loaded, in this
case, so the agent starts clean and replans on its next natural wake). A schema change should be
free to happen; old data failing to load under a new schema should never be able to take the whole
process down with it.

## WAL SQLite as the default

For a single process driving its own event log, a full database server is more infrastructure than
the job needs. A single file, opened with write-ahead logging (`PRAGMA journal_mode = WAL`), gives
concurrent readers a consistent view while a writer is appending, survives a restart with the file
intact, and needs nothing running alongside the process to keep it up. This is a default, not a
ceiling: a project outgrowing one file's write throughput, or one that already runs a shared
database for other reasons, can swap the storage layer without touching the pattern; the pattern
only asks for an append-only log with an index on (agent id, timestamp) it can query cheaply.

## Cost metering at the planner seam

The one place spend actually happens in this design is the planner call, so that is the one place
cost gets measured, rather than scattered estimation logic spread across the codebase. On every
successful planner call, the harness captures the character count of what went in and what came
back, and turns that into an approximate token count with a fixed rough ratio (characters divided
by a constant is close enough for a comparability figure, not exact enough to bill against). That
estimate is priced through a small table of per-model input and output rates and summed into a
running cost figure.

Two things keep this honest rather than misleading. First, it is documented as an estimate: many
model subscriptions report no real token usage at all, so this number answers "what would these
calls cost at public rates," useful for comparing agents against each other, not "what was actually
billed." Second, a model missing from the price table falls back to a zero rate rather than a
guessed one; that's the correct default for a self-hosted or local model with no real per-token
cost, and a wrong guess would be worse than an honest zero.

## Deploy markers

One more event type belongs in the same table: a marker written once per agent at process startup,
carrying a build identifier (an image tag from the environment if one exists, otherwise a
timestamp-based fallback so every restart is still distinguishable from the last). Because it
lands in the same table as everything else, no new plumbing is needed to use it: any chart already
built from event history (a core business metric over time, replan rate over time) can overlay
these markers as vertical lines. Answering "did the last deploy actually fix the problem" becomes a
matter of looking at the chart on either side of the line instead of guessing from memory.
