# Event Routing and Verification

Read `/static/codemode/providers/router.d.ts` for live route actions and scope templates, and
`/static/codemode/providers/events.d.ts` for event definitions and inspection methods.

## Reclassify events

Use `reclassify_event` to derive a domain event from an incoming delivery in the same scope. GitHub
Channel uses this to turn `github.webhook.received` into events such as `github.issues.opened`. This
is event classification, not an HTTP redirect: the original record remains stored.

Inspect the destination with `events.catalogGet`; create its definition with `events.catalogCreate`
when introducing a new event type. Select the input with an exact trigger source/type and matchers
for the provider discriminator and any relevant endpoint or repository.

After its destination definition exists, create a GitHub issues-opened route:

```js
await router.create({
  id: "github-issues-opened",
  name: "Classify opened GitHub issues",
  trigger: {
    kind: "event",
    source: "github",
    eventType: "webhook.received",
    matcher: {
      all: [
        { path: "$.payload.githubEvent", op: "eq", value: "issues" },
        { path: "$.payload.action", op: "eq", value: "opened" },
      ],
    },
  },
  action: {
    kind: "reclassify_event",
    source: "github",
    eventType: "issues.opened",
    payload: {
      kind: "projection",
      fields: {
        deliveryId: "$.payload.deliveryId",
        installationId: "$.payload.installationId",
        repository: "$.payload.repository",
        issue: "$.payload.issue",
        sender: "$.payload.sender",
      },
    },
  },
});
```

Projection fields name top-level properties in the new payload; their paths read from the complete
input envelope. Every named path must resolve, and the projected payload must satisfy the
destination schema. Match on optional provider fields before projecting them when their absence
would make the route invalid for that delivery.

Deliveries such as `github.webhook.received` and `api.webhook.received` are stored without their
body: routes see the whole delivery, but stored events keep only its identifying fields. Project
every field later steps need into the derived event. The connection's `delivery.get` action reads a
delivery for a week after it is processed.

The derived event preserves scope, occurrence time, actors, and subject. Its ID is
`reclassified:<routeId>:<originalEventId>`, so replaying the same route and input is idempotent.
Keep reclassification chains acyclic and ensure each route's output cannot match its own trigger,
including wildcard triggers; the runtime rejects repeated source/type pairs in a chain.

## Forward events

Use `forward_event` to deliver the same domain event to another scope. Create the route in the
source scope and choose a target it may reach:

- an organization reaches its own projects and its members' personal scopes;
- a personal scope reaches its projects and the organizations, and their projects, where its owner
  may emit events. That is checked on every forward, so once the owner leaves an organization, its
  forwards fail.

Scope templates resolve identifiers; they do not grant access.

To deliver an event to the scope it is about, target its subject. Backoffice names that scope in
full in `subject.scope`, so match on it:

```js
const trigger = {
  kind: "event",
  source: "auth",
  eventType: "organization.created",
  matcher: { path: "$.subject.scope.kind", op: "eq", value: "org" },
};
const action = { kind: "forward_event", targetScope: { kind: "subject" } };
```

Other scope templates name organizations, users, apps, and projects by ID. Use authoritative IDs in
them, and match on any event fields needed to resolve them. Forwarding preserves source, event type,
occurrence time, payload, actors, and subject while changing scope. The default preserves the event
ID; use a deterministic `idTemplate` only when the target needs a distinct delivery identity. Keep
scope flows one-way so target routes do not forward back into the source flow.

Inspect the target's destination event definition: its schema validates the unchanged payload.
Verify both the source record and target record, using the rendered ID when `idTemplate` is set, and
correlate their respective hook or workflow outcomes.

## Notify agents

Use `notify_agent` to hand an event to an agent of the route's scope:

```js
const action = {
  kind: "notify_agent",
  agentName: "support",
  authority: {
    kind: "organization-automation",
    grants: [{ namespace: "pi", permission: "modify" }],
  },
};
```

The event is written into the agent's conversation at once, and a busy agent sees it at its next
tool round. The request to handle it waits in the agent's queue with its prompts and runs in a turn
with the route's authority, so grant `pi.modify` plus whatever the agent's work needs. Requests
waiting from one route authority share that turn, whose prompt request ID is
`route:<routeId>:<eventId>` for the oldest of them. A stopped agent keeps them until someone resumes
it. Delivering one event through one route twice delivers it once. Only started agents receive
notifications; prompt an agent once first. Events an agent's own turns produced, even reclassified
or forwarded, are never delivered to it.

## Catalog versus delivery

`events.catalogList` and `events.catalogGet` describe event types and their schemas. `events.list`
and `events.get` inspect stored occurrences. A stored event proves ingestion; its `routing` shows
what each route it matched did, and the workflow runs those routes started show the rest.

## Scope and pagination

Select the scope that owns the delivery before inspecting it. For forwarded events, inspect the
source and target scopes separately.

Use `events.list({ limit: 50 })` to retrieve a page, newest first; each event carries the same
`routing` as `events.get`. Match the records locally against the expected `source`, `eventType`,
occurrence time, and delivery-specific payload identifiers. Continue with the returned `nextCursor`
while `hasNextPage` is true and the relevant delivery has not been found. Keep the search bounded to
the delivery's time window or an explicit page budget. If the search stops before covering that
window, report the search boundary rather than claiming the event was never ingested.

To find what is going wrong without reading every event, use
`events.routesList({ status: "failed" })`, then `status: "retrying"`. Each call lists the routes in
one state, across every route and event in the scope, newest match first. Each entry is
`{ eventId, route }`, where `route` has the shape of an entry in `routing.routes`, described below;
keep the entries whose `route.routeId` is the route in question. It pages with `limit` and `cursor`
like `events.list`. Reading events and their routes needs `events.read`.

## Correlate the evidence

Use `events.get({ id })` with an ID from a matching record to inspect its payload, actors, and
subject. Compare the actual envelope with the route matcher and any payload projection. For
webhooks, match the original event's `endpointId`, `deliveryId`, and `hookId`; correlate projected
identifiers with the expected reclassified records.

The event's `routing` is `matching` until its routes are recorded, shortly after it is stored; read
it again rather than concluding no route matched. Once `matched`, `routing.routes` lists every route
the event matched, each with its `status`:

- `pending`: about to act.
- `retrying`: an attempt threw `error` and the route will try again. Errors that could clear up,
  such as a workflow run that does not exist yet, retry for up to roughly fifty minutes.
- `completed`: `outcome` says what the route did, such as the workflow run it started or the derived
  event it produced. `failedAttempts` above zero means it only acted after retries.
- `failed`: the route gave up on `error`, because no retry could fix it, such as a denied scope or a
  workflow run that has finished (`INSTANCE_TERMINAL`), or it ran out of attempts. Fix what it
  depends on, then run only this route again with `events.routesRetry({ eventId, routeId })`. Only
  `failed` routes can be retried; a `retrying` route retries by itself.

Each route also has `routeName`, its name when it matched, since routes can be renamed or deleted
later, and `matchedAt`.

A retried route acts as it was when the event matched it: its action, such as the workflow file, the
run it signals, or the agent it notifies, does not change. Its permissions are the route's current
grants, and it must still be enabled. So granting a missing permission, creating the workflow run it
targets, or prompting the agent once fixes a retry, but changing the route's action does not; fire a
new event for that, which runs every route it matches, not only this one.

Retrying needs `router.modify`. `events.routesRetry` returns the route as `pending`, and it leaves
the `failed` listing; read `events.get({ id: eventId })` again for its outcome. It returns `null`
when the event does not exist or did not match that route, and fails when the route is not `failed`.

An empty `routes` means no route matched; compare the event with each route's trigger and matcher.
Follow each outcome to the work it names:

- `workflow_started`: the run `instanceId` names, with `workflow.getInstance` and
  `workflow.getHistory`.
- `workflow_event_sent`: the run that was sent the event. In its `workflow.getHistory`, the event
  with id `<routeId>:<eventId>` names the step that took it; the steps after it are what the event
  set off. An event no step has taken yet is still pending.
- `agent_notified`: the agent's answer is its own `pi` `turn.completed` event.
- `event_reclassified` and `event_forwarded`: the event they name, with `events.get`; a forwarded
  event lives in its target scope.
- `skipped`: the route chose not to act, for the `reason` given. `workflow_instance_unresolved`: the
  route's target rendered no workflow run, such as a `stored_instance_id` key with nothing stored
  under it yet. `no_linked_external_sender`: the route acts for the event's external sender, who is
  not linked to a Backoffice user. `caused_by_notified_agent`: the agent's own turns caused the
  event, and an agent is never notified of those.

Report ingestion and downstream execution separately, including failures, pending work, and any
missing evidence.

## Act when a route fails

Each time a route fails for good, the scope records an `automations` `route.failed` event, caused by
that route, so it appears under the route in the event's trace. Its payload is
`{ route: { id, name }, event: { id, source, eventType }, error, failedAttempts }`. Route it like
any event to be told about failures, for example with `notify_agent`, or match `$.payload.route.id`
to watch one route. A retried route that fails again records another. A route that fails while
handling a `route.failed` event records none, so failures cannot feed each other.

**Complete when** the owning scope, matching event IDs, relevant payloads, and downstream outcomes
are supported by retrieved evidence, or the exact unverified boundary is stated.
