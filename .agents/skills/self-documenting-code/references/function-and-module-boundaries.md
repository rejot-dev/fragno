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

## Name inline behavior without hiding its flow

Naming does not require extraction. Keep a named function inline when the behavior belongs to one
declaration and moving it would hide the configured lifecycle.

### Positive — Name a configuration-owned callback inline

```ts
const fragment = createAuthFragment({
  hooks: {
    onUserCreated: async function queueUserSignUpVerificationEmail(payload, context) {
      if (payload.emailVerifiedAt !== null) {
        return;
      }

      const verification = await otp.issueForUser(payload.user.id, context.hookId);
      await email.queueVerification(payload.user.email, verification.url);
    },
  },
});
```

The function name provides domain vocabulary and useful stack traces. Keeping its body beside the
hook declaration lets a reader understand the configured signup lifecycle without jumping to another
location.

### Negative — Extract only to shorten the declaration

```ts
const fragment = createAuthFragment({
  hooks: {
    onUserCreated: queueUserSignUpVerificationEmail,
  },
});
```

When the extracted function has one caller, no independent contract, and no reuse or focused testing
value, this indirection makes the lifecycle harder to follow. Extract it when the behavior becomes a
shared rule, independently testable operation, or substantial distraction from the declaration.

## Keep orchestration in the pragmatic shell

Entry points should expose the sequence while semantic functions own stable rules.

### Positive — Orchestrate named domain operations

```ts
export async function handleInviteAcceptance(
  input: AcceptInviteInput,
  dependencies: InviteDependencies,
) {
  const invite = await dependencies.invites.find(input.inviteId);
  assertInviteCanBeAccepted(invite);

  const membership = createMembershipFromInvite(invite);
  await dependencies.memberships.save(membership);

  return serializeMembership(membership);
}
```

The handler may change as the use case evolves. The invariant and domain construction remain
independently named and testable. If expiration also guards acceptance, enforce it against database
time inside the database unit of work rather than passing the process clock into this orchestration.

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

Boundaries are clear when meaningful behavior is named, extraction adds an independent contract,
configuration-owned callbacks remain local when locality makes the lifecycle obvious, orchestration
reads as a sequence of domain operations, each symbol has one definition and name, package exports
point to defining files, and every caller uses the current API directly.
