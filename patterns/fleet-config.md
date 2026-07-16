# Fleet Config

## The problem it solves

Running several independent agents from one harness means each agent needs its identity, its
judgment style, its thresholds, and its model choice declared somewhere a human can read and
change without touching code. A typo or a nonsensical combination of settings should fail loudly
at startup, not misconfigure an agent that then behaves strangely for hours before anyone connects
the behavior back to a bad config line.

## The shape of one agent entry

Each agent in the config file gets an id, a persona (prose describing its priorities and style,
read by the planner as flavor rather than as a hard rule), a planner spec naming which model backs
its decisions, an optional fallback planner to fall back to, a set of numeric thresholds that
govern when it should act, an optional block of zero-cost reflex rules, and an optional experiment
block for trying a different planner on a machine-checked trial basis. A representative entry,
genericized to a neutral job-processing domain:

```yaml
agents:
  - id: worker-1
    persona: >
      A cautious job processor. Priorities: finish the current batch before
      starting another, retry a failed step twice before escalating, never
      touch a job outside its assigned queue.
    planner: { provider: hosted, model: standard-tier }
    fallback_planner: { provider: local, model: small-model }
    thresholds:
      escalate_after_failures: 5
    reflex:
      auto_retry_below: 3
    experiment:
      revert_if_no: throughput
      within_hours: 12
```

Persona is style, not a channel for durable objectives: if the harness has a separate structured
field for standing goals, a goal written only into the persona prose is invisible to whatever code
reads goals, and stays invisible until someone notices the agent never acted on it.

## Fail at load, not at first use

The schema rejects unknown fields rather than silently ignoring them, and it rejects fields typed
or ranged wrong rather than coercing them into something plausible. A second pass at load checks
combinations that a single field's schema can't express on its own: an experiment block that names
no fallback to revert to is a config that promises a safety net it doesn't actually have, and
that should be an error at startup, not a surprise the first time the experiment tries to trip and
finds nothing to fall back onto. The same philosophy extends to any mode the harness can't fully
execute yet: a driver mode with no execution path behind it should refuse to load rather than
silently running the default mode while the config claims otherwise.

## Machine-evaluated revert conditions

An experiment, trying a cheaper or different model on one agent to see if it holds up, needs an
exit condition a program checks on a schedule, not a note in the config that depends on a human
remembering to look. The block names one progress signal from a fixed allowlist (or the sum of all
of them), and a time window. If that signal hasn't advanced within the window, the harness latches
the agent onto its fallback planner and records that the switch happened. This is one-way: it
doesn't flip back on its own once the trip fires, only when a human edits the block again. Naming
the fallback as a required sibling field, not a separate lookup elsewhere, is what makes this
enforceable at load: the load check can already reject an experiment that names no fallback.

## The `_file` secret convention

A field that needs a credential, an API key for a hosted planner, a bearer token for a private
endpoint, never accepts the value inline in the config. Instead it takes a path, suffixed `_file`,
to a file under a secrets directory that holds the actual value. The config file itself, which
often ends up committed or shared, never carries anything sensitive; only a path does. This is the
same convention security guidance already asks for around any credential in a bind-mounted or
version-controlled file, applied here to per-agent planner secrets.

## When not to use it

A single agent with settings that rarely change doesn't need a schema, a fallback chain, or an
experiment block: hardcoding a handful of values costs less than building the machinery to validate
them. The pattern earns its cost once there's more than a couple of agents, once more than one
person edits the config, or once a bad value in it can silently misdirect an agent for hours before
anyone notices.
