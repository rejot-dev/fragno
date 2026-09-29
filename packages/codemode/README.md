# @fragno-dev/codemode

The shared machinery for running JavaScript in a sandbox while letting that JavaScript call trusted
application tools. This is a private workspace package used by Backoffice and the Cloudflare Sandbox
bridge, not a standalone workflow engine or database layer.

**The central idea: run the user's code in Cloudflare, but keep application authority on the host.**
For Node Backoffice, the host stays in Node: tools, authorization, database access, workflow
checkpoints, and agent sessions do not move into the sandbox.

## The three participants

```text
Node Backoffice                  cf-sandbox-bridge               Dynamic Worker
(trusted host)                   (ordinary Worker)              (untrusted guest)

source + tool-name manifest ----> compile through compiler
                                 service; load guest ----------> execute JavaScript

real tool implementation <------ WebSocket call <--------------- tool proxy
                         ------> WebSocket return -------------> result

workflow checkpoints <---------> step/callback forwarding <-----> workflow function
```

- **Host:** implements the operations the guest is allowed to request. Backoffice constructs this
  with the current execution context and permissions.
- **Bridge:** authenticates the WebSocket, compiles source, starts a dynamic Worker with `LOADER`,
  and forwards calls. It does not independently implement Backoffice tools.
- **Guest:** executes the supplied JavaScript. Its tool and workflow APIs are proxies, not database
  handles or copies of the host's implementation.

The bridge is an ordinary Worker, not an executor Durable Object. The dynamic Worker is the actual
sandbox; the existing Sandbox SDK containers and WarmPool are separate infrastructure.

## What is an activation?

An **activation** is one invocation of guest code. In the remote path, it owns one fresh WebSocket,
execution ID, and dynamic Worker. There are three kinds:

| Kind        | What runs                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `immediate` | A JavaScript function expression, invoked to produce a result. It can also return a workflow definition for Backoffice to validate and schedule. |
| `module`    | An ES module, including its top-level effects. Its exports are not implicitly invoked.                                                           |
| `workflow`  | One execution of a workflow function, with its event and proxied step/agent APIs.                                                                |

**A workflow step is not a separate sandbox.** One activation can execute several steps and nested
callbacks. When the host suspends the workflow for a checkpoint, sleep, event, or retry, that
activation ends. A later runner tick starts a fresh activation and runs the function from the
beginning. The host supplies completed step results from its checkpoints instead of invoking those
callbacks again. JavaScript continuations are not saved.

Code outside checkpointed steps therefore runs again on replay; the transport does not make those
side effects exactly-once.

## Why a WebSocket rather than a single HTTP response?

Execution is a conversation, and either side can need the other while already handling a call. For
example, a workflow step callback can call a Backoffice tool:

```text
1. Guest calls step.do("save", callback).
2. Bridge asks Node to run the step, sending a callback handle.
3. Node checks its checkpoint. If the callback is needed, Node calls back into the guest.
4. Guest callback calls context.current.store.set(...).
5. Bridge asks Node to execute that tool; Node returns the tool result.
6. Guest finishes the callback; Node applies its step/checkpoint rules.
7. The step result or suspension returns to the guest.
```

The original step call is still pending during steps 3–6. `CodemodePeer` correlates replies and
processes incoming calls without blocking the receive loop on earlier calls. Serially awaiting each
incoming request would deadlock this example. Agent tools and workflow event callbacks use the same
bidirectional mechanism.

The IDs crossing the socket identify callbacks, transactions, subscriptions, and deliveries within
that activation. They are temporary capabilities, not arbitrary remote-object property access or
persistent references.

## Two execution paths, one guest runtime

- **Node Backoffice:** `createCodemodeNodeExecutor()` opens the authenticated bridge connection. The
  bridge uses `DynamicWorkerExecutor` to run the guest and WebSocket adapters to reach Node.
- **Cloudflare Backoffice:** uses its own Worker Loader and Cloudflare RPC targets directly. It
  shares the executor and generated guest API, but does not take the WebSocket detour.

There is no Node-local Deno fallback. Keeping the guest source generation here prevents the local
and remote paths from independently defining what `step.do`, tool calls, or module execution mean.

## Code map

```text
src/
  compiler/          # Compiler contracts, bundles, and service protocol/client
  transport/         # WebSocket protocol, codecs, peer, and Node client
  worker/            # Worker execution, RPC targets, and generated guest source
  testing/           # Reusable workerd test server
  runtime-api.ts     # Shared provider and result API
  codemode-limits.ts # Shared resource policy
```

Tests live beside the source they exercise; `testing/` contains the reusable test server, not the
test suites. Transport modules do not import `worker/`, so the Node client cannot accidentally load
Cloudflare RPC runtime code.

`worker/codemode-guest-source.ts` contains pure source builders: `createCodemodeExpressionSource`,
`createCodemodeModuleSource`, and `createCodemodeProviderProxySource`. Expression/module evaluation
timeouts are supplied to these builders, not to `DynamicWorkerExecutor`. The executor accepts
compiled bundles and owns their loading and disposal. `workflow-source.ts` shares the guest codec
directly without importing the executor.

Start with the first three files below to follow an activation end to end.

| File                                                                                                                                                                                                                                                             | Responsibility                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`codemode-node-client.ts`](src/transport/codemode-node-client.ts)                                                                                                                                                                                               | Node connection, authentication header, activation deadline, host cleanup, and authoritative host outcome handling.                                  |
| [`codemode-worker-session.ts`](src/worker/codemode-worker-session.ts)                                                                                                                                                                                            | HTTP upgrade/authentication, connection-local bridge lifecycle, compilation, and guest execution.                                                    |
| [`codemode-protocol.ts`](src/transport/codemode-protocol.ts)                                                                                                                                                                                                     | Validated activation/message/operation shapes and the `CodemodeRemoteExecutor` host contract.                                                        |
| [`codemode-peer.ts`](src/transport/codemode-peer.ts)                                                                                                                                                                                                             | Reentrant call/reply correlation, connection state, limits, and rejection of pending calls on close.                                                 |
| [`codemode-guest-targets.ts`](src/worker/codemode-guest-targets.ts)                                                                                                                                                                                              | Adapts guest-facing Cloudflare RPC targets to WebSocket operations; owns temporary callback handles.                                                 |
| [`codemode-executor.ts`](src/worker/codemode-executor.ts)                                                                                                                                                                                                        | Dynamic Worker loading, provider target assembly, and RPC/entrypoint disposal.                                                                       |
| [`codemode-guest-source.ts`](src/worker/codemode-guest-source.ts)                                                                                                                                                                                                | Pure expression/module source builders, provider proxies, and shared guest codec.                                                                    |
| [`workflow-source.ts`](src/worker/workflow-source.ts)                                                                                                                                                                                                            | Generated workflow guest API, callback wrapping, transaction flushing, and suspension propagation.                                                   |
| [`runtime-api.ts`](src/runtime-api.ts), [`codemode-dispatcher.ts`](src/worker/codemode-dispatcher.ts)                                                                                                                                                            | Provider/result contracts and dispatch of exposed tool functions.                                                                                    |
| [`compile-worker.ts`](src/compiler/compile-worker.ts), [`worker-bundle.ts`](src/compiler/worker-bundle.ts), [`compiler-service-client.ts`](src/compiler/compiler-service-client.ts), [`compiler-service-protocol.ts`](src/compiler/compiler-service-protocol.ts) | Compiler/bundle contracts and the private compiler service boundary. The production compiler itself lives in `apps/cf-sandbox-bridge/src/compiler/`. |
| [`codemode-values.ts`](src/transport/codemode-values.ts), [`codemode-errors.ts`](src/transport/codemode-errors.ts)                                                                                                                                               | Wire values and error classification, including workflow failure classes.                                                                            |
| [`codemode-limits.ts`](src/codemode-limits.ts)                                                                                                                                                                                                                   | Canonical resource budgets and deadlines.                                                                                                            |

Application-specific decisions deliberately live elsewhere:

- [Backoffice remote host](../../apps/backoffice/app/fragno/codemode/remote-execution-host.ts):
  provider dispatch, active transaction/scope checks, event consumption, and delegation to the
  existing workflow and agent hosts.
- [Backoffice workflow execution](../../apps/backoffice/app/fragno/codemode/workflow-execute.ts):
  selection of the local or remote path and integration with the workflow runner.
- [Bridge entrypoint](../../apps/cf-sandbox-bridge/src/index.ts): routes codemode **before** the
  Sandbox SDK router, which otherwise claims all `/v1/*` paths.

Package exports mirror these directories, for example
`@fragno-dev/codemode/transport/codemode-node-client` and
`@fragno-dev/codemode/worker/codemode-worker-session`. Each export maps directly to its defining
module; there are no barrels or compatibility aliases for the former flat paths.

## Protocol and host contract

Protocol v1 has five message kinds:

| Message    | Direction     | Meaning                                                              |
| ---------- | ------------- | -------------------------------------------------------------------- |
| `start`    | Node → bridge | Version, execution ID, and activation. Exactly one per connection.   |
| `call`     | Either way    | An explicit host operation or guest callback, with a correlation ID. |
| `return`   | Either way    | The matching call's value, error, or host-issued suspension.         |
| `complete` | Bridge → Node | Final completed, failed, or suspended outcome, with bounded logs.    |
| `cancel`   | Node → bridge | End the activation; not a rollback.                                  |

The host passed to `CodemodeRemoteExecutor` implements:

- `handle(call, guest)`: perform an authorized host operation; use `guest(...)` when it requires a
  callback in the sandbox.
- `close()`: revoke capabilities and stop outstanding work where supported. Cleanup is idempotent.
- `settle()`: wait for outstanding host operations and report any authoritative workflow suspension.
  This matters when losing the socket causes an active step to schedule a retry.

Suspension is a workflow control outcome, not just an error string. Node rejects a guest-reported
suspension without a corresponding host decision. A known host retry/suspension takes precedence
over an incidental socket error.

The frame codec preserves `undefined`, `Date`, bigint, special numbers, and supported binary values
without confusing user objects with codec tags. Cycles and unsupported values are rejected. Provider
calls retain their existing JSON/binary argument encoding inside this outer transport.

## Failure, isolation, and limits

- No reconnect, transparent retry, retained terminal result, or continuation recovery. Execution IDs
  correlate activity; they are not effect-idempotency keys.
- A disconnect can happen **after a tool changed application state** but before its result or
  checkpoint arrived. Cancellation does not undo that change. Workflow retries follow the host's
  existing policy and can repeat uncheckpointed effects.
- An interruption outside an active step does not acquire a new infrastructure retry policy; the
  existing workflow runner decides how to fail it.
- Remote guests use `globalOutbound: null`. They receive RPC capabilities, not bridge credentials or
  Backoffice bindings. Callers cannot supply a custom remote egress binding.
- Frames, values, source/bundles, calls, handles, logs, and activation concurrency are bounded.
  Compilation and execution have deadlines; dynamic Workers also receive CPU/subrequest limits. See
  `CODEMODE_LIMITS` rather than duplicating its values in callers.
- WebSocket compilation, private compiler RPC calls, and authenticated HTTP compiler calls share a
  bounded admission count per bridge Worker isolate through
  `compiler/codemode-compiler-admission.ts`. A timed-out or disconnected caller retains its slot
  until compilation settles; replacement calls fail with `CODEMODE_COMPILATION_LIMIT_EXCEEDED` when
  all slots are occupied. Every entrypoint registers settlement with `ctx.waitUntil` so
  post-disconnect cleanup can release its slot. This is an isolate-local bound, not a distributed
  quota. Compilation runs inside the bridge, so synchronous compiler work shares its CPU and cannot
  be interrupted by a JavaScript timer.
- A caller's wait for host cleanup is bounded, but an unabortable host operation keeps its Node
  admission slot until it really settles. A disconnect must not free unlimited capacity for detached
  work.
- Compiler warnings and guest logs share the completion's count and UTF-8 byte budgets. Overflow
  keeps a bounded prefix followed by `[codemode] Logs truncated.` without changing the execution
  outcome. Guest log floods still fail at the guest's own logging limit.
- Guest logs are returned with completion, not streamed live, and interruptions can lose them. Both
  peers emit `codemode.activation` summaries with IDs, duration, outcome, and transport counters,
  without source or tool payloads.

## Configuration and development

The bridge endpoint is `GET /v1/codemode/execute` with a WebSocket upgrade and
`Authorization: Bearer <SANDBOX_API_KEY>`. Codemode refuses unauthenticated access even in
development.

Node Backoffice reads `CLOUDFLARE_BRIDGE_URL` and `CLOUDFLARE_BRIDGE_API_KEY`; the latter must match
the bridge's `SANDBOX_API_KEY`. The URL must use `https://`, except for local loopback `http://`.
The executor derives the WebSocket scheme, while `createCodemodeCompilerHttpClient` uses the same
URL and token for compilation or TypeScript checking over HTTP. The bridge needs `LOADER` and
includes its compiler directly. Cloudflare Backoffice binds `CODEMODE_COMPILER` to the bridge's
private `CodemodeCompiler` entrypoint, while retaining its own Worker Loader. See the
[bridge setup notes](../../apps/cf-sandbox-bridge/README.md#node-backoffice-codemode) and
[Backoffice README](../../apps/backoffice/README.md) for application setup.

From the repository root:

```sh
pnpm exec turbo build types:check test --filter=@fragno-dev/codemode --filter=@fragno-apps/cf-sandbox-bridge --output-logs=errors-only
```

The package tests cover the codec, peer behavior, compiler contracts, and real WebSocket/dynamic
Worker conversations. [`createCodemodeTestServer`](src/testing/codemode-test-server.ts), exported
through `@fragno-dev/codemode/testing/codemode-test-server`, starts local Miniflare/workerd with a
compiler service boundary. Its test compiler uses esbuild and does **not** install npm dependencies.
The bridge's own tests exercise its Wrangler-built entrypoint, real compiler/Wasm, private RPC,
authenticated HTTP, routing, and shared compiler admission. Backoffice's Cloudflare scenarios call
the real compiler functions directly instead of starting an additional bridge Worker.

[Backoffice scenarios](../../apps/backoffice/app/fragno/codemode/workflow-execute.node.scenario.test.ts)
exercise the same remote path with the real workflow runner and SQLite-backed state. Local tests do
not establish deployed CPU enforcement or deployment-time disconnect behavior; those still require
VPS-to-deployed-bridge probes.
