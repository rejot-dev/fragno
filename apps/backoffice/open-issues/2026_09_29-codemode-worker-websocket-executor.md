# Run Node Backoffice codemode through a Worker WebSocket executor

Status: implemented locally; deployment validation pending

Created: September 29, 2026

## Implementation status

- `packages/codemode` contains the shared runtime, compiler contracts, bounded protocol/value codec,
  reentrant WebSocket peer, Node client, and ordinary Worker session.
- `apps/cf-sandbox-bridge/src/index.ts` intercepts codemode before the Sandbox SDK router. Existing
  Sandbox and WarmPool infrastructure remains unchanged; codemode adds no Durable Object.
- Backoffice's remote host retains tool dispatch, transactions, workflow decisions, and agent
  sessions. Production Node requires the bridge URL/key and no longer uses Deno. Cloudflare
  Backoffice still uses its local Worker Loader.
- Local validation passes: shared/bridge builds and tests, Backoffice Node build, type/lint checks,
  full Backoffice Node and Cloudflare suites, and workflow-package regressions. New scenarios cover
  SQLite-backed checkpoint replay, event consumption, restored Date timestamps, and interrupted-step
  retry decisions.
- No deployment was performed. VPS-to-deployed-bridge lifecycle/resource probes and operational
  verification with the deployed compiler remain rollout prerequisites. Local workerd tests do not
  prove deployed CPU enforcement or deployment-time disconnect behavior.

The sections below retain the design and acceptance checklist; the implementation status above does
not claim that every rollout probe has been completed.

## Goal

Move Node Backoffice codemode execution out of the VPS process and into an ordinary Worker handler
in `apps/cf-sandbox-bridge`. Node opens one authenticated WebSocket per activation. The bridge
compiles and runs untrusted code in a dynamically loaded Worker; every Backoffice operation returns
to Node over that connection.

```text
Node Backoffice                         cf-sandbox-bridge

trusted execution context               ordinary Worker WebSocket handler
runtime tools                 <── WS ──> connection-local call/callback maps
workflow step host                       compiler service
workflow and application data            Worker Loader sandbox
```

No executor Durable Object, storage, migration, alarm, hibernation, execution registry, or reconnect
protocol is needed. Losing the connection interrupts that activation. Durable state stays in Node.

## Decisions

### One connection per activation, not per step

An immediate expression, JavaScript module, or workflow activation receives a fresh Node-generated
execution ID and a fresh connection. The ID is for correlation, not routing or deduplication.

One workflow activation runs the workflow from the beginning in one dynamic Worker. It may execute
multiple steps and nested callbacks. Completed steps return Node-owned checkpoints without invoking
their callbacks. A suspension ends the activation; a later workflow tick creates a new connection
and dynamic Worker. Individual steps do not get individual executor instances.

### Ordinary Worker WebSocket handling

Accept the socket directly in the bridge Worker using `WebSocketPair`, `server.accept()`, and
connection-local listeners. Do not forward it to a Durable Object or share execution capabilities
through module-global maps.

The connection owns pending calls, callback references, deadlines, and the active dynamic Worker RPC
call. All of that state is ephemeral. There is no attach-to-existing-execution API and no attempt to
preserve JavaScript continuations after a disconnect or deployment.

Keep the existing Sandbox SDK routes, `Sandbox` and `WarmPool` exports, container, bindings, and
migrations intact. Codemode uses the Worker Loader, not the Sandbox SDK container.

### Node owns all Backoffice authority

Node retains:

- trusted `BackofficeExecutionContext` and route-backed runtime construction;
- runtime-tool discovery, authorization, input/output parsing, and audit records;
- scoped context operations and dynamically discovered MCP providers;
- Backoffice object and SQLite access;
- `RemoteWorkflowStepHost`, checkpoints, retries, suspension, events, and emissions;
- allowed hook resolution and durable workflow Pi agent sessions;
- workflow-definition validation and instance scheduling.

The bridge receives source, dependencies, guest API manifests, and activation inputs. It never
receives database handles, Backoffice bindings, integration secrets, or permission to execute
Backoffice operations independently. The guest cannot see the socket or its credentials.

### Preserve execution semantics, not the old transport

Reuse the generated guest runtime and existing workflow host behavior. Do not copy the Deno bridge's
generic remote-object reflection onto the network boundary. Support explicit operations for today's
provider, workflow, transaction, and event APIs.

Do not build an executor recovery engine. Node interprets interruption through its workflow runtime;
the bridge neither retries activations nor schedules workflow ticks.

## Original code to reuse (planning inventory)

- `apps/backoffice/app/fragno/codemode/runtime-api.ts`: provider dispatch and binary encoding.
- `apps/backoffice/app/fragno/codemode/codemode-executor.ts`: guest module generation and dynamic
  Worker execution.
- `apps/backoffice/app/fragno/codemode/execute.ts`: Node-owned provider construction, including
  scoped context and MCP providers.
- `apps/backoffice/app/fragno/codemode/javascript-module-execute.ts`: ES-module execution without
  invoking exports. This also uses the Node loader and must migrate before Deno is removed.
- `apps/backoffice/app/fragno/codemode/workflow-execute.ts`: guest workflow API, nested scopes, and
  transaction flushing.
- `packages/fragment-workflows/src/remote-workflow-message.ts`: explicit host requests, callback
  invocation, transaction handles, and `onConsume`. Reuse its behavior, not its permissive message
  validation or incomplete error reconstruction.
- `apps/backoffice/app/backoffice-runtime/node/deno-worker-loader.ts`: evidence for value limits,
  bounded pending calls, write queues, and disconnect cleanup.

Extract generic protocol and execution code into one narrow shared package with separate entry
points for transport-neutral contracts and Cloudflare executor code. Node must be able to import
contracts without loading `cloudflare:workers`. Keep runtime tools, authorization, MCP discovery,
route-backed contexts, and durable Pi agents in Backoffice. No app-to-app imports and no second copy
of the injected guest runtime.

## Protocol

### Connection and version

Expose an authenticated route separate from the Sandbox SDK session and PTY routes:

```text
GET /v1/codemode/execute
Upgrade: websocket
Authorization: Bearer <SANDBOX_API_KEY>
```

Validate method, path, upgrade, and bearer authentication before accepting. Fail closed if the key
is not configured, including local development. Require `wss://` outside explicit local development.
Do not accept callback URLs or put credentials in query parameters.

Install listeners before returning the upgrade response. Node sends `start` when its socket opens;
there is no separate `ready` exchange. The first message includes `protocolVersion: 1` and the
execution ID. Reject incompatible versions before compiling or running code. The URL and first
message establish the version once; do not repeat execution identity on every frame.

Each connection accepts exactly one activation. A new connection is always a new attempt, even if a
caller repeats an execution ID; this protocol provides no cross-connection deduplication.

### Five message kinds

Use exact discriminated schemas, not an envelope with arbitrary methods or optional payload fields.

| Kind       | Direction     | Purpose                                                                     |
| ---------- | ------------- | --------------------------------------------------------------------------- |
| `start`    | Node → bridge | Version, execution ID, and activation input                                 |
| `call`     | Either        | Call ID plus an explicit operation variant                                  |
| `return`   | Either        | Matching call ID and a typed success, error, or permitted suspension result |
| `complete` | Bridge → Node | Terminal activation result, including bounded logs                          |
| `cancel`   | Node → bridge | End the activation                                                          |

Separate caller ID namespaces by direction. A `return` answers a peer's outstanding `call`; it never
introduces another request. Reject duplicate calls, unknown or settled result IDs, wrong-role
operations, and unknown handles. Bound correlation bookkeeping for the complete activation.

Calls are reentrant: while awaiting a return, both peers must continue receiving and dispatching
other messages. Do not serialize all message handling behind the pending activation or callback.

Operation variants cover only:

- bridge → Node: exposed provider calls, scoped context operations, workflow step operations, and
  supported transaction/event operations;
- Node → bridge: registered step callbacks, `onConsume` callbacks, and active event deliveries.

Use these operation variants inside `call`; do not add a separate message family per feature.

### Values and errors

Define the supported value contract at the shared boundary. Preserve binary bytes and array buffers,
`undefined`, and workflow `Date` values, including `sleepUntil(Date)` and event timestamps. Account
explicitly for bigint and special numbers supported by the former Deno transport. Reject unsupported
or cyclic values rather than silently changing them through JSON serialization.

Keep existing provider binary semantics. Scope any richer workflow/result encoding to values that
need it; no arbitrary object references or callable properties cross the socket. Codec tags must not
silently reinterpret ordinary user objects.

Use typed errors that distinguish guest/tool failure, workflow suspension, and transport
interruption. Preserve error information required by current permanent-error and event-timeout
behavior. Do not reconstruct every error as a generic string or infer suspension from arbitrary user
result data. Node remains the authority for suspension and checkpoint outcomes.

### Immediate expression and module activations

`start` carries an exact activation variant: immediate expression, JavaScript module, or workflow.
Include source, dependencies where supported, and the Node-built provider manifest. Sandbox policy
is fixed by the bridge, not selected by guest input.

For a provider call, Node resolves the operation through the activation's exposed provider table.
Preserve canonical tool identity and sanitization. Ordinary tools and MCP tools continue through
`executeBackofficeRuntimeTool()`; scoped context operations retain their existing scope checks and
Node-owned context construction. Do not assume every provider is a static `runtimeToolFamilies`
entry or expose every registered tool to every activation.

Return the same observable immediate result fields: result/error, compiler warnings, bounded logs,
and a workflow definition when produced. Node assembles authoritative tool-call audit records from
its own dispatches, not bridge-supplied tool identities. Logs are returned on completion; live log
streaming is not part of this issue. Abrupt interruption may lose guest logs.

A returned `defineWorkflow(...)` definition still goes through Node's
`prepareCodemodeWorkflowInstance()` and `createCodemodeWorkflowInstanceInput()`. The executor never
creates a workflow instance. Preserve module execution semantics separately from expression
invocation; do not turn a JavaScript file into an implicitly invoked exported function.

### Workflow activations

Workflow input includes source/dependencies, the workflow event, allowed hook identities, and
exposed providers. Node owns the actual host objects.

For `step.do`:

1. The guest registers its callback; the bridge calls Node with callback ID, parent scope, name, and
   config.
2. Node invokes `RemoteWorkflowStepHost.do`. A checkpoint hit returns without invoking the guest.
3. For a new body, Node calls the registered guest callback with a transaction ID and child scope.
4. The guest may call Node tools, nested steps, and supported transaction operations.
5. The guest flushes queued transaction operations before returning the callback result, including
   on failure, as the current generated runtime does.
6. Node applies its existing checkpoint/commit rules and returns the canonical step outcome.
7. Both peers release the callback and transaction capabilities when their owning operation ends.

Preserve nested scope identity and same-name nested/top-level behavior. Transaction IDs are valid
only for their owning active callback; later use fails with `REMOTE_WORKFLOW_TX_NOT_FOUND`.

`step.sleep`, `step.sleepUntil`, and `step.waitForEvent` stay Node-hosted. Propagate the host's
typed suspension through the existing remote-workflow suspension behavior, unwind the guest, return
a suspended completion, and close the connection. Node's runner persists the suspension through its
normal path. A later tick replays source in a new activation.

Support only the current remote transaction surface:

- `emit`, `previousEmissions`, and `previousConsumedEvents`;
- `workflowServiceCalls` and allowed `triggerHook` operations;
- `onEvent`, event consumption, and unsubscribe.

Continue rejecting remote `mutate`, arbitrary `serviceCalls`, and terminal-error mutation with the
existing named errors.

`waitForEvent.onConsume` and `tx.onEvent` use registered guest callbacks. Active subscriptions and
event deliveries have explicit IDs. Represent `event.consume()` as a Node-directed operation or
callback-result intent, not a serialized function. Consumption commits only with the owning step.
Define unsubscribe/in-flight delivery ordering; step completion or connection closure removes all
subscriptions and rejects late use. Keep the transaction capabilities of `onConsume` restricted to
its existing consume-transaction surface.

## Connection lifecycle and failures

Use connection-local states: awaiting start, running, closing, closed. The close path is idempotent
and shared by completion, cancellation, deadline, malformed input, socket error, and disconnect.

- Bound connect/upgrade, time-to-start, compilation, pending calls, and total activation duration.
- Validate and register calls before starting asynchronous work; keep receiving nested calls while
  awaiting results.
- On termination, stop admitting operations, reject pending calls, revoke transaction/callback
  handles, unsubscribe events, cancel the active guest RPC call, and dispose its entrypoint.
- Abort Node-owned tool work where supported. Dropping a promise does not cancel its work.
- Send at most one `complete` if the socket is usable, then close. Do not promise delivery of a
  terminal frame after network or Worker failure.
- Node treats closure without a valid completion as interruption, even if the WebSocket close code
  is normal. It does not reconnect or replay an immediate invocation automatically.
- A silent or half-open connection is bounded by Node's own deadlines, independent of bridge timers.

No lifecycle records or terminal results are persisted in the bridge. A lost completion is an
unknown execution outcome, not proof that no tool ran. Reconnecting starts over; it cannot recover
old logs, results, or JavaScript continuations.

### Workflow failure mapping

Do not promise that every disconnect is automatically retryable. The current workflow runner turns
ordinary errors escaping outside a step into an errored outcome. Preserve that distinction rather
than labelling an interruption retryable without a scheduling mechanism.

Before switching Node production, specify and test these mappings through the real runner:

- normal host suspension follows the existing sleep/event/retry scheduling path;
- an interrupted active step follows its existing retry/failure policy when the host can record that
  outcome; if transport loss prevents normal suspension propagation, Node must still observe the
  authoritative host outcome rather than overwrite it with a generic socket error;
- failures before a step or between steps follow the current workflow failure path; adding a new
  automatic infrastructure-retry policy is not part of this transport migration;
- a later permitted retry/replay uses Node-owned checkpoints, never executor state.

Runtime-tool effects are not atomic with workflow checkpoints. A tool can succeed before a socket
loss prevents the step from committing, and retrying can repeat that effect. Preserve existing
idempotency mechanisms and document the at-least-once boundary. Never use the fresh execution ID as
a stable effect-idempotency key or claim that cancellation rolls back completed mutations.

## Sandbox and resource limits

Preserve Node's sealed sandbox: `globalOutbound: null`, no host credentials or bindings in guest
code, and no caller-selected egress policy. Runtime tools are the path to Backoffice integrations.

Define authoritative limits in the shared package and enforce them at the relevant boundary:

- source, bundle, dependency, manifest, frame, and binary sizes;
- value depth/count and collection entries;
- active calls, callbacks, transactions, subscriptions, and total messages;
- outbound queued bytes and slow-peer behavior;
- log count and total log bytes;
- connect/start/compiler/call/activation deadlines;
- fixed guest CPU and subrequest limits.

Use the former Deno limits as evidence, not its generic reflection protocol. Fail the activation on
a protocol violation; do not build a recoverable violation counter. Enforce logs at collection time,
not only while serializing completion. Prove CPU-bound guest termination as well as async timeout
cleanup. Keep Node's concurrent activation admission bounded; no distributed executor scheduler is
needed for this issue.

## Implementation plan

### 1. Prove the ordinary Worker execution path

Add the authenticated WebSocket route in the bridge's application-specific fetch handling. Add only
`LOADER` and regenerate Worker types. Compilation lives directly in the bridge. Its private
`CodemodeCompiler` RPC entrypoint also serves Cloudflare Backoffice's `CODEMODE_COMPILER` binding,
replacing the standalone compiler deployment while preserving Backoffice's local Worker Loader. Do
not add or change Durable Object migrations for codemode.

Exercise a minimal real dynamic Worker → Node call → guest callback → Node call conversation over
one socket, locally and in the deployed bridge. Verify concurrent message handling, cancellation,
and cleanup on both peers. Establish this lifecycle before moving all runtime code.

Completion criterion: a nested round trip and an interrupted execution work without any executor DO,
registry, or callback URL; existing Sandbox routes remain available.

### 2. Share the protocol and guest runtime

Create the narrow shared package with explicit message/operation schemas, value/error encoding,
limits, duplex correlation, and Cloudflare-only execution entry points. Extract generic provider and
guest module generation from the existing executor, including workflow and module semantics.

Keep the workflow host contract canonical in `@fragno-dev/workflows`; adapt its existing message
behavior rather than inventing a second workflow engine. Keep application ownership in Backoffice.
Cloudflare-hosted Backoffice continues using its local loader with the same generated guest runtime.

Completion criterion: Node and the bridge share one contract and runtime implementation without
production app-to-app source imports or Cloudflare-only imports entering the Node protocol
dependency graph. Backoffice's Cloudflare tests may import the bridge-owned compiler functions
directly; the bridge's own tests cover the private RPC boundary.

### 3. Migrate immediate and module execution

Implement the Node client and bridge provider proxies. Construct the trusted context and exposed
provider table on Node before dispatch. Cover ordinary tools, scoped context operations, MCP tools,
binary values, module execution, compiler warnings, logs, audit records, and workflow definitions.

Both Node web and processor processes load the same bridge URL and API key from `.dev.vars`.
Configuration and connection failures must be actionable; do not silently fall back to Deno.

Completion criterion: immediate expressions and JavaScript files run remotely with the same
observable Backoffice behavior and Node authorization as the current paths.

### 4. Bridge workflow and agent operations

Implement step callbacks, scope identity, transaction flushing, suspension, event callbacks,
consumption/disposal, and prompt-local agent tools through `call`/`return`. Keep persistence and
failure decisions in the existing Node hosts. Implement the interruption mapping described above.

Completion criterion: workflow replay, suspension, nested operations, and agent restoration pass
through the real Node workflow runner and SQLite persistence without new executor persistence.

### 5. Replace Node production assembly and document operations

Remove the Deno subprocess/loader requirement only after all three activation variants pass. Update
Node configuration, README, `.dev.vars.example`, and scenario setup. No hidden local executor
remains in production assembly; local development uses the Wrangler bridge.

Record bounded execution metadata across Node, bridge, compiler, and guest lifecycle: execution ID,
activation kind, workflow instance ID where applicable, duration, call/message counts, and outcome.
Do not log source, arguments, results, events, prompts, secrets, or binary content by default. Guest
console logs belong in the bounded caller result, not automatic operational telemetry.

Completion criterion: Node runs without Deno, Cloudflare Backoffice retains local-loader behavior,
and a failure can be correlated without recording user data.

## Verification

### Protocol and ordinary Worker tests

- Exact message/operation variants, version rejection, wrong-role operations, and duplicate or
  unknown call/result IDs.
- Supported values round-trip, including binary data, dates, and undefined; malformed, cyclic, and
  oversized values fail at the boundary.
- Authentication fails closed, including absent server credentials; invalid upgrades fail before
  accepting a socket.
- One `start` per connection, no operations before start, and no automatic reconnect/resume.
- Reentrant calls remain live while the outer call is pending; parallel calls remain bounded.
- Completion, cancellation, timeout, malformed frames, peer loss, and slow readers dispose all
  connection-local capabilities and settle pending promises.
- Compile stalls, tight guest loops, log floods, and queued-byte limits terminate within policy.
- Existing Sandbox bridge and warm-pool routes remain available; no codemode DO is introduced.

### Backoffice scenarios

Use real route-backed operations, the workflow runner, SQLite persistence, and final-state
assertions. Do not replace these with protocol-only mocks.

1. Organization-scoped immediate execution reads/writes state through a Node SQLite-backed object.
2. Permission denial and scoped context access preserve current validation and detailed errors.
3. A dynamically discovered MCP provider executes and records its canonical Node-owned audit entry.
4. Binary upload values survive the round trip; a JavaScript file retains ES-module semantics.
5. A returned workflow definition is validated and scheduled once by Node, not by the executor.
6. Multiple steps run in one activation; a later activation replays committed results without
   re-running callbacks. Nested and top-level same-name steps remain distinct.
7. Sleeps and event waits suspend and resume on a fresh connection; `sleepUntil(Date)` and event
   timestamps preserve their types.
8. `onConsume`, emissions, previous emissions/consumed events, workflow service calls, and allowed
   hooks retain current behavior. Queued transaction calls flush before callback completion.
9. `tx.onEvent` delivery, `consume()`, unsubscribe, and in-flight disposal preserve commit
   boundaries.
10. Agent prompts restore durable sessions; prompt-local tools execute in the guest; overlapping
    prompts retain the existing rejection.
11. Disconnects before the first step, during a callback, between steps, after a checkpoint, and
    before terminal delivery produce the documented Node outcomes without false success.
12. A tool succeeding before disconnect does not imply a committed step or rollback; permitted
    retries respect the operation's existing idempotency behavior.
13. Cancellation rejects late capability use and does not leave detached prompts/subscriptions; a
    later activation observes capability revocation.

### Operational verification and rollout

1. Deploy a compiler version compatible with both Cloudflare Backoffice and the shared executor.
2. Deploy the bridge WebSocket route, loader/compiler bindings, and protocol v1. There is no new
   Durable Object migration.
3. Verify authenticated immediate, module, nested workflow, suspension, and interruption probes from
   Node locally and from the VPS over `wss://`.
4. Configure the Node web and processor processes and deploy the remote client.
5. Exercise bridge unavailability, active-connection loss during deployment, and recovery through
   existing Node workflow management. Retain protocol v1 support during rollback.
6. Remove the Deno production dependency once the remote path is proven.

Run relevant package builds, type checks, scenario tests, lint, formatting, and generated Worker
type checks. Verify Cloudflare Backoffice's existing local execution tests against the shared guest
runtime. Use a new explicit protocol version for incompatible independently deployed changes.

## Non-goals

- Executor Durable Objects, persistent lifecycle records, alarms, hibernation, or named routing.
- Reconnection, execution lookup, terminal-result retention, or continuation recovery.
- A new workflow engine, infrastructure retry scheduler, or exactly-once tool execution layer.
- Callback HTTP endpoints, caller-supplied callback URLs, or HTTP streaming/polling alternatives.
- Generic remote-object reflection or an extensible transport framework.
- Live log streaming, compilation caching, multiple observers, or distributed admission scheduling.
- Guest internet access, Sandbox SDK container execution, or direct executor access to Backoffice
  data.
- Moving Cloudflare Backoffice onto the WebSocket path or expanding the remote transaction API.

## Acceptance criteria

- Node uses one authenticated ordinary Worker WebSocket per expression, module, or workflow
  activation.
- Codemode adds no Durable Object, migration, persistent executor state, or reconnect machinery.
- One small explicit duplex protocol preserves nested calls and bounded connection-local resources.
- All Backoffice authorization, runtime tools, scoped/MCP operations, workflow state, and agent
  persistence remain Node-owned.
- Suspension closes the activation; later ticks replay Node-owned checkpoints in a fresh sandbox.
- Interruption and ambiguous side effects are handled through documented Node behavior, not claimed
  transparent recovery or rollback.
- Node no longer needs Deno or a production local loader and has no silent fallback.
- Existing Sandbox bridge behavior and Cloudflare Backoffice guest semantics remain intact.
- Relevant scenarios, builds, type checks, lint, formatting, and generated Worker type checks pass.
