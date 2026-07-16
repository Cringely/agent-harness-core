# Registry as Single Source of Truth

## The problem it solves

An agent harness that lets a planner choose among several actions ends up describing those
actions in at least four places: the prompt that tells the planner what it can do, the schema
that validates what the planner produced, the code that actually executes an action, and
whatever surface (a dashboard, a log formatter, a docs page) explains the action to a human.
Written by hand in four places, those descriptions drift. A required field is added to the
execution code and never makes it into the prompt; a schema field gets renamed but the old name
keeps showing up in a help page. Nothing crashes when this happens; the planner just quietly
produces requests that fail, or worse, requests that succeed with the wrong argument.

## The pattern

Define one entry per action, once, and derive everything else from it. Each entry names the
action, states its kind (does it change state, or only read it), carries a schema for its
parameters, and gives a short label for display. Nothing downstream is allowed to hardcode its own
copy of "what actions exist" or "what parameters they take." The planner's menu of choices, the
step schema that validates a plan, the
dispatcher that runs a step, and the docs page that lists commands for a human all read from the
same table.

```typescript
// pseudo-code: illustrates the shape of one entry, not a runnable schema library
registryEntry = {
  name: "create_order",
  kind: "mutation",           // "mutation" changes state, "query" only reads
  params: { customerId: "string", itemId: "string", quantity: "integer, at least 1" },
  label: "Create an order",
}
```

Everything else derives. The set of steps a plan is allowed to contain is the union of every
mutation entry's schema (queries are excluded from the planner's menu; a read has no business
appearing as a step in a runbook, and the entries stay easy to fetch on demand instead). The
dispatcher's switch statement is a lookup by name into the same table, not a second hand-written
list of cases. The docs page renders straight from the label and schema, so it can never say
something the code disagrees with. None of this is specific to any one language: a struct in Go,
a case class in Kotlin, or a plain dict in Python all support the same idea, which is that one
declarative table is the only place an action's shape is written down, and every consumer reads
it rather than restating it.

## A worked derivation, in TypeScript

The step-schema union mentioned above is not hand-waving; it derives mechanically from the
registry with a filter and a map. Using [Zod](https://zod.dev) for the parameter schemas, a real
registry entry and its derivation look like this:

```typescript
import { z } from "zod";

type RegistryEntry = {
  name: string;
  kind: "mutation" | "query";
  params: z.ZodTypeAny;
  label: string;
};

const REGISTRY: RegistryEntry[] = [
  {
    name: "create_order",
    kind: "mutation",
    params: z.object({
      customerId: z.string(),
      itemId: z.string(),
      quantity: z.number().int().min(1),
    }).strict(),
    label: "Create an order",
  },
  {
    name: "get_order_status",
    kind: "query",
    params: z.object({ orderId: z.string() }).strict(),
    label: "Look up an order",
  },
];

function entryToStepSchema(entry: RegistryEntry) {
  return z.object({
    action: z.literal(entry.name),
    params: entry.params,
  }).strict();
}

// Queries are excluded here, same rule as the prose above: a read has no
// business appearing as a step in a runbook.
const steps = REGISTRY.filter((a) => a.kind === "mutation").map(entryToStepSchema);

const PlanStepSchema = z.union(
  steps as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);
```

Nothing here is Zod-specific or even TypeScript-specific: `filter` by kind, then `map` each
surviving entry into a derived shape, is the whole mechanism, and it reads the same way over a
slice of Go structs or a list of Python dicts with no schema library at all. What has to carry
over to another language is the two-step shape, filter then derive, not the Zod syntax.

## Testing it against the real contract, not just itself

Deriving four artifacts from one table only proves internal consistency; it says nothing about
whether the registry still matches the actual system it calls into. If the external API adds a
required field, or narrows what values a parameter accepts, the registry can be perfectly
self-consistent and still be wrong. Close that gap with a conformance test that checks the
registry against the system's own contract, an OpenAPI document if one exists, in two directions:
every parameter the registry sends must be a parameter the API actually accepts, and every
parameter the API marks required must also be required on the registry's side (not silently
optional). This caught a real gap in the source project: a field was defined as an open string,
the live API rejected an out-of-range value the planner had guessed, and the fix was tightening
the registry's schema to the API's real accepted set rather than patching the rejection after the
fact. That same gap can hide behind any field whose valid range the API defines but the registry
doesn't enforce, not just strings, and each one is a rejection waiting to happen until the
conformance test forces the registry to match reality.

## When not to use it

For a handful of actions, four or five and stable, the machinery is not worth building. Hardcode
the cases directly in each of the few places that need them. The registry pattern earns its cost
once the same action list would otherwise need maintaining in three or more independent places, or
once the action count is large enough that a hand-maintained prompt and a hand-maintained
dispatcher are likely to drift before anyone notices.

## The coupling hazard

The registry itself, the specific entries for "create an order" or "cancel a job", is domain code
that belongs to the project rather than a shared library. What's reusable across projects is the
derivation machinery: the idea that a step schema, a dispatcher, and a docs page all read one
table instead of each maintaining a private copy, and the conformance test that checks the table
against ground truth. A second project brings its own action list and borrows only the shape of
how one table produces the rest.
