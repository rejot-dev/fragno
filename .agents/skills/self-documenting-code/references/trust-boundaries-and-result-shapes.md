# Trust boundaries and result shapes

Use these examples when deciding how to resolve `unknown`, where runtime validation belongs, how
internal values retain their types, or what a database operation should return.

## Resolve `unknown` at acquisition

Every `unknown` value has exactly two paths at the point where it enters the code:

1. **Cast immediately** when the source contract is trusted and only its static type is incomplete.
2. **Parse or validate immediately** when the runtime value must earn trust.

### Positive — Cast a trusted source immediately

```ts
const actor = providerEvent.actor as EventActor;
```

The cast sits beside acquisition and records the trust decision. Downstream functions receive
`EventActor`, rather than carrying `unknown` and rediscovering that trust later.

### Positive — Validate an untrusted source immediately

```ts
const input = requestSchema.parse(await request.json());
```

HTTP, environment variables, files, queues, and external payloads typically earn trust through
validation. Internal code then uses the parsed type directly.

## Establish trust once

### Negative — Revalidate trusted internal data

The second parse obscures that `stored` is already trusted and typed.

```ts
const input = requestSchema.parse(await request.json());
const stored = await repository.find(input.id);

return publicRecordSchema.parse({
  ...stored,
  createdAt: stored.createdAt.toISOString(),
});
```

### Positive — Establish trust at acquisition

```ts
const input = requestSchema.parse(await request.json());
const stored = await repository.find(input.id);

return {
  id: stored.id.valueOf(),
  title: stored.title,
  createdAt: stored.createdAt.toISOString(),
};
```

The trust transition happens once. The result mapping remains visible and statically checked.

## Program to established trust

Once a boundary establishes a precise type, internal consumers should use that contract directly.

### Negative — Recheck an established type

These checks contradict the function's declared input contract and hide producer defects behind
fallback behavior.

```ts
function membershipName(membership: Membership) {
  if (membership && typeof membership.name === "string" && membership.name.length > 0) {
    return membership.name;
  }

  return "Unknown membership";
}
```

### Positive — Rely on the established contract

```ts
function membershipName(membership: Membership) {
  return membership.name;
}
```

If `name` can truly be absent, represent that state in `Membership` and handle it exhaustively. If
absence violates the model, fix the producer that constructed the invalid value.

Checks still belong where uncertainty is real: domain invariants, missing records, concurrency
conflicts, external calls, and other failures represented by the system's contracts. Established
shape and type information should not be re-proven downstream.

## Fix types at their source

A field with a known domain type should acquire that type in the schema or adapter that creates it.

### Negative — Recover weak types downstream

Repeated parsing and casting make every consumer re-establish the same trust decision.

```ts
const labels = labelsSchema.parse(row.labels);
const actor = row.actor as EventActor;
```

### Positive — Establish types at their source

```ts
const records = table("records")
  .addColumn("labels", jsonColumn<string[]>())
  .addColumn("actor", jsonColumn<EventActor>());

const labels = row.labels;
const actor = row.actor;
```

Prefer improving the source type over adding repeated casts, preprocessors, or conversion helpers to
consumers.

## Use the concrete type directly

When a value already has a precise type, its native operations communicate the transformation.

### Positive — Use native operations

```ts
return {
  id: row.id.valueOf(),
  createdAt: row.createdAt.toISOString(),
};
```

Extra `String(...)` calls, timestamp normalizers, or intermediate `unknown` values weaken the
visible contract.

## Keep obvious mappings local

A short one-off mapping is usually clearest at its use site.

### Positive — Keep the mapping visible

```ts
return rows.map((row) => ({
  id: row.id.valueOf(),
  title: row.title,
  labels: row.labels ?? [],
  createdAt: row.createdAt.toISOString(),
}));
```

Extract a mapper when it represents a shared public contract or meaningful domain transformation.
Keep it inline when the helper would merely move these assignments elsewhere.

## Return resolved mutation values

A mutation result should contain values known at the point of mutation. Generated identifiers and
input values are usually resolved immediately; database expressions may be resolved only after
execution.

### Positive — Return only resolved values

```ts
const createdId = unitOfWork.create("records", {
  title,
  createdAt: unitOfWork.now(),
});

return {
  id: createdId.valueOf(),
  title,
};
```

Preserve useful resolved fields. Introduce timestamps or computed columns into the public result
after a read has produced their concrete values.

## Read for the decision being made

An operation should retrieve the state needed for its own invariants and result, rather than
constructing a complete public model as an intermediate step.

### Positive — Select operation dependencies

```ts
const existing = await records.find(id, {
  select: ["id", "status", "labels"],
});

assertTransitionAllowed(existing.status, nextStatus);
const labels = mergeLabels(existing.labels, requestedLabels);
```

The selected fields reveal the operation's actual dependencies.

## Review criterion

The boundary is clear when every obtained `unknown` is cast or validated immediately, each cast
names a trusted source contract, each parse protects an untrusted value, downstream code relies on
the resulting precise type without defensive shape checks or fallback coercions, genuine domain and
operational failures remain explicit, local mappings remain visible, reads expose only operation
dependencies, and results distinguish resolved values from pending database expressions.
