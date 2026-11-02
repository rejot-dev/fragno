# Actions and events

## Backoffice calls the app: declared actions

Read [Bookkeeping's endpoint](../../../../apps/bookkeeping/workers/backoffice/actions.ts), the
[action verifier](../../../../packages/backoffice-api/src/v0/app-actions.ts), and the
[action registration contract](../../../../packages/backoffice-api/src/v0/apps.ts).

Declare the operations agents actually need, with stable action IDs and JSON input/output schemas.
Register an HTTPS endpoint (HTTP loopback is supported for development). Choose action-change
approval by trust: `automatic` applies revisions to existing installations and is reserved for apps
administrators operate; `installation` keeps each installation's approved declaration until an owner
approves a new revision. Keep declaration and handler together so setup imports the actual served
actions.

Backoffice exposes them through `app#<slug>`. `integrations.verify` sends a ping;
`integrations.execute` sends an action. Backoffice validates declared inputs and outputs. The
request body is `{ type: "ping" }` or `{ type: "action", actionId, input }`.

At the app endpoint:

1. Call `createAppActionVerifier` from `@fragno-dev/backoffice-api/v0/app-actions`, configured with
   the trusted Backoffice origin, the exact registered endpoint URL, and `fetch`. Reuse it to cache
   JWKS. It verifies signature, issuer, endpoint audience, expiry/lifetime, and the hash of the
   exact request body; give it the unread request.
2. Resolve the tenant from verified `claims.scopeRestriction` and installation claims. Restrict
   project-specific actions to that verified project; a tenant ID in action input cannot widen the
   signed scope. Reject unsupported owner kinds and missing local mappings.
3. Distinguish a user actor from an installation actor when the domain action requires it. A valid
   signature does not replace product-level authorization.
4. Handle ping without a domain mutation, dispatch known actions, and return the declared JSON
   output. Translate `AppActionRequestError` to its HTTP status; propagate unexpected failures.

Backoffice waits 10 seconds for the whole answer and reads at most 1 MB of it. A slower answer
counts as an unreachable endpoint; a larger one keeps its status but loses its body.

The verifier parses the envelope, not the individual action's domain input schema. Establish that
input's contract at the dispatch boundary. Mutation actions also need a retry/replay policy: the
signed `jti` can deduplicate the same request, but does not make independently retried business
operations idempotent. Short token expiry alone does not prevent repeats within its lifetime.

**Complete when:** an installed tenant can verify and execute the declared action through
Backoffice, and wrong-tenant, tampered, expired, and wrong-audience requests cannot read or mutate
another tenant's data.

## Backoffice tells the app: event notifications

Read the `notify_app` route action in
[automation operations](../../../../packages/backoffice-api/src/v0/automation.ts), its dispatch in
[automations](../../../../apps/backoffice/app/fragno/automation/definition.ts), and its scenario in
[scenario-notify-app.test.ts](../../../../apps/backoffice/app/fragno/automation/scenario-notify-app.test.ts).

Backoffice does not push events. A `notify_app` route sends the app's endpoint a signed
`{ type: "event", eventId }` naming an event in the token's `scopeRestriction`; the app reads it
with `events.get` as its installation, in that scope. Request `events.read` to be notified, and
`router.read` and `router.modify` to manage the routes yourself:

1. With an installation credential for the scope, `router.create` a route whose action is
   `{ kind: "notify_app", appId }`, with a stable route ID; a conflict means an earlier attempt made
   it. The app becomes the route's steward: it changes only its own routes, and they may only notify
   it. Members may turn them on or off, or delete them.
2. Handle `type: "event"` at the endpoint after verification. Delivery is at least once: dedupe on
   the event ID, not the token's `jti`. Answer 2xx once the work is durably accepted, within the
   10-second deadline; hand slow work off rather than doing it in the request. A late answer is
   retried like a 5xx, so the app is told again.
3. Answer 5xx or 429 to be told again later; any other non-2xx fails the route for good until a
   member retries it with `events.routes.retry`. `events.get` returns `null` for an event that is
   not stored: answer 2xx, as nothing will change.

Events the app causes, even reclassified or forwarded, and the failures of routes acting on them,
are never sent back to it. An uninstalled app, or one without `events.read`, is skipped rather than
failed.

**Complete when:** an event matching the app's route reaches its endpoint once accepted, the app
reads it in the signed scope, and a repeated notification does not repeat its effect.

## The app calls Backoffice: events and automation

Read [event operations](../../../../packages/backoffice-api/src/v0/events.ts) and
[installed-app execution](../../../../apps/backoffice/app/fragno/auth/README.md#installed-apps).
Obtain a scoped execution credential using the actor appropriate to the work, then call
`events.fire` through `createBackofficeApiClient`. Request the `events.emit` permission when using
this feature; first-party status alone grants no event capability.

Backoffice assigns source `app:<appId>` and retains the credential's actor and installation
restrictions for resulting automation. Choose the target intentionally: events in the app's private
scope reach that scope's routes, not the owner's. Emit into the owner scope when the owner's
configured routes should react, within the installation's grants.

A successful fire means the event is durably accepted and queued, not that downstream automation has
completed. Emit after the domain change is durable. If losing or duplicating an event would break
the flow, use a durable handoff and the actual event contract's deduplication mechanism; confirm it
from source rather than assuming every mutation supports blind retries.

**Complete when:** a scenario observes the event in the intended scope with app attribution, and any
promised downstream result is asserted separately from the enqueue receipt.
