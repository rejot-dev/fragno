# Event catalog reference

The event catalog describes known automation event classes. Each entry is identified by a `source`
and `eventType` pair and can provide labels, JSON Schemas, and an example for route authoring and
tool discovery.

The catalog combines two sources:

- **Built-in descriptors** declared by Backoffice capabilities.
- **Dynamic definitions** stored in the current scoped Automations object.

Catalog membership improves discoverability and can validate dynamic payloads. It is not a
closed-world allowlist: Backoffice can ingest an event that has no catalog entry.

## Catalog entry shape

A complete catalog entry has these fields:

| Field           | Type                  | Description                                                   |
| --------------- | --------------------- | ------------------------------------------------------------- |
| `source`        | string                | Producer namespace. Part of the immutable identity.           |
| `eventType`     | string                | Event name within the source. Part of the immutable identity. |
| `label`         | string                | Human-readable name.                                          |
| `description`   | string, optional      | Longer explanation of the event.                              |
| `capabilityId`  | string                | Owning capability, or `dynamic` for scoped definitions.       |
| `payloadSchema` | JSON Schema, optional | Describes the event payload object.                           |
| `actorSchema`   | JSON Schema, optional | Describes expected actor provenance.                          |
| `subjectSchema` | JSON Schema, optional | Describes expected subject metadata.                          |
| `example`       | JSON value, optional  | Example payload.                                              |

Persisted dynamic definitions also expose:

| Field       | Type          | Description                                           |
| ----------- | ------------- | ----------------------------------------------------- |
| `id`        | string        | Encoded `${source}:${eventType}` database identity.   |
| `enabled`   | boolean       | Controls dynamic payload validation during ingestion. |
| `createdAt` | ISO timestamp | Database creation time.                               |
| `updatedAt` | ISO timestamp | Database update time.                                 |

The definition ID encodes each identity segment with `encodeURIComponent` before joining them with
`:`. Consumers should address definitions by source and event type instead of constructing IDs
directly.

## Built-in descriptors

Capabilities declare built-in event descriptors alongside their connection, runtime-tool, hook, and
file contributions. The capability registry converts optional Zod payload, actor, and subject
schemas into JSON Schema for the catalog.

Built-in entries use the declaring capability's ID, for example `auth`, `telegram`, `sandbox`, or
`upload`. They are product-owned and do not live in the `automation_event_definition` table.

Dynamic definitions cannot use a source and event type reserved by a built-in descriptor. Creation
fails with `EVENT_DEFINITION_INVALID` rather than shadowing product behavior.

## Dynamic definitions

Dynamic definitions belong to one Automations scope. The same custom source and event type can have
different definitions in different organization, project, user, or system objects.

A dynamic definition is created from:

```ts
{
  source: string;
  eventType: string;
  label: string;
  description?: string | null;
  payloadSchema?: Record<string, unknown> | null;
  actorSchema?: Record<string, unknown> | null;
  subjectSchema?: Record<string, unknown> | null;
  example?: unknown | null;
  enabled?: boolean; // defaults to true
}
```

`source` and `eventType` are immutable. Updates can change labels, descriptions, schemas, examples,
and enabled state. At least one update field must be present.

The current contract has no dynamic-definition delete operation. Disable a definition when it should
remain discoverable without enforcing payload validation.

## Schema validation

Definition creation and update validate schemas as JSON Schema draft 2020-12 documents.

The service validates:

- payload schema syntax;
- actor schema syntax;
- subject schema syntax;
- the example against the payload schema, when both are present.

An invalid schema or mismatched example raises `AutomationEventDefinitionValidationError`. HTTP
routes expose it as `EVENT_DEFINITION_INVALID` with status 400.

Schema fields accept JSON objects in the route contract. Setting a schema field to `null` removes
that schema.

## Ingestion enforcement

The current ingestion path enforces only the payload schema of a scoped dynamic definition:

| Definition state            | Ingestion behavior                                                    |
| --------------------------- | --------------------------------------------------------------------- |
| No dynamic definition       | Accept the event without catalog payload validation.                  |
| Dynamic definition disabled | Accept the event without catalog payload validation.                  |
| Enabled, no payload schema  | Accept the event without catalog payload validation.                  |
| Enabled with payload schema | Validate `event.payload`; reject invalid payloads before persistence. |

Actor and subject schemas are catalog metadata and authoring aids. The ingestion path validates
their schema syntax when the definition is saved, but it does not currently validate event actors or
subjects against them. Event actors still pass the core trusted actor schema.

Built-in descriptors are also catalog metadata in this ingestion path. Because they are not
persisted as dynamic definitions, `ingestEvent` does not use their payload schemas for this database
lookup. Individual capability boundaries may perform their own input validation before producing an
event.

This distinction is important: a catalog entry documents an event class, while a dynamic enabled
payload schema adds scoped ingestion enforcement.

## Catalog operations

### Runtime tools

The `events` provider exposes:

| Tool                                       | Permission      | Behavior                                                                                   |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------ |
| `events.catalogList({})`                   | `events.read`   | Lists built-in and dynamic source/type pairs without schemas.                              |
| `events.catalogGet({ source, eventType })` | `events.read`   | Returns one complete descriptor with schemas, or `null`. Built-in entries take precedence. |
| `events.catalogCreate(input)`              | `events.manage` | Creates a scoped dynamic definition.                                                       |

There is currently no runtime-tool update or delete operation.

### Fragment routes

The Automations Fragment exposes:

| Method and path                               | Behavior                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `GET /event-definitions`                      | Lists dynamic definitions only, ordered by source and event type. |
| `GET /event-definitions/:source/:eventType`   | Gets one dynamic definition.                                      |
| `POST /event-definitions`                     | Creates a dynamic definition.                                     |
| `PATCH /event-definitions/:source/:eventType` | Updates mutable definition fields.                                |

These routes do not return built-in descriptors. The combined catalog view comes from the Backoffice
capability runtime or the catalog UI.

## Ordering and precedence

The combined list appends dynamic definitions to built-in descriptors and consumers generally sort
by source and event type for presentation.

`catalogGet` checks built-in descriptors first, then the scoped dynamic table. Dynamic creation
rejects built-in identities, so this precedence cannot normally hide a valid dynamic definition.

The dynamic table has a unique index on `(source, eventType)`. Duplicate creation returns
`EVENT_DEFINITION_CONFLICT` with status 409.

## Error reference

| Code                         | Status | Condition                                                       |
| ---------------------------- | ------ | --------------------------------------------------------------- |
| `EVENT_DEFINITION_INVALID`   | 400    | Reserved built-in identity, invalid schema, or invalid example. |
| `EVENT_DEFINITION_CONFLICT`  | 409    | Dynamic source/type already exists.                             |
| `EVENT_DEFINITION_NOT_FOUND` | 404    | Get or update could not find the dynamic definition.            |

Input-schema errors can also produce the framework's standard validation response.

## Related documents

- [About events](README.md)
- [Automation router](../automations/router.md)
- [About integrations](../interfaces/integrations.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/event-definitions.ts` — definition schemas and validation.
- `apps/backoffice/app/fragno/automation/event-definitions-storage-runtime.ts` — dynamic persistence
  and built-in reservation.
- `apps/backoffice/app/fragno/automation/event-definition-routes.ts` — dynamic definition routes.
- `apps/backoffice/app/fragno/automation/definition.ts` — dynamic payload enforcement during
  ingestion.
- `apps/backoffice/app/fragno/backoffice-capabilities/backoffice-capabilities.ts` — built-in
  descriptor registry.
- `apps/backoffice/app/fragno/backoffice-capabilities/capabilities/` — capability declarations.
- `apps/backoffice/app/fragno/runtime-tools/families/backoffice-capabilities.ts` — combined catalog
  tools.
- `apps/backoffice/app/routes/backoffice/automations/events-catalog.tsx` — combined catalog UI.
