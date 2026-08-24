# About triggers and schedules

A route trigger determines when the router should perform its action. Backoffice supports two
trigger kinds:

- **Event triggers** react to an ingested event.
- **Schedule triggers** create their own automation events from a one-time timestamp or cron
  cadence.

Manual execution is not a third trigger kind. It asks an existing scheduled route to produce one
additional scheduled event immediately.

## Event triggers react to the event stream

An event trigger contains a source, an event type, and an optional matcher. The durable ingestion
hook evaluates it after the event record commits.

Event triggers have no separate materialized state. Their effective state consists of the route's
`enabled` flag and its current trigger definition when the ingestion hook loads routes. Source or
event type can be `*` to match any value.

For matcher semantics, see [About the automation router](router.md#event-route-selection).

## Schedule triggers own a cadence

A schedule trigger stores one of two cadence shapes.

A one-time cadence uses an ISO 8601 timestamp:

```json
{
  "kind": "once",
  "at": "2026-08-10T14:00:00.000Z"
}
```

A recurring cadence uses a five-part cron expression and an Internet Assigned Numbers Authority
(IANA) time zone:

```json
{
  "kind": "cron",
  "expression": "0 9 * * 1-5",
  "timeZone": "America/New_York"
}
```

The parser uses five-part cron mode. The fields represent minute, hour, day of month, month, and day
of week. The cadence defaults to `UTC` when schema parsing supplies no time zone, but stored and
authored routes should make the intended zone explicit.

Cadence validation rejects:

- empty cron expressions;
- invalid five-part cron syntax;
- invalid IANA time-zone names;
- cron expressions that cannot calculate an occurrence;
- invalid one-time timestamps.

A one-time timestamp at or before schedule initialization has no future occurrence. The scheduler
clears its state without emitting an event.

## Schedule state materializes the next occurrence

Each scheduled route has one `automation_route_schedule_state` record with two nullable timestamps:

| Field              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `initializationAt` | Database time from which the scheduler must calculate the next occurrence. |
| `nextOccurrenceAt` | Materialized occurrence currently represented by a queued dispatch hook.   |

The state alternates between initialization and dispatch:

```text
initializationAt set
        |
        v
calculate next occurrence
        |
        v
nextOccurrenceAt set + dispatch hook queued
        |
        v
dispatch accepted
        |
        +--> one-time: both fields cleared
        |
        +--> cron: initializationAt reset to database now
```

The router exposes `nextOccurrenceAt` as part of the normalized route. Event routes always report
`null` and must not have a schedule-state record.

## Database time is authoritative

The scheduling lifecycle uses `uow.now()` from the database transaction. It does not use browser
time, request time, or the clock of the process that authored the route.

Database time establishes three boundaries:

1. Creating, enabling, or changing a scheduled route records `initializationAt` and queues an
   immediate initialization hook.
2. Initialization calculates the first occurrence strictly after `initializationAt`.
3. After a cron occurrence dispatches, the scheduler records a new `initializationAt` from the
   dispatch transaction and calculates again.

Re-anchoring recurring schedules to dispatch time deliberately coalesces missed occurrences. If the
system resumes after several cron boundaries have passed, it schedules the next future occurrence
instead of replaying an unbounded backlog.

## Creating and updating scheduled routes

Route mutations maintain scheduling state in the same database transaction.

| Change                         | Schedule behavior                                     |
| ------------------------------ | ----------------------------------------------------- |
| Create an enabled schedule     | Set `initializationAt`; queue initialization.         |
| Create a disabled schedule     | Create empty schedule state; queue nothing.           |
| Enable a schedule              | Reset state from database time; queue initialization. |
| Disable a schedule             | Clear initialization and next occurrence.             |
| Change cadence while enabled   | Reset state from database time; queue initialization. |
| Change cadence while disabled  | Keep empty state.                                     |
| Change event route to schedule | Create schedule state and initialize when enabled.    |
| Change schedule to event route | Delete schedule state.                                |
| Delete a scheduled route       | Delete route and schedule state.                      |

Queued hooks do not need explicit cancellation. Each hook verifies the current route, enabled state,
trigger kind, schedule state, and expected occurrence before acting. A hook from an old route
version becomes a no-op when these checks no longer match.

## Dispatch creates an ordinary automation event

A scheduled occurrence enters the router as this event class:

| Event field        | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `id`               | `schedule:<routeId>:<scheduledForEpochMs>`                       |
| `source`           | `scheduler`                                                      |
| `eventType`        | `schedule.triggered`                                             |
| `occurredAt`       | The scheduled occurrence timestamp.                              |
| `payload`          | Route ID, route name, and cadence snapshot.                      |
| `actors.initiator` | Internal `schedule` actor identified by the route ID.            |
| `actors.principal` | `null`.                                                          |
| `subject`          | Organization, project, or user IDs derived from the owner scope. |

The scheduler passes the selected route as a snapshot to ingestion. The ingestion hook executes that
route directly instead of scanning event routes. This preserves the accepted scheduled action even
if an author edits or deletes the route before the hook runs.

For automatic dispatch, the persisted `nextOccurrenceAt` must exactly equal the hook's
`scheduledFor` value. This comparison makes superseded or duplicate hooks harmless.

## Manual triggers use the same event shape

The trigger-now operation accepts an existing scheduled route and queues a manual dispatch hook. It
returns an event ID immediately:

```text
schedule:<routeId>:manual:<random UUID>
```

The durable hook's database-generated `createdAt` becomes the event's occurrence time. The hook
payload contains a route snapshot, so an accepted manual trigger survives a later route update or
deletion.

The route's `enabled` flag controls automatic event matching and automatic schedule dispatch. It
does not prevent a caller from manually triggering an existing scheduled route.

Manual dispatch checks whether its event ID already exists before ingestion. The event ID is unique,
and the hook has a stable `manual-dispatch:<eventId>` identity. If hook recovery overlaps an earlier
attempt, only one event commit can win; a retry observes the existing event and completes without
executing the route twice.

## Recurring schedule behavior

A cron route does not calculate its entire future series. It materializes one occurrence at a time:

1. Initialize from database time.
2. Queue one dispatch hook.
3. Verify and ingest that occurrence.
4. Re-anchor from the dispatch transaction's database time.
5. Queue initialization for the next occurrence.

This design keeps schedule state small, avoids long chains of speculative hooks, and makes route
updates invalidate old work through a single timestamp comparison.

## Failure boundaries

Schedule failures fall into distinct categories:

- **Authoring failure:** cadence validation rejects the route before persistence.
- **State invariant failure:** an enabled cron route without initialization or a next occurrence
  indicates corrupted state and throws.
- **Stale hook:** current route or state no longer matches; the hook exits without work.
- **Action failure:** the schedule event is persisted, but the snapped route action fails in the
  normal ingestion hook and follows durable-hook retry behavior.

The schedule event remains the audit record for an accepted occurrence.

## Related documents

- [About automations](README.md)
- [Router](router.md)
- [Scripts and workflows](scripts.md)
- [Events](../events/README.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/route-triggers.ts` — cadence schemas, validation, and
  occurrence calculation.
- `apps/backoffice/app/fragno/automation/route-scheduling-runtime.ts` — initialization, automatic
  dispatch, and manual dispatch.
- `apps/backoffice/app/fragno/automation/routing-storage-runtime.ts` — route mutations and
  schedule-state transitions.
- `apps/backoffice/app/fragno/automation/internal-hooks.ts` — durable scheduling payloads.
- `apps/backoffice/app/fragno/automation/schema.ts` — route and schedule-state tables.
- `apps/backoffice/app/fragno/automation/route-scheduling.test.ts` — scheduling lifecycle and retry
  behavior.
- `apps/backoffice/app/fragno/automation/scenario-scheduled-route.test.ts` — end-to-end scheduled
  route behavior.
