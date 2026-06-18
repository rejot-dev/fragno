# Generic Webhook Receiver Plan

Goal: implement a minimal, OCC-friendly, database-backed inbound webhook receiver in
`packages/webhook-fragment` for Backoffice. The receiver should cover the common webhook patterns:
HMAC/header-secret auth, durable acceptance, dedupe, and retryable processing.

## Design constraints

- [ ] Every HTTP route uses **one `handlerTx()` execution**.
- [ ] Request routes do not run user work or external side effects.
- [ ] The public receive route does only: retrieve endpoint config, verify request, create event,
      trigger durable hook, return.
- [ ] Durable hooks do processing and retries after commit.
- [ ] Duplicate webhook deliveries must not require a second lookup roundtrip.
- [ ] Endpoint rows are read by receive requests but not updated by receive requests, minimizing OCC
      conflicts.
- [ ] Event rows use deterministic IDs so dedupe is primary-key based.
- [ ] Durable Objects host/migrate/dispatch alarms for Fragno durable hooks; they are not the event
      queue or source of truth for event history.

## Scope

### In scope for MVP

- [ ] Multiple configured inbound webhook endpoints.
- [ ] Public receive route: `POST /receive/:id`.
- [ ] Fast accept path: authenticate, persist event, enqueue durable hook, return `202 Accepted`.
- [ ] At-least-once processing with idempotent dedupe.
- [ ] Common auth methods:
  - [ ] HMAC signatures over raw body.
  - [ ] HMAC signatures over `timestamp + delimiter + rawBody` for replay protection.
  - [ ] Bearer token in `Authorization`.
  - [ ] API key/shared secret in configurable header.
  - [ ] API key/shared secret in configurable query param, documented as less secure.
  - [ ] Basic auth.
- [ ] Internal processing retries through Fragno durable hooks.
- [ ] Endpoint CRUD routes for Backoffice UI.
- [ ] Endpoint event listing and manual reprocess/ignore.
- [ ] Tests for auth, dedupe, one-transaction route behavior, and durable hook processing.

### Out of scope for MVP

- [ ] mTLS; this belongs at edge/proxy/ingress.
- [ ] JWT/JWKS verification.
- [ ] Provider SDK verification.
- [ ] IP/CIDR allowlist unless the mounted runtime exposes a trustworthy client IP.
- [ ] A custom retry scheduler; use Fragno durable hooks.
- [ ] A processing-attempt table unless durable hook visibility proves insufficient.

## Minimal schema

The minimal durable state is one endpoint table and one event table. Do **not** add a processing
attempt table for MVP; it duplicates durable hook queue state and creates extra writes.

### `webhookEndpoint`

- [ ] `id: idColumn()`
- [ ] `name: string`
- [ ] `status: string` (`active`, `disabled`)
- [ ] `authConfig: json` containing non-secret auth config and secret refs.
- [ ] `dedupeConfig: json` for optional source-specific event-id extraction.
- [ ] `createdAt: timestamp`
- [ ] `updatedAt: timestamp`
- [ ] Indexes:
  - [ ] primary only for MVP.
  - [ ] Add `status, createdAt` later only if the UI filters endpoint lists by status.

### `webhookEvent`

- [ ] `id: idColumn()`; deterministic from `endpointId + dedupeKey`.
- [ ] `endpointId: referenceColumn({ table: "webhookEndpoint" })`
- [ ] `dedupeKey: string`
- [ ] `bodyHash: string`
- [ ] `sourceEventId: string nullable`
- [ ] `deliveryId: string nullable`
- [ ] `eventType: string nullable`
- [ ] `status: string` (`accepted`, `processed`, `ignored`)
- [ ] `headers: json` redacted/sanitized.
- [ ] `rawBody: string`
- [ ] `contentType: string nullable`
- [ ] `receivedAt: timestamp`
- [ ] `processedAt: timestamp nullable`
- [ ] `lastError: string nullable`
- [ ] Indexes:
  - [ ] primary deterministic `id` for duplicate detection.
  - [ ] `endpointId, receivedAt` for endpoint event listing.
  - [ ] `status, receivedAt` only if Backoffice needs a global failed/pending view.

### Why this is minimal

- [ ] No separate secret table: secrets live in Backoffice/app secret storage and are referenced by
      `secretRef`. The fragment never returns secret material.
- [ ] No separate attempt table: durable hooks already track queued/processing/retry state.
- [ ] No stored `jsonBody`: parse raw body in the hook when needed. Storing both raw and parsed
      bodies duplicates data.
- [ ] No duplicate counter in MVP: updating duplicate counts would require reading/updating the
      existing event during retry deliveries and would add OCC contention.
- [ ] No `processing` event status in MVP: durable hooks have their own processing state; writing
      `processing` on every attempt creates unnecessary row churn and stuck-state cleanup problems.

## Auth configuration model

- [ ] Add discriminated Zod schemas/types for auth methods.

```ts
type WebhookAuthConfig =
  | { type: "none" }
  | { type: "bearer"; tokenRef: string }
  | { type: "api_key"; location: "header" | "query"; name: string; secretRef: string }
  | { type: "basic"; usernameRef: string; passwordRef: string }
  | {
      type: "hmac";
      secretRef: string;
      algorithm: "sha256" | "sha1" | "sha512";
      signature: {
        location: "header" | "query";
        name: string;
        encoding: "hex" | "base64" | "base64url";
        prefix?: string;
      };
      signedPayload:
        | { type: "raw_body" }
        | { type: "timestamp_body"; timestampHeader: string; delimiter: string };
      timestampToleranceSeconds?: number;
    };
```

- [ ] Add `resolveSecret(ref)` to `WebhookFragmentConfig`.
- [ ] For Backoffice, prefer a local/DO-backed secret resolver so auth does not perform network I/O
      inside the route transaction flow.
- [ ] Never persist or return resolved secret values.

## Dedupe model

- [ ] Compute `bodyHash = sha256(rawBody)` for all received events.
- [ ] Define `DedupeConfig`:
  - [ ] header key, e.g. `X-GitHub-Delivery`, `svix-id`, `x-shopify-webhook-id`.
  - [ ] query key if a provider uses one.
  - [ ] JSON path key, e.g. `id`, `event.id`, `data.id`.
  - [ ] fallback: body hash.
- [ ] Compute `dedupeKey` after endpoint retrieval using endpoint `dedupeConfig`.
- [ ] Compute deterministic event id: `webhookEvent.id = hash(endpointId + "\0" + dedupeKey)`.
- [ ] On duplicate primary-key violation, catch and return `202 Accepted` without enqueueing another
      hook.
- [ ] Do not read the existing event in the receive route just to detect duplicates.

## Receive route: one transaction

- [ ] Add `POST /receive/:id`.
- [ ] Use one `handlerTx()` with retrieve, async `transformRetrieve`, and mutate.

```ts
await this.handlerTx()
  .retrieve(({ forSchema }) =>
    forSchema(webhookSchema).findFirst("webhookEndpoint", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", endpointId)),
    ),
  )
  .transformRetrieve(async ([endpoint]) => {
    if (!endpoint) return { kind: "not_found" as const };
    if (endpoint.status !== "active") return { kind: "disabled" as const };

    const auth = await verifyWebhookAuth({ endpoint, headers, query, rawBody, resolveSecret });
    if (!auth.ok) return { kind: "auth_failed" as const };

    const eventDraft = buildEventDraft({ endpoint, headers, query, rawBody });
    return { kind: "accepted" as const, endpoint, eventDraft };
  })
  .mutate(({ forSchema, retrieveResult }) => {
    if (retrieveResult.kind !== "accepted") return retrieveResult;

    const uow = forSchema(webhookSchema);
    uow.create("webhookEvent", retrieveResult.eventDraft);
    uow.triggerHook("onWebhookEventReceived", { eventId: retrieveResult.eventDraft.id });
    return { kind: "created" as const, eventId: retrieveResult.eventDraft.id };
  })
  .execute();
```

- [ ] Map results to responses:
  - [ ] `created` -> `202 Accepted`
  - [ ] duplicate event create error -> `202 Accepted`
  - [ ] `not_found` -> `404 WEBHOOK_ENDPOINT_NOT_FOUND`
  - [ ] `disabled` -> `403 WEBHOOK_ENDPOINT_DISABLED`
  - [ ] `auth_failed` -> `401 WEBHOOK_AUTH_FAILED`
  - [ ] malformed request/config -> `400 WEBHOOK_BAD_REQUEST`
- [ ] Keep HMAC verification on raw body.
- [ ] Redact auth headers/query params before storing `headers`.

## Management routes: one transaction each

- [ ] `GET /endpoints`; retrieve-only, cursor pagination if lists can grow.
- [ ] `POST /endpoints`; mutate-only create.
- [ ] `GET /endpoints/:id`; retrieve-only by primary.
- [ ] `PATCH /endpoints/:id`; retrieve endpoint, validate, mutate update with OCC check.
- [ ] `DELETE /endpoints/:id` or disable route; prefer status update with OCC check.
- [ ] `GET /endpoints/:id/events`; retrieve events by `endpointId, receivedAt` with cursor
      pagination.
- [ ] `GET /events/:eventId`; retrieve event by primary.
- [ ] `POST /events/:eventId/reprocess`; retrieve event, validate not ignored, mutate trigger
      durable hook.
- [ ] `POST /events/:eventId/ignore`; retrieve event, mutate status to `ignored` with OCC check.

## Durable hook processing

- [ ] Define `onWebhookEventReceived` on the fragment.
- [ ] Hook payload is minimal: `{ eventId: string }`.
- [ ] Hook handler flow:
  - [ ] Retrieve event and endpoint in one hook `handlerTx()` read phase.
  - [ ] If event is missing, already `processed`, or `ignored`, return without side effects.
  - [ ] Parse raw body as JSON only if content type/body allows it.
  - [ ] Call `config.onEventReceived` with `this.idempotencyKey`, event id, endpoint id, headers,
        raw body, parsed JSON, and event metadata.
  - [ ] On success, update event to `processed` with OCC check.
  - [ ] On failure, update `lastError` in a small transaction if feasible, then rethrow so durable
        hooks retry.
- [ ] Callback implementations must be idempotent because hook execution is at-least-once; a crash
      after the callback but before marking `processed` can retry.
- [ ] Manual reprocess triggers the same hook for an existing event; it does not create a second
      event row.

## Durable Objects usage in Backoffice

- [ ] Use Durable Objects as the org-scoped runtime host for the fragment:
  - [ ] load stored Backoffice/org config,
  - [ ] initialize/migrate the fragment,
  - [ ] route fetches to the fragment,
  - [ ] forward alarms to Fragno durable hook dispatcher.
- [ ] Do not use DO storage as the webhook event log; event history belongs in the fragment DB.
- [ ] Do not implement a parallel DO alarm retry queue for webhook processing; use Fragno durable
      hooks.
- [ ] Use deterministic DO routing by org, e.g. `WEBHOOK_DO.getByName(orgId)`.
- [ ] Avoid a single global webhook DO.
- [ ] Revisit sharding only if one org-level DO becomes a throughput bottleneck; possible future
      shard key is `orgId:endpointId`, but that complicates org-level listing.

## Auth implementation

- [ ] Create `src/auth/verify.ts`.
- [ ] Runtime-neutral crypto helpers:
  - [ ] HMAC digest via Web Crypto.
  - [ ] Hex/base64/base64url decode.
  - [ ] Constant-time byte compare.
- [ ] Signature normalization:
  - [ ] Strip configured prefix, e.g. `sha256=`.
  - [ ] Support exact header value first; add multi-signature parsing only when needed.
- [ ] Replay protection:
  - [ ] Parse timestamp header as seconds or milliseconds.
  - [ ] Reject outside configured tolerance.
  - [ ] Include timestamp only in `timestamp_body` mode.
- [ ] Failure safety:
  - [ ] Generic error responses.
  - [ ] No event row for failed auth in MVP.
  - [ ] No secret/signature logging.

## Client exports

- [ ] Update `createWebhookFragmentClients` to expose endpoint/event hooks and mutators.
- [ ] Update React/Vue/Svelte/Solid/Vanilla client entrypoints if exported types change.
- [ ] Remove old skeleton `targetUrl` API; pre-1.0 breaking change is acceptable.

## Tests

- [ ] Unit-test auth verifier:
  - [ ] raw-body HMAC success/failure.
  - [ ] timestamped HMAC success/failure/replay rejection.
  - [ ] bearer success/failure.
  - [ ] header API key success/failure.
  - [ ] query API key success/failure.
  - [ ] basic auth success/failure.
  - [ ] timing-safe compare length mismatch.
- [ ] Route tests with `@fragno-dev/test` DB harness:
  - [ ] create endpoint.
  - [ ] receive valid event returns `202`.
  - [ ] invalid auth returns `401` and creates no event.
  - [ ] duplicate delivery returns `202`, creates one event, and enqueues one hook.
  - [ ] disabled endpoint rejects events.
- [ ] Durable hook tests:
  - [ ] accepted event invokes `onEventReceived`.
  - [ ] callback failure causes durable hook retry.
  - [ ] already processed/ignored event does not invoke callback.
  - [ ] manual reprocess re-enqueues processing.
- [ ] Type/build checks:
  - [ ] `pnpm exec turbo test --filter=@fragno-dev/webhook-fragment --output-logs=errors-only`
  - [ ] `pnpm exec turbo types:check --filter=@fragno-dev/webhook-fragment --output-logs=errors-only`
  - [ ] `pnpm exec turbo build --filter=@fragno-dev/webhook-fragment --output-logs=errors-only`

## Docs and README

- [ ] Update README with endpoint creation, HMAC setup, bearer/API key/basic setup, retries, dedupe,
      and idempotency guidance.
- [ ] Document source-driven retries vs internal durable hook retries.
- [ ] Document query-token auth as supported but discouraged.
- [ ] Add Backoffice DO integration notes.

## Acceptance criteria

- [ ] A Backoffice user can create an inbound endpoint with HMAC auth.
- [ ] A sender can `POST /receive/:id` and get `202` after durable acceptance.
- [ ] Invalid signatures are rejected without processing.
- [ ] Duplicate retries are accepted but processed once.
- [ ] User callback work happens in a durable hook, not the request path.
- [ ] Internal failures retry through Fragno durable hooks.
- [ ] All routes respect the one-`handlerTx()` rule.
- [ ] Secrets are never exposed in API responses or logs.
