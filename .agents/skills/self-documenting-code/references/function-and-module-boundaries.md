# Function and module boundaries

Use these examples when deciding whether to extract a function, where orchestration belongs, how
packages expose files, or how to complete a breaking API change.

## Extract meaning, inline mechanics

A semantic function earns its boundary by naming a domain operation or invariant.

### Positive — Extract a domain operation

```ts
const renewalDate = calculateSubscriptionRenewalDate({
  currentPeriod,
  billingAnchor,
  planInterval,
});
```

A short mechanical mapping often reads better inline.

### Positive — Inline a mechanical transformation

```ts
return rows.map((row) => ({
  id: row.id.valueOf(),
  name: row.name,
}));
```

A helper such as `normalizeRow`, used once and containing only these assignments, hides data flow
without adding domain vocabulary.

## Keep orchestration in the pragmatic shell

Entry points should expose the sequence while semantic functions own stable rules.

### Positive — Orchestrate named domain operations

```ts
export async function handleInviteAcceptance(
  input: AcceptInviteInput,
  dependencies: InviteDependencies,
) {
  const invite = await dependencies.invites.find(input.inviteId);
  assertInviteCanBeAccepted(invite, dependencies.clock.now());

  const membership = createMembershipFromInvite(invite);
  await dependencies.memberships.save(membership);

  return serializeMembership(membership);
}
```

The handler may change as the use case evolves. The invariant and domain construction remain
independently named and testable.

## Give every export one canonical path

Expose defining files directly from the package export map.

### Positive — Export defining files directly

```json
{
  "exports": {
    "./workspace": "./src/workspace.ts",
    "./membership": "./src/membership.ts"
  }
}
```

Consumers import from the path that owns the symbol.

### Positive — Import from the owning path

```ts
import { createWorkspace } from "@example/package/workspace";
```

This path leads directly to `src/workspace.ts`. An `index.ts`, forwarding module, or re-export chain
makes ownership and repository search less direct.

## Keep one name for one concept

A rename should migrate the definition and every caller together.

### Positive — Complete the breaking rename

```ts
export function createWorkspace(input: CreateWorkspaceInput) {
  // ...
}
```

All consumers move to `createWorkspace`.

### Negative — Preserve a compatibility alias

This alias creates a second name and source path for the same concept:

```ts
export { createWorkspace as provisionWorkspace };
```

During pre-1.0 development, use full breaking changes to converge on the clearest API rather than
carrying transitional names.

## Separate public paths from aggregators

A package may expose several public paths without collecting them into a barrel.

### Positive — Map cohesive public paths directly

```json
{
  "exports": {
    "./client": "./src/client.ts",
    "./server": "./src/server.ts",
    "./schema": "./src/schema.ts"
  }
}
```

Each public path should correspond to a cohesive module with an authoritative implementation, rather
than an alias for symbols owned elsewhere.

## Review criterion

Boundaries are clear when extracted functions add domain meaning, orchestration reads as a sequence
of those meanings, each symbol has one definition and name, package exports point to defining files,
and every caller uses the current API directly.
