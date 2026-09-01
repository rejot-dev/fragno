# Backoffice request-owned transport and async ownership

Status: open follow-up

Created: August 27, 2026

Last updated: September 1, 2026

The foundational implementation is complete. The remaining work is mechanical enforcement and
trace-level regression coverage.

The implementation belongs **at the object-transport and async-ownership primitives**, not route by
route.

## Non-negotiable invariant

A foreground trace may contain:

- Authentication and authorization.
- Bounded work explicitly awaited by the request.
- Storage needed to produce the response.

It must never contain:

- Polling after a non-streaming response completes.
- Work owned by another HTTP stream.
- Alarm or durable-hook processing.
- A loop inherited from an earlier invocation.
- Work executed through a long-lived returned `RpcTarget`.

## 1. Separate HTTP transport from RPC commands

Introduce an explicit handle:

```ts
type BackofficeObjectHandle<TCommands> = {
  commands: TCommands;
  http: {
    fetch(request: Request): Promise<Response>;
    fetchAuthorized(request: Request, context: BackofficeActionRpcContext): Promise<Response>;
  };
};
```

Rules:

- `commands.*` uses RPC and returns finite serializable values.
- `http.*` always calls native `DurableObjectStub.fetch()`.
- No RPC method may accept `Request` or return `Response`, streams, or `RpcTarget`.
- `fetchWithContext()` is deleted.

Cloudflare explicitly treats `fetch()` as the special HTTP request/response path; that is the
appropriate boundary when transferring a `Request` and `Response`.

This fixes every future streaming route automatically, including:

- Workflows emissions.
- Pi session events.
- Pi/Workflows outbox streams.
- Pi long polling.
- API/MCP streams added later.

## 2. Delete the `init(scope) -> RpcTarget` pattern

The initialized proxy is fundamentally unsafe:

```text
init(scope) -> returned RpcTarget -> method -> potentially long-lived result
```

Instead, derive object scope from its identity in the constructor:

```ts
const encodedName = ctx.id.name;
const scope = decodeBackofficeObjectScope(encodedName);
```

Cloudflare has exposed names created by `idFromName()` through `ctx.id.name` since March 15, 2026.

Then:

- Pass the scope into `InMemoryAutomationsObject` at construction.
- Delete `RemoteInitializableScopedObject`.
- Delete `scopedInitializedObject`.
- Delete `init()` from API, Automations, Billing, Telegram, and MCP.
- Let the registry return raw named stubs.

For alarms created before March 15, 2026, use the persisted configured scope as a temporary fallback
or explicitly reschedule them after deployment.

> **Deferred simplification:** Current `v1` Backoffice object addresses are created exclusively with
> `idFromName()`, so a valid production object should always have `ctx.id.name`. In a later cleanup,
> make `backofficeContextScopeFromDurableObjectId()` throw instead of returning `null`, remove scope
> restoration from persisted storage, and delete `initializeFromOwnerScope()` plus the
> scoped-runtime helper if API and MCP no longer need it. Fragment runtime creation and migration
> must still run inside `blockConcurrencyWhile`; only the nullable identity and persisted-scope
> fallback should be removed. Do not include this cleanup in the current transport migration.

This also fixes cold initialization’s `scope_kind = unknown`.

## 3. Carry authorization through a trusted fetch envelope

`fetchWithContext()` currently exists because Pi and Workflows need `BackofficeExecutionContext`.

Replace it with a signed internal request envelope:

```text
x-backoffice-internal-context: <signed, encoded context>
```

The envelope should bind:

- Object address.
- HTTP method.
- Internal pathname.
- Execution context.
- Propagation context.
- Issued-at and expiry.
- Request identity.

The route Worker must:

1. Authenticate normally.
2. Remove any caller-provided internal header.
3. Construct and sign the envelope.
4. Call native `stub.fetch()`.

The Durable Object must:

1. Verify the signature.
2. Validate the decoded schema.
3. Assert envelope scope equals object identity.
4. Remove the internal header.
5. Pass explicit context into the fragment host.

In-memory scenarios should exercise the same encode/decode boundary rather than bypassing it.

## 4. Never return capability objects from Durable Object RPC

`getDurableHookRepository()` is another instance of the same dangerous shape: it returns a nested
`RpcTarget`.

Flatten it:

```ts
commands.getDurableHookQueue(fragment, options);
commands.getDurableHook(fragment, hookId, options);
```

Delete `createDurableHookRepositoryRpcTarget()` from the Durable Object boundary.

Cloudflare RPC targets remain alive while their remote stubs exist, and explicit disposal is
recommended. Avoiding returned capabilities entirely is stronger than relying on every caller to
dispose correctly.

## 5. Give every asynchronous loop an explicit owner

Native fetch fixes transport contamination, but the shared `BufferedDatabasePump` still has a
detached self-running timer:

```ts
void this.#run(...)
```

That means the loop inherits whichever invocation happened to start it.

Refactor the pump into:

- Shared buffered state.
- Serialized `flushNow()`.
- One elected scheduler loop per pump and process.
- Explicit writer and observer scheduler leases.

For example:

```ts
await pump.runWhile({
  kind: "writer",
  signal: workflowSignal,
  handlerTx,
});
```

Rules:

- A running workflow owns a writer lease even when no observer is connected.
- HTTP streams own observer leases so another process can still discover database changes.
- The pump elects exactly one active scheduler. Additional leases do not add polling round trips.
- Writer leases take priority. An observer yields before the next scheduled pass when a writer
  arrives.
- Observer-owned passes are read-only. They never drain writable scopes or persist another actor's
  buffered work.
- A local observer remains passive while a workflow writer is active. Its recurring storage spans
  belong to the workflow invocation instead of the connected stream.
- If no local writer exists, one observer becomes the cross-process polling fallback. In that case,
  the polling spans necessarily belong to the elected observer invocation.
- Closing an actor aborts and drains its lease before the actor's response or callback completes.
- No asynchronous I/O loop is launched with `void`.

A live Cloudflare trace on August 27, 2026 confirmed the handoff: the connected observer's storage
span count stopped while an alarm-owned workflow writer ran, the writer's storage spans appeared
under the alarm trace, and observer polling resumed after the workflow finished.

## 6. Make background work a durable handoff

Durable-hook and outbox processing should follow:

```text
foreground mutation
  -> await durable enqueue/alarm scheduling
  -> response completes

separate alarm invocation
  -> process background work
```

Do not use `DurableObjectState.waitUntil()` as a background boundary. Cloudflare documents that it
has no effect on Durable Object lifetime or request/RPC completion.
([developers.cloudflare.com](https://developers.cloudflare.com/durable-objects/api/state/?utm_source=openai))

> **Implemented September 1, 2026:** Post-mutate notification now awaits alarm reconciliation,
> Cloudflare alarms own claimed hook completion and follow-up scheduling, async error observers are
> awaited, dispatcher setup failures prevent runtime exposure, and Backoffice Durable Object
> fragment hosts no longer pass `waitUntil` into request handling.

Therefore:

- Hook notification should synchronously await alarm scheduling.
- Actual hook processing belongs exclusively to `alarm()`.
- Constructors must await initialization scheduling inside `blockConcurrencyWhile`.
- No unawaited storage or network promise may survive a normal request.

## 7. Avoid self-RPC inside Automations

Runtime tools running inside the Automations Durable Object should not call the same Automations
object through `fetchWithContext()` or a binding.

Provide a local operation:

```ts
handleHostedFragmentRequest(request, lifecycleContext);
```

Use:

- Native stub fetch across Worker → Durable Object.
- Direct local invocation inside the owning Durable Object.
- Never RPC or fetch back into the same object.

## 8. Enforce it mechanically

Add an architecture check that fails compilation if a public DO RPC method, other than reserved
`fetch`, transitively contains:

```ts
Request;
Response;
ReadableStream;
WritableStream;
RpcTarget;
```

Also reject:

- `fetchWithContext`.
- Public `init()` returning an object.
- Returned repository/capability targets.
- Unowned `void` I/O loops in Durable Object/runtime code.

## Required regression scenarios

1. Open a Workflows stream and issue foreground Files requests.
2. Open two streams for the same workflow; close the first and prove its trace stops growing.
3. Keep Pi events active while navigating through Backoffice.
4. Run `wait-for-agent-end` concurrently with foreground traffic.
5. Throttle a Telegram download while invoking Telegram administration.
6. Trigger a durable hook and prove processing occurs under an alarm trace.
7. Cancel every stream and assert its storage span count freezes promptly.
8. Assert no storage parent is an incomplete `init`, `fetchWithContext`, or repository JSRPC span.

## Recommended migration order

1. Add the failing trace regressions.
2. Derive scope from object identity and remove `init()`.
3. Split object handles into `commands` and `http`.
4. Add the trusted internal fetch envelope.
5. Migrate Pi, Workflows, API, MCP, and Telegram.
6. Flatten durable-hook RPC targets.
7. Make pump schedulers actor-owned.
8. Remove Durable Object `waitUntil` and unawaited I/O.

The key principle is:

> **HTTP bodies cross only native fetch boundaries. RPC crosses only finite values. Async loops
> never outlive their explicit actor.**
