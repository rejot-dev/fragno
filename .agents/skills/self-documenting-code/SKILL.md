---
name: self-documenting-code
description:
  Write self-documenting code when creating or refactoring functions, shaping models or schemas,
  designing query or transaction flows, validating boundaries, constructing result shapes, exposing
  package APIs, making code testable with concrete collaborators, or documenting non-obvious
  behavior.
---

# Self-documenting code

Build a **semantic core** inside a **pragmatic shell**. Let types, data flow, and boundaries explain
the system.

Load the matching reference before working on its branch:

- For runtime validation, internal storage types, result mapping, or mutation return shapes, read
  [`references/trust-boundaries-and-result-shapes.md`](references/trust-boundaries-and-result-shapes.md).
- For function extraction, orchestration boundaries, direct imports, package exports, or breaking
  API migrations, read
  [`references/function-and-module-boundaries.md`](references/function-and-module-boundaries.md).
- For dependency design, mock-free tests, deterministic implementations, or test placement, read
  [`references/concrete-testing.md`](references/concrete-testing.md).

## 1. Map the behavior

Before shaping persistent data, identify:

1. what must be stored;
2. which entry points expose it;
3. which records each entry point reads together;
4. which invariants guard its writes;
5. which side effects continue asynchronously.

Treat each read path as a graph the model must support explicitly. Design the schema from actual
behavior rather than isolated record shapes.

**Complete when:** every changed entry point has an accounted-for read graph, write boundary,
invariant set, and side-effect destination.

## 2. Shape the models

Give each model one precise domain meaning. Its name should make every field feel inevitable.

- Represent distinct states with distinct types.
- Prefer required fields and discriminated variants over loosely related optional fields.
- Compose independent concepts instead of flattening them into one model.
- Brand structurally identical primitives when swapping them would be a domain error.
- Give records one clear application-facing identity; keep storage metadata an implementation
  detail.
- Encode known domain types at the schema boundary, including structured or JSON-backed fields.
- Split a model when its fields no longer cohere around its name.

For persistent models, encode every required traversal as an explicit relation. Add an index for
each filter, ordering, join, uniqueness check, and pagination path. A relation expresses meaning;
its indexes make that meaning operationally viable.

**Complete when:** every changed model excludes invalid field combinations, distinguishes
incompatible domain values, contains only fields implied by its name, and supports every required
access path explicitly and efficiently.

## 3. Build the semantic core

Give well-defined operations names. Extract them into **semantic functions** when they own an
independent boundary. A semantic function:

- has a name that states its domain operation;
- receives every required input explicitly;
- returns every result needed by its caller;
- limits side effects to those named by the operation;
- composes safely without knowledge of its internals;
- is small enough for focused unit tests.

Naming and extraction are separate decisions. A named inline function is often clearest when a
callback has one configuration-owned caller and its placement makes the surrounding lifecycle or
orchestration obvious. This is especially useful in hook registries, route tables, workflow
definitions, and similar declarative APIs:

```ts
hooks: {
  onUserCreated: async function queueUserSignUpVerificationEmail(payload, context) {
    // The complete configured behavior remains visible here.
  },
}
```

Extract a function when it is reused, owns independently meaningful rules, requires focused testing,
or makes its containing flow difficult to scan. Do not extract solely because a block can be given a
domain-oriented name. Compose recurring flows from semantic functions rather than duplicating their
internals. Keep short mechanical transformations inline when a helper would only rename the mapping
and hide its data flow.

**Complete when:** meaningful operations are named, reusable rules and independently meaningful
calculations have explicit boundaries, and each operation is placed where the owning flow is easiest
to understand. Extraction adds independence rather than merely reducing indentation.

## 4. Respect trust boundaries

Resolve every `unknown` value immediately where it is obtained. Choose exactly one boundary
operation:

- **cast immediately** when the source contract is trusted but its static type is incomplete;
- **parse or validate immediately** when the value itself must earn trust.

The resulting precise type crosses into internal code and remains authoritative through downstream
layers. The cast or parse marks the exact point where trust was established.

**Program to established trust.** Internal code uses that precise contract directly. When a
downstream consumer appears to need shape checks, fallback coercions, optional access for required
fields, or catch-and-continue handling, strengthen the producer's type or boundary instead. Keep
checks that represent genuine domain invariants or operational uncertainty, such as absent records,
concurrency conflicts, and external failures.

Construct known result shapes directly:

- map typed records into public shapes with explicit local object construction;
- use native operations provided by the known type;
- query only the fields required for the decision or mutation;
- return immediately known mutation values directly, including generated identifiers;
- omit values represented only by unresolved database expressions until a later read resolves them;
- strengthen weak types at their schema or adapter source rather than compensating in every
  consumer.

**Complete when:** every obtained `unknown` is cast or validated at its acquisition boundary,
downstream code relies on the resulting authoritative type without defensive shape checks or
fallback coercions, genuine domain and operational failures remain explicit, reads fetch only
operation-relevant state, and returned shapes contain all useful resolved values without pretending
unresolved values are concrete.

## 5. Keep definitions canonical

Give each concept one definition, one name, and one direct import path.

- Import a symbol from the file that defines it.
- Expose package entry points by mapping public paths directly to defining files.
- Update consumers to the clearest current API instead of preserving compatibility names, path
  aliases, forwarding modules, or re-exports.
- During pre-1.0 development, assume full breaking changes: choose the cleanest current design and
  migrate all callers atomically.

Canonical paths make ownership visible: a reader can follow an import directly to the
implementation, and repository search finds every consumer without resolving indirection.

**Complete when:** every changed symbol has one authoritative definition and public path, all
consumers use its current name directly, and obsolete compatibility layers have been removed.

## 6. Design for concrete tests

Make dependencies explicit so tests can assemble the operation with concrete collaborators. Pass
clocks, identity generators, storage, transports, and external services through visible boundaries
rather than acquiring them from hidden global state.

Favor pure semantic functions and small adapters around infrastructure. Provide lightweight local or
in-memory implementations of dependency contracts where useful, and exercise the same public
behavior production uses. This keeps module interception, monkey-patching, and behavioral mocks
unnecessary.

Co-locate each test with the source it specifies so behavior and verification move together, such as
`route.ts` beside `route.test.ts`.

**Complete when:** changed behavior is testable through explicit inputs and concrete collaborators,
tests sit beside their source, and the same production paths run under test.

## 7. Make transactions read like plans

Express a state change as one coherent unit of work:

1. schedule all required reads upfront;
2. derive decisions from the retrieved snapshot;
3. validate permissions and invariants;
4. apply the writes;
5. enqueue post-commit effects.

Prefer one transaction or database round-trip per operation. Retrieve related data together through
the modeled query graph, then derive locally. Keep external or long-running work outside the
transaction. When an operation genuinely requires **retrieve → external work → mutate**, make that
split explicit in its structure and naming.

**Use database time as the single source of truth for database-coordinated time.** Timestamps used
for persistence lifecycle, scheduling, leases, expiration, or transaction invariants should be
generated and compared inside the database unit of work. Do not mix process time with database time
within the same decision. Preserve externally owned timestamps as separate facts, and use revisions
or sequences—not wall-clock time—for causal ordering.

**Complete when:** every database-dependent decision is backed by an upfront read, every write
follows its validation, and each operation has the smallest explicit transaction boundary that
preserves consistency.

## 8. Contain the pragmatic shell

Keep endpoint handlers, jobs, provisioning flows, and other orchestration in **pragmatic
functions**. Their names should identify the use case or entry point.

Assign each boundary one role:

- **entry points** parse and validate input, establish context, map errors, and serialize responses;
- **services** coordinate reads, permissions, invariants, and writes within the unit of work;
- **background handlers** perform external calls, retries, and long-running side effects after
  commit;
- **serializers** translate internal records into stable public shapes.

For inbound events, make the synchronous path acknowledge durable intent: validate the event,
enqueue its full work item with a deterministic identity when deduplication matters, and return. Let
the background handler own external calls and subsequent state changes.

Pragmatic functions should delegate stable domain rules to the semantic core. When callers depend on
part of an orchestration function, extract that behavior as a semantic function instead of widening
the orchestration function's incidental contract.

Configuration should reveal its lifecycle locally. Keep a named callback inline when moving it would
force readers away from a hook registry, route table, workflow definition, or similar declaration to
understand the configured behavior. Extract the callback when it has an independent contract rather
than merely to shorten the declaration.

**Complete when:** orchestration reads as a sequence of named domain operations, shared callers
depend on semantic functions, asynchronous effects have an explicit durable handoff, and declarative
configuration keeps locally owned behavior visible.

## 9. Add comments for surprises

Prefer names, types, models, and boundaries as the explanation. Use comments for information the
code cannot express clearly: a counterintuitive invariant, external constraint, compatibility
reason, or deliberate tradeoff.

Place the explanation beside the code it governs. State the reason or surprising behavior rather
than paraphrasing the implementation.

**Complete when:** every retained comment contributes information absent from the code, and every
non-obvious constraint a maintainer needs is documented at its point of use.
