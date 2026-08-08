# About the automation router

The automation router is a database-backed set of declarative **trigger → action** rules. It decides
which durable action should respond to an event or schedule. Workflow files contain behavior; routes
contain selection, targeting, ordering, and authority.

## Route structure

Every route has the following fields:

| Field              | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `id`               | Stable identity used by templates, scheduling state, provenance, and action idempotency. |
| `name`             | Human-readable label.                                                                    |
| `enabled`          | Whether automatic event matching or scheduled dispatch may execute the route.            |
| `priority`         | Primary execution order. Lower numbers run first.                                        |
| `trigger`          | An event selector or schedule cadence.                                                   |
| `action`           | One of `start_workflow`, `send_workflow_event`, or `forward_event`.                      |
| `description`      | Optional explanatory text.                                                               |
| `metadata`         | Creator/updater actor provenance and optional marketplace ownership.                     |
| `nextOccurrenceAt` | Materialized next schedule time, or `null`.                                              |

Routes are read in ascending `priority` order and then by `id`. Priority controls deterministic
ordering, not exclusivity: one event can match and execute several routes.

## Event route selection

An event trigger specifies `source`, `eventType`, and an optional matcher. The router selects a
route when all of these conditions hold:

1. The route is enabled.
2. Its trigger kind is `event`.
3. Its source equals the event source or is `*`.
4. Its event type equals the event type or is `*`.
5. Its matcher accepts the event.

A `null` matcher accepts every event with the selected source and type.

### Path matchers

Path matchers read a deliberately small JSONPath-like language:

- `$` selects the complete event.
- `$.payload.message.text` selects nested object fields.
- `$.payload.items[0]` selects an array element.

Unknown or malformed paths produce `undefined` rather than throwing. The supported operators are:

| Operator     | Behavior                                                                            |
| ------------ | ----------------------------------------------------------------------------------- |
| `exists`     | Matches when the selected value is not `undefined`.                                 |
| `eq`         | Uses strict equality.                                                               |
| `neq`        | Uses strict inequality. A missing path therefore differs from most supplied values. |
| `startsWith` | Matches only when both operands are strings.                                        |
| `includes`   | Matches only when both operands are strings.                                        |

Matchers compose recursively with `all`, `any`, and `not`.

### Actor matchers

Actor provenance has structural meaning and cannot be matched through `$.actor` or `$.actors` paths.
Actor matchers select one participation slot:

- `initiator` — the entity that caused the event;
- `principal` — the identity whose authority applies, when present;
- `delegation` — any delegate or assistant in the delegation chain.

A matcher can constrain internal actors by `type` and `id`. It can also constrain external actors by
`source`, `type`, and `id`. Delegation matchers can additionally select the `delegate` or
`assistant` role.

Keeping actor matching structural prevents payload data from impersonating trusted provenance.

## Route actions

A route performs exactly one action.

### Start a workflow

`start_workflow` creates an instance of the shared automation workflow host. Its fields are:

- `workflowScriptPath` — absolute path to a saved workflow file;
- `remoteWorkflowName` — `defineWorkflow` name inside the file;
- `instanceIdTemplate` — stable instance identity rendered from the event;
- `authority` — delegated-user or organisation-automation authority.

The workflow runs in the current event scope. The action has no target-scope override.

The route should render the same instance ID whenever the durable ingestion hook retries. Reusing
the logical instance ID lets the workflow service recognize the same work instead of creating an
unrelated run.

### Send a workflow event

`send_workflow_event` delivers a continuation to an existing workflow instance. It identifies:

- the local `workflowName`, which defaults to `automation-codemode-script`;
- the saved definition's `remoteWorkflowName`;
- the workflow event `eventType`;
- a target instance;
- an optional payload.

The target can render an instance ID directly:

```json
{
  "kind": "instance_id",
  "template": "approval-${event.payload.requestId}"
}
```

Alternatively, it can render a store key and read the instance ID from the automation store:

```json
{
  "kind": "stored_instance_id",
  "keyTemplate": "approval/workflow/${event.payload.requestId}"
}
```

If the target resolves to an empty string or the store key has no value, the action does nothing.
Omitting `payload`, or setting it to the sentinel string `$event`, sends the complete triggering
automation event. Any other payload is sent unchanged.

The workflow event ID is `${route.id}:${event.id}`. This stable identity protects a retry from
creating a second logical workflow event.

### Forward an event

`forward_event` copies the event into another Backoffice scope. The action can target:

- system;
- an organisation;
- a project within an organisation;
- a user.

Scope IDs are templates. The route can also provide `idTemplate`; otherwise, the forwarded event
keeps its original ID. Before forwarding, the Backoffice kernel verifies that the current
Automations owner may target the resolved scope.

Forwarding preserves the event payload, actors, source, event type, occurrence time, and subject. It
changes only the scope and, when configured, the ID. A system target seeds its starter routes before
ingesting the event.

## Templates

Route action templates support four expression families:

| Expression               | Value                                         |
| ------------------------ | --------------------------------------------- |
| `${route.id}`            | Current route ID.                             |
| `${routing.key}`         | Stable `${event.id}:${route.id}` routing key. |
| `${event}`               | Event ID.                                     |
| `${event.payload.value}` | A field read from the event.                  |

Unknown expressions and unknown event paths render as an empty string.

Workflow instance and store-key templates sanitize each expression result by replacing characters
outside `A-Z`, `a-z`, `0-9`, `-`, and `_` with `-`. Literal template text remains unchanged.
Forwarded event IDs and scope IDs use raw template rendering because provider and Backoffice
identifiers may require punctuation.

A template can therefore be valid but still produce an empty required value. Actions validate
critical results at execution time: forwarding rejects empty organisation, project, or user IDs,
while workflow-event delivery treats an empty instance ID as a no-op.

## Route provenance and marketplace ownership

Route metadata records the actors that created and most recently updated the route. A route can also
declare that a marketplace listing manages it through:

- `listingId`;
- `resourceKey`;
- `version`.

Marketplace ownership is metadata, not a separate route type. The router executes managed routes
through the same trigger and action machinery as user-authored routes.

## Updates and consistency

Route creation and update validate the complete trigger and action shape. Schedule cadences receive
additional semantic validation.

The database maintains a strict relationship between route type and schedule state:

- Every scheduled route must have one schedule-state record.
- An event route must not have a schedule-state record.
- Switching trigger kinds creates or deletes schedule state in the same route mutation.

Updates that do not change authored fields return the existing route without rewriting provenance or
schedule state. Disabling a scheduled route, changing its cadence, or switching trigger kind clears
the materialized next occurrence so queued hooks become stale.

## Scheduled route snapshots

Automatic and manual schedule dispatches pass a route snapshot across the durable event-ingestion
boundary. Once a scheduled occurrence has been accepted, later route edits or deletion do not change
the action attached to that accepted event.

Normal event ingestion does not snapshot the full route set. The ingestion hook loads the current
routes when it runs. This distinction lets scheduled work preserve an accepted occurrence while
ordinary event routing uses the current routing configuration.

## Related documents

- [About automations](README.md)
- [Scripts and workflows](scripts.md)
- [Triggers and schedules](triggers-and-schedules.md)
- [Events](../events/README.md)
- [Store](../store.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/routing.ts` — matching, templates, and action types.
- `apps/backoffice/app/fragno/automation/routing-schemas.ts` — route input validation.
- `apps/backoffice/app/fragno/automation/definition.ts` — route selection and action dispatch.
- `apps/backoffice/app/fragno/automation/routing-storage-runtime.ts` — route persistence and
  schedule-state transitions.
- `apps/backoffice/app/fragno/automation/route-records.ts` — record normalization invariants.
- `apps/backoffice/app/fragno/automation/authority.ts` — workflow authority modes.
- `apps/backoffice/app/fragno/automation/content/starter-routing.ts` — built-in route examples.
