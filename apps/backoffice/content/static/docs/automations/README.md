# About automations

Backoffice automations connect an event or a schedule to one durable action. The automation system
separates **when work starts** from **what the work does**:

- An **event** records something that happened in a Backoffice scope.
- A **route** selects an event or owns a schedule.
- A route **action** starts a workflow, sends an event to a workflow, or forwards the event to
  another scope.
- A file-backed **workflow** contains the durable behavior.

This separation keeps routing data declarative and inspectable. Changing a trigger does not require
changing workflow code, and the same workflow can participate in several routes.

## The execution model

An automation normally moves through five stages:

1. A Backoffice capability, integration, workflow, or user action submits an automation event.
2. The Automations Fragment validates the event against its event definition, stores the event, and
   creates a durable ingestion hook in the same unit of work.
3. The hook loads routes in ascending `priority` and `id` order. It selects enabled event routes
   whose source, event type, and matcher accept the event.
4. Each selected route performs exactly one action.
5. A started workflow runs through the unified durable code-mode runtime and calls Backoffice tools
   under the authority recorded by the route.

Scheduled routes enter the same pipeline. The scheduler creates a `scheduler/schedule.triggered`
event and passes a snapshot of the selected route to event ingestion. The router therefore does not
need a separate execution path for scheduled work.

## Scope is the unit of ownership

Each Automations object belongs to one Backoffice scope: system, organization, project, or user. The
object owns its routes, events, schedule state, store entries, workflow instances, and other
automation records.

A workflow started by a route always runs in the triggering event's scope. A `start_workflow` action
cannot override that scope. Cross-scope delivery requires an explicit `forward_event` action, and
the Backoffice kernel verifies that the current Automations owner may target the requested scope.

The system scope has a small set of starter routes for system-wide work, such as initializing an
organization workspace and forwarding organization lifecycle events into the new organization's
scope. Other scopes receive their own starter routes.

## Durable boundaries

The system uses several durable boundaries rather than treating an automation as one long request:

- Event persistence and ingestion-hook creation occur together.
- Route evaluation happens in a durable hook after the event commit.
- Schedule initialization and dispatch use durable hooks with database timestamps.
- Workflow steps persist their progress through Fragno Workflows.
- Workflow events use stable IDs so hook retries do not create a second logical continuation.

These boundaries allow work to continue after the request that produced the event has ended. They
also mean that routes and workflows must use stable identifiers. A route retry may revisit an
action, so workflow instance IDs, workflow event IDs, and forwarded event IDs must identify the same
logical work on every attempt.

## Routes are data; workflows are behavior

Routes live in the automation database. Workflow implementations live in the Backoffice file system.
This division is intentional:

- Database records support ordering, enable/disable state, schedule materialization, provenance, and
  marketplace ownership.
- Files support source inspection, authoring, validation, versioned product content, and execution
  in an isolated runtime.

Legacy script files do not define the active routing topology. The database-backed router is the
source of truth for trigger-to-action relationships.

## Authority follows the route action

Every `start_workflow` action chooses one of two authority modes:

- **Delegated user** keeps the triggering internal user as the principal and adds the stable route
  automation identity as a delegate. Both identities must authorize protected work. The automation
  cannot elevate the user's permissions.
- **Organization automation** replaces the principal with `automation-route:<routeId>`. The original
  initiator remains provenance but supplies no authority. The workflow receives the finite shared
  automation grant set.

Delegated-user execution fails closed when the event lacks a valid internal user principal.
Organization-automation execution can continue when the route creator or triggering user later loses
access, but it remains limited by the automation role.

## Runtime resources

A workflow receives a scoped tool context rather than direct access to Backoffice internals.
Available tools can include:

- the automation store and router;
- event emission;
- workflow operations;
- configured integrations and Model Context Protocol (MCP) servers;
- files exposed through the master file system;
- sandbox and project operations;
- one-time identity claims.

Automation executions also mount the triggering event as read-only JSON at `/context/event.json`.
Codemode workflows receive the same automation event in their workflow parameters.

## Failure behavior

Failures remain visible at the boundary where they occur:

- Invalid event payloads fail before ingestion.
- Invalid route or cadence data fails route creation or update.
- Missing workflow source produces a skipped workflow result with reason
  `workflow-script-not-found`.
- A workflow step failure is recorded in workflow history and can follow the workflow retry policy.
- A forwarding action fails when the target scope is incomplete or outside the owner's allowed
  scope.
- A delegated-user route fails when its event does not carry an eligible user principal.
- A linked-user route does not start when its external initiator has no active identity binding.

The event record remains the audit anchor even when later route execution fails.

## Related documents

- [Scripts and workflows](scripts.md)
- [Router](router.md)
- [Triggers and schedules](triggers-and-schedules.md)
- [Events](../events/README.md)
- [Store](../store.md)
- [Sandboxes](../sandboxes.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/definition.ts` — event ingestion and route action dispatch.
- `apps/backoffice/app/fragno/automation/schema.ts` — persisted automation records.
- `apps/backoffice/app/fragno/automation/authority.ts` — route authority modes.
- `apps/backoffice/app/fragno/automation/engine/` — script and workflow execution.
- `apps/backoffice/app/fragno/automation/content/starter-routing.ts` — built-in routes.
- `apps/backoffice/workers/automations.do.ts` — scoped runtime host.
