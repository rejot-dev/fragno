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

The derived event preserves scope, occurrence time, actors, and subject. Its ID is
`reclassified:<routeId>:<originalEventId>`, so replaying the same route and input is idempotent.
Keep reclassification chains acyclic and ensure each route's output cannot match its own trigger,
including wildcard triggers; the runtime rejects repeated source/type pairs in a chain.

## Forward events

Use `forward_event` to deliver the same domain event to another scope. Create the route in the
source scope and choose a target allowed by that route owner's scope policy. Scope templates resolve
identifiers; they do not grant access.

For a system-owned route whose input has a known subject organization ID, set this action:

```js
const action = {
  kind: "forward_event",
  targetScope: {
    kind: "org",
    orgIdTemplate: "${event.subject.orgId}",
  },
};
```

Use authoritative IDs in scope templates, and match on any event fields needed to resolve them.
Forwarding preserves source, event type, occurrence time, payload, actors, and subject while
changing scope. The default preserves the event ID; use a deterministic `idTemplate` only when the
target needs a distinct delivery identity. Keep scope flows one-way so target routes do not forward
back into the source flow.

Inspect the target's destination event definition: its schema validates the unchanged payload.
Verify both the source record and target record, using the rendered ID when `idTemplate` is set, and
correlate their respective hook or workflow outcomes.

## Catalog versus delivery

`events.catalogList` and `events.catalogGet` describe event types and their schemas. `events.list`
and `events.get` inspect stored occurrences. A stored event proves ingestion; use correlated
durable-hook or workflow results to establish downstream completion.

## Scope and pagination

Select the scope that owns the delivery before inspecting it. For forwarded events, inspect the
source and target scopes separately.

Use `events.list({ limit: 50 })` to retrieve a page, newest first. Match its records locally against
the expected `source`, `eventType`, occurrence time, and delivery-specific payload identifiers.
Continue with the returned `nextCursor` while `hasNextPage` is true and the relevant delivery has
not been found. Keep the search bounded to the delivery's time window or an explicit page budget. If
the search stops before covering that window, report the search boundary rather than claiming the
event was never ingested.

## Correlate the evidence

Use `events.get({ id })` with an ID from a matching record to inspect its payload, actors, and
subject. Compare the actual envelope with the route matcher and any payload projection. For
webhooks, match the original event's `endpointId`, `deliveryId`, and `hookId`; correlate projected
identifiers with the expected reclassified records.

Inspect the matching hook's result or the workflow instance selected by the route's instance-ID
template. Report ingestion and downstream execution separately, including failures, pending work,
and any missing evidence.

**Complete when** the owning scope, matching event IDs, relevant payloads, and downstream outcomes
are supported by retrieved evidence, or the exact unverified boundary is stated.
