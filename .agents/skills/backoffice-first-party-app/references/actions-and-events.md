# Actions and events

## Backoffice calls the app: declared actions

Read [Bookkeeping's endpoint](../../../../apps/bookkeeping/workers/backoffice/actions.ts), the
[action verifier](../../../../packages/backoffice-api/src/v0/app-actions.ts), and the
[action registration contract](../../../../packages/backoffice-api/src/v0/apps.ts).

Declare the operations agents actually need, with stable action IDs and JSON input/output schemas.
Register an HTTPS endpoint (HTTP loopback is supported for development). Choose action-change
approval deliberately: `automatic` applies revisions to existing installations; `installation` keeps
their approved declaration until an owner approves a new revision. Keep declaration and handler
together so setup imports the actual served actions.

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

The verifier parses the envelope, not the individual action's domain input schema. Establish that
input's contract at the dispatch boundary. Mutation actions also need a retry/replay policy: the
signed `jti` can deduplicate the same request, but does not make independently retried business
operations idempotent. Short token expiry alone does not prevent repeats within its lifetime.

**Complete when:** an installed tenant can verify and execute the declared action through
Backoffice, and wrong-tenant, tampered, expired, and wrong-audience requests cannot read or mutate
another tenant's data.

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
