# About events

Automation events are the common envelope through which Backoffice capabilities, integrations,
schedules, workflows, and users describe something that happened. Routes consume that envelope
without depending on the component that produced it.

An event is both a routing input and an audit record. Backoffice persists the event before it
performs route actions, so later workflow or forwarding failures do not erase the fact that the
event was accepted.

## Event envelope

Every event has these fields:

| Field        | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `id`         | Stable event identity within the scoped Automations object.                      |
| `scope`      | System, organization, project, or user scope in which routing occurs.            |
| `source`     | Namespace of the producer, such as `telegram`, `auth`, `scheduler`, or `custom`. |
| `eventType`  | Source-local event name, such as `message.received` or `schedule.triggered`.     |
| `occurredAt` | ISO timestamp for when the source says the event occurred.                       |
| `payload`    | JSON object containing event-specific data.                                      |
| `actors`     | Trusted provenance: initiator, optional principal, and delegation chain.         |
| `subject`    | Optional IDs or other metadata identifying the entities affected by the event.   |

`source` and `eventType` form the routing and catalog identity. Event IDs identify occurrences, not
event classes.

`occurredAt` differs from the database-generated `createdAt` on a stored event record. The first
represents source time; the second records when the Automations object persisted the event.

## Scope controls routing and storage

The event scope selects the Automations object that stores and routes the event. Events do not enter
a global queue and acquire scope later.

A route-started workflow stays in the event's scope. Cross-scope delivery requires one of two
explicit paths:

- a router `forward_event` action; or
- `events.fire` with `targetScope`.

Both paths use the Backoffice kernel. Router forwarding verifies that the Automations owner may
target the requested scope. `events.fire` also verifies that the current execution can access that
scoped context. Project-scoped emission verifies that the project exists and belongs to the supplied
organization.

Forwarding preserves the event's source, type, payload, actors, occurrence time, and subject. It
changes the scope and can change the event ID. Emitting a new event creates a new random ID and a
new occurrence timestamp.

## Actors are trusted provenance

The actor structure separates causation from authority:

- **Initiator** identifies the entity that caused the event. Every event has exactly one.
- **Principal** identifies the entity whose permissions apply. It can be `null` for system,
  schedule, or unauthenticated external events.
- **Delegation** records delegates and assistants that participate in the operation.

Actors can represent internal Backoffice identities or external identities from a named source. The
actor schema rejects duplicate identities across initiator, principal, and delegation positions.

Actor provenance is structural. Route matchers must use actor matchers rather than payload paths
such as `$.actors`. This prevents event payload data from posing as trusted authorization context.

When a workflow emits a child event, the event runtime uses the trusted execution actors supplied by
the workflow context. Callers cannot add actor fields to `events.fire` input.

## Subject describes affected entities

The subject is optional, open-ended metadata. It commonly contains `orgId`, `projectId`, or
`userId`, but it can include additional event-specific fields.

Subject is not the routing scope and does not grant access. For example, a system-scoped
organization-created event can name the new organization in `subject.orgId` while remaining owned
and routed by the system Automations object.

For project-targeted emission, Backoffice resolves the project and writes canonical `orgId` and
`projectId` values into the subject. A supplied `subjectUserId` adds a user ID without changing the
event scope.

## Ingestion is a durable handoff

Event ingestion follows this sequence:

1. Look up a scoped dynamic event definition for the source and event type.
2. Validate the payload when that definition is enabled and has a payload schema.
3. Validate actor structure and parse `occurredAt`.
4. Insert the event record.
5. Create an `internalIngestEvent` durable hook with the same event ID.
6. Commit the event and hook together.
7. Let the hook load current routes and execute matching actions.

A duplicate event ID conflicts with the existing event record. Producers and retrying forwarders
should therefore reuse the same ID for the same logical occurrence.

Scheduled events use the same ingestion function but include a route snapshot in the hook payload.
The ingestion hook executes that snapshot directly. Ordinary events make the hook load the current
route set when it runs.

## Emitting events from workflows and scripts

The `events.fire` runtime tool creates another automation event. Its input contains:

```ts
{
  eventType: string;
  source?: string;
  subjectUserId?: string;
  payload?: Record<string, unknown>;
  targetScope?: BackofficeContextScope;
}
```

When `source` is absent, the runtime inherits the parent event's source. An execution without a
parent event must provide a source. Missing or non-object payload input becomes an empty object at
the runtime boundary.

By default, the new event stays in the current execution scope. Cross-scope emission requires both
owner-scope permission and scoped-context access.

Event emission creates a new event. It differs from router forwarding, which copies an existing
event and preserves its identity unless an `idTemplate` changes it.

## Routing behavior

The ingestion hook retrieves routes in ascending priority and ID order. For ordinary events, it
selects enabled event routes by:

- exact or wildcard source;
- exact or wildcard event type;
- optional path, actor, or composite matcher.

Several routes can accept one event. The router executes each selected route's single action in
order. See [About the automation router](../automations/router.md) for matcher, template, and action
semantics.

## Event history and pagination

Stored events are ordered by `occurredAt` descending and then by `id` descending. The events route
uses cursor-based pagination:

- default page size: 100;
- maximum page size: 500;
- cursor index: `idx_automation_event_occurredAt_id`;
- cursor direction: descending.

The cursor preserves its original page size on later pages. Invalid, wrong-index, wrong-direction,
or oversized cursors return `EVENTS_LIST_CURSOR_INVALID`.

The current event store has no deletion route, retention policy, or archival process. Events remain
in the scoped automation database until a future lifecycle mechanism or database-level operation
removes them.

## `/events` file-system projection

The `/events` mount does not mirror rows from the `automation_event` table. It exposes terminal
entries from the automation durable-hook queue for diagnostics.

The projection groups entries by UTC day:

```text
/events/YYYY-MM-DD/<timestamp>_<hook-id>.json
/events/YYYY-MM-DD/<timestamp>_<hook-id>-failed.txt
```

Completed hook files contain the hook payload as formatted JSON. Failed hook files contain the
recorded error text. Pending and processing hooks do not appear. The contributor currently reads one
page of up to 200 hook entries, so it is a recent diagnostic view rather than a complete event
archive.

Use the events API or synchronized `automation_event` collection for event history. Use `/events` to
inspect terminal automation hook processing.

## Failure boundaries

Events can fail before or after persistence:

- An invalid dynamic payload schema rejects the event before insertion.
- Invalid actor provenance or `occurredAt` rejects ingestion before insertion.
- A duplicate ID fails the event insert.
- Route action failures happen after the event and durable hook have committed.
- Cross-scope checks fail before the target Automations object receives the event.

The event catalog describes known event classes, but absence from the catalog does not reject an
event. See [Event catalog reference](event-catalog.md) for the current enforcement rules.

## Related documents

- [Event catalog reference](event-catalog.md)
- [About automations](../automations/README.md)
- [Automation router](../automations/router.md)
- [Triggers and schedules](../automations/triggers-and-schedules.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/contracts.ts` — event envelope types.
- `apps/backoffice/app/fragno/automation/actors.ts` — actor provenance.
- `apps/backoffice/app/fragno/automation/definition.ts` — ingestion and route dispatch.
- `apps/backoffice/app/fragno/automation/events.ts` — event record and list schemas.
- `apps/backoffice/app/fragno/automation/events-storage-runtime.ts` — cursor-based history reads.
- `apps/backoffice/app/fragno/automation/event-routes.ts` — events HTTP route.
- `apps/backoffice/app/fragno/runtime-tools/families/event-runtime.ts` — scoped event emission.
- `apps/backoffice/app/files/contributors/durable-hooks.ts` — `/events` hook projection.
