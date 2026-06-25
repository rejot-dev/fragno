# Automation DB Router Plan

## Current POC scope

For the minimal POC, persist only **automation routes**.

We deliberately do **not** add event or dispatch tables yet. Event ingestion is already driven by a
Durable Hook (`internalIngestEvent`) and therefore already has durable retry/idempotency behavior at
the hook layer. Workflow creation also uses deterministic instance ids, so a separate dispatch table
is not needed to prove DB-backed routing.

## Routing model

When `automations.ingestEvent(event)` is called:

```txt
1. The service triggers durable hook internalIngestEvent with id = event.id.
2. The Automations object ensures starter route rows exist.
3. internalIngestEvent reads enabled automation_route rows.
4. It normalizes route rows into runtime route definitions.
5. It filters routes by source/eventType and matcher JSON.
6. For each matching start_workflow route:
   - render deterministic workflow instance id;
   - render workflow params;
   - skip if the workflow script path does not exist;
   - call workflows.createInstance(...).
7. Temporary system handlers still cover Pi default-agent, OTP forwarding, and project file setup.
```

The event envelope used for matching is the existing `AutomationEvent` shape:

```ts
type AutomationEvent = {
  id: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  actor: AutomationEventActor;
  actors: AutomationEventActor[];
  subject?: AutomationEventSubject | null;
};
```

## Route table

`automation_route` is the only new table required for the POC.

Fields:

- `id`
- `name`
- `enabled`
- `source`
- `eventType`
- `matcher`
- `action`
- `priority`
- `description`
- `createdAt`
- `updatedAt`

Candidate route lookup may start broad (`whereIndex("primary")`) for simplicity, then filter in
runtime. A later slice can optimize through `idx_automation_route_enabled_source_type`.

## Matcher DSL

```ts
type Matcher =
  | { path: string; op: "exists" }
  | { path: string; op: "eq" | "neq" | "startsWith" | "includes"; value: unknown }
  | { all: Matcher[] }
  | { any: Matcher[] }
  | { not: Matcher };
```

Supported paths are simple dotted paths rooted at the event envelope, e.g. `$.payload.text`,
`$.actor.source`, `$.subject.endpointId`.

## Action DSL

POC actions:

```ts
type StartWorkflowAction = {
  kind: "start_workflow";
  workflowName: string;
  remoteWorkflowName?: string;
  workflowScriptPath: string;
  instanceIdTemplate: string;
  includeWorkflowInstanceId?: boolean;
  params?: Record<string, unknown>;
};

type SendWorkflowEventAction = {
  kind: "send_workflow_event";
  workflowName: string;
  target:
    | { kind: "instance_id"; template: string }
    | { kind: "stored_instance_id"; keyTemplate: string };
  eventType: string;
  payload?: unknown;
};
```

Future action:

```ts
type FireEventAction = {
  kind: "fire_event";
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
};
```

`fire_event` is deferred.

## Starter route seeding

Starter routes are seeded via an internal runtime tool:

```js
await internal.automationsRoutesSeedStarter({});
```

The system workspace initialization workflow calls this tool after seeding starter files. The
Automations object also ensures starter routes are seeded before ingest routing, so first-event
bootstrapping still works. `internalIngestEvent` also creates missing starter route rows before
matching, so events emitted from inside automation services, such as `project.created`, do not
depend on an earlier object-level seed.

## Slice 1 status

- [x] Add `automation_route` table.
- [x] Add route matcher/action runtime types.
- [x] Add route row normalization instead of unsafe casts.
- [x] Add matcher evaluation and workflow instance id rendering.
- [x] Add starter route definitions equivalent to the workflow-starting branches of the old router.
- [x] Add `send_workflow_event` for OTP-to-workflow event forwarding.
- [x] Move `project.created` setup into a system workflow started by a DB route.
- [x] Add `seedStarterAutomationRoutes()` service.
- [x] Add Automations object method `seedStarterAutomationRoutes()`.
- [x] Add internal runtime tool `internal.automationsRoutesSeedStarter({})`.
- [x] Remove starter `automations/router.cm.js` files from workspace and system content.
- [x] Route events from `internalIngestEvent` through DB routes.
- [x] Preserve temporary system handler for Pi default-agent storage.

## Later slices

- Route management routes/tools/UI.
- First-class waiters for workflow `step.waitForEvent`.
- Dynamic event catalog storage.
- API webhook catalog integration.
- Transport/domain event conversion.
- Optional `fire_event` action.
- Optional dispatch/audit table if route debugging needs persisted execution records.
