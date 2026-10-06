# @fragno-dev/codemode

Private workspace machinery for running JavaScript in Cloudflare while keeping tools, authorization,
database access, workflow checkpoints, and agent sessions on the trusted host. Backoffice and the
Cloudflare Sandbox bridge share this package.

## Architecture

```text
Node Backoffice           cf-sandbox-bridge             Dynamic Worker
(trusted host)            (ordinary Worker)             (untrusted guest)

              Cap'n Web                         native Workers RPC
             over WebSocket                    through Worker Loader
        <-------------------->             <------------------------>
```

The bridge authenticates and builds or loads the guest. Precompiled execution does not use the
compiler. Cap'n Web proxies host capabilities through native Workers RPC; the bridge does not
maintain callback, transaction, subscription, or call-correlation handle tables. It is an ordinary
Worker, not a Durable Object. Sandbox SDK containers and WarmPool are separate infrastructure.

Bridge activation admission is separate from compiler admission and shared across clients in each
Worker isolate. Every activation, including precompiled guests, retains its slot until guest work
and forwarded host operations settle. Closing a socket revokes capabilities; it does not immediately
release an active slot. This is an isolate-level bound, not a globally coordinated replica quota.

Cloudflare Backoffice uses its own Worker Loader and native RPC directly. Both execution paths use
the same revocable capabilities and generated guest API. There is no Node-local fallback.

## Activations and replay

One activation owns a fresh WebSocket and execution ID. Execution starts a fresh dynamic Worker; a
build-only activation returns a reusable bundle without executing guest code:

| Kind            | Behavior                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `immediate`     | Evaluates an expression and invokes it if it is a function. Can return a workflow definition.     |
| `module`        | Imports an ES module, including top-level effects; does not invoke exports.                       |
| `module-invoke` | Loads an ES module, then calls the supplied invocation function with its module namespace.        |
| `module-build`  | Bundles an ES module; returns `{ bundle, warnings }` without executing it or choosing a consumer. |
| `compiled`      | Adds a caller-supplied invocation wrapper to a module bundle, with fresh inputs and capabilities. |
| `workflow`      | Runs one passage of a workflow function with its event and scoped step API.                       |

Module invocation functions receive `(module, input)`. `module-build` takes only source and
dependencies: no invocation, provider names, or consumer metadata is baked into the bundle.
`compiled` supplies the invocation source, input, and provider definitions at execution. A null
invocation imports the module for top-level effects only and ignores all exports; a string
invocation receives its module namespace. The host generates a lightweight Worker entrypoint
importing the bundled module, without a compiler or eval. Native module-global initialization
restrictions remain in force; startup errors are execution failures, never a reason to recompile or
rewrite user code. Different consumers can reuse the same artifact. Every execution supplies and
revokes its own capabilities. Precompiled bundle validation accepts only the host's fixed
compatibility date and flags, enforces bundle limits, and requires the entry module to exist.
Compilation services may be `null` when only precompiled execution is required.

Native Worker bundles can contain up to 32 MiB of source. Node execution also has an 8 MiB RPC frame
limit: compiled requests and module-build responses are measured with Cap'n Web serialization,
including escaped source and metadata, with 64 KiB reserved for the RPC envelope and capabilities.
Oversized requests fail before opening a connection; oversized build results return a normal failed
completion with `CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED`, preserving any previous saved artifact.
Reduce the module or use a native Worker Loader for bundles that exceed the remote payload budget.

A workflow step is not a separate sandbox. One activation may execute several nested steps. When the
host suspends for a checkpoint, sleep, event, or retry, a later runner tick starts a fresh
activation. Completed steps return persisted results without invoking their callbacks. JavaScript
continuations and capabilities are never persisted.

Calls are bidirectional and reentrant: a host awaiting a guest step callback can service a tool call
from that callback. Cap'n Web owns reference passing and promise correlation.

## Capabilities and outcomes

The execution API is `GET /v2/codemode/execute`, authenticated with
`Authorization: Bearer <SANDBOX_API_KEY>`, followed by a WebSocket upgrade. The first RPC is
`execute({ protocolVersion: 2, executionId, activation }, capabilities)`. Exactly one execution is
accepted per connection. The API is a breaking replacement of the former custom v1 execution
protocol; there is no compatibility fallback. Deploy the bridge before updating Node callers.

Compiler RPC and HTTP archive formats are independent and remain v1:
`POST /v1/codemode/compile-worker` and `POST /v1/codemode/type-check-files`.

`createCodemodeHost(providers, workflow)` returns:

- `capabilities`: registered provider targets and a workflow step target, or `null` if unavailable.
  The bridge wraps each provider with the activation's exact advertised tool allowlist before
  forwarding it to the guest. Usable tools are the intersection of advertised and host-registered
  tools; an empty allowlist grants no tool authority. Original dispatchers, host lifecycle methods,
  and application bindings never reach the guest.
- `close()`: idempotently revokes authority, including retained transactions, nested step scopes,
  and event subscriptions.
- `settle()`: drains outstanding host work and reports authoritative workflow suspension.

A step callback receives a transaction capability and a scoped step capability. The generated
runtime tracks that scoped step with AsyncLocalStorage. Guests cannot supply or forge parent step
identities. Both capabilities lose authority when the callback finishes, regardless of retained or
duplicated RPC references.

Event subscriptions duplicate their callback reference before the registration RPC returns, and
release it on unsubscribe, step completion, or activation close. Event consumption is an explicit
boolean acknowledgement; late deliveries cannot consume events after revocation.

Cap'n Web and native RPC own value serialization. Tool arguments and results are actual values, not
JSON strings inside another RPC message. Dates, bigint, undefined, special numbers, buffers, and
typed arrays can cross both boundaries without an application binary codec. Cap'n Web does not
support cyclic data or arbitrary application class instances.

Small domain result envelopes remain intentional. Native Workers RPC does not preserve the custom
Error properties needed for workflow classification. Tool and callback outcomes carry safe error
details; step outcomes additionally distinguish suspension. The host restores runner failure classes
at the callback boundary. Guest-reported suspension is rejected unless the host issued it; a host
retry/suspension takes precedence over an incidental socket error.

## Isolation, limits, and disconnects

- No transparent retry, reconnect, retained terminal result, or continuation recovery. Execution IDs
  correlate activity; they are not idempotency keys.
- Disconnecting does not roll back tool mutations. A workflow retry may repeat uncheckpointed
  effects. The existing host runner alone decides whether and how to retry.
- Remote guests are sealed with `globalOutbound: null`; they never receive bridge credentials.
- Zod validates activation and operation inputs at the capability boundary. TypeScript types alone
  do not establish trust. Providers dispatch only own, explicitly registered tool names.
- `CodemodeWebSocketTransport` bounds frames, receive queues, outgoing queues, session bytes,
  messages, and Cap'n Web import/export table sizes. Cap'n Web bounds decoding depth and bigint
  digits. Binary data is bounded by frame size, not a separate application binary codec.
- Host calls and live capabilities are admission-limited. Activation, connection, startup, and
  compilation deadlines remain explicit; loaded Workers also receive CPU/subrequest limits. See
  `CODEMODE_LIMITS` for the canonical policy.
- WebSocket compilation, private compiler RPC, and authenticated HTTP compiler calls share
  isolate-local admission. Disconnected or timed-out compilation retains its slot until it settles,
  and `ctx.waitUntil` keeps cleanup alive within platform lifecycle allowances. This is not a
  distributed quota. Synchronous compiler work shares bridge CPU and cannot be interrupted by a
  JavaScript timer.
- Host cleanup waits are bounded, but unabortable work keeps its Node admission slot until actual
  settlement. Disconnects cannot create unlimited detached work.
- Compiler warnings and guest logs share count and UTF-8 byte budgets. Overflow preserves a prefix
  followed by `[codemode] Logs truncated.` without changing the execution outcome. Guest log floods
  still fail at the logging limit. Logs are returned at completion, not streamed, and may be lost on
  interruption.
- Both peers emit `codemode.activation` summaries with identity, duration, outcome, and transport
  counters, excluding source and tool payloads.

## Tests

Ordinary package tests run under Node without starting a workerd bridge:

```sh
pnpm exec turbo run test --filter=@fragno-dev/codemode --output-logs=errors-only
```

Pure helpers, codecs, and transport contracts live beside their implementations. Backoffice's
Cloudflare test pool exercises actual guest execution directly through its local Worker Loader.

Real bridge lifecycle tests are colocated as `*.bridge.test.ts` and run only through the explicit
bridge task:

```sh
pnpm exec turbo run test:bridge --filter=@fragno-dev/codemode --output-logs=errors-only
```

That task starts the local test bridge and preserves coverage for authenticated WebSockets,
bidirectional callbacks, compilation admission, interruption, and cleanup. Ordinary `test` runs do
not collect these files, so their setup cannot start the bridge implicitly.

## Code map

```text
src/
├── execution/
│   ├── codemode-activation-contract.ts   # validated activations, capabilities, and outcomes
│   ├── execute-codemode-activation.ts    # build source or execute a precompiled bundle
│   ├── codemode-worker-bundle.ts         # persisted bundle validation and fixed runtime contract
│   └── codemode-errors.ts                # domain errors and runner failure classification
├── remote/
│   ├── codemode-node-executor.ts         # connect → execute → settle host
│   └── codemode-bridge-session.ts        # one execution RPC, deadlines, and disconnects
├── guest/
│   ├── codemode-function-source.ts       # evaluate(): expression or await fn()
│   ├── codemode-module-source.ts         # import module without invoking exports
│   ├── codemode-module-invocation-source.ts # invoke a function with the imported module namespace
│   ├── codemode-workflow-source.ts       # run(event, step), scoped callbacks, intent flushing
│   ├── codemode-guest-api-source.ts      # shared provider proxies and guest API helpers
│   └── codemode-worker-executor.ts       # Worker Loader invocation and native RPC disposal
├── host/
│   ├── codemode-host-capabilities.ts     # revocable authority and host settlement
│   └── codemode-tool-dispatcher.ts       # registered tool dispatch on Node and Workers
├── transport/
│   ├── codemode-websocket-transport.ts   # bounded framing, not execution semantics
│   ├── codemode-http-authentication.ts
│   └── cloudflare-bridge-url.ts
├── compiler/                            # contracts, bundles, streaming archive clients
└── testing/codemode-test-server.ts       # local workerd session with an esbuild test compiler
```

The bridge app owns HTTP authentication and WebSocket upgrade. The package starts at the accepted
session and keeps connection lifetime separate from activation execution:

```text
bridge HTTP execution route
  acceptCodemodeBridgeSession
    executeCodemodeActivation
      compiled → add invocation entrypoint to supplied module bundle; skip compiler admission
      other kinds → generate source and compile with buildWorkerProject
        module-build → return bundle and warnings; do not load a Worker
      invoke loaded guest
        immediate/module/module-invoke/compiled → evaluate()
        workflow → run(event, step)
```

Workflow callbacks return through `host/codemode-host-capabilities.ts` to the application runner.
That host owns checkpoints, retry decisions, and suspension; the guest source owns the sandbox-side
step API and transaction intent flushing. Tests are colocated with their owning boundaries.

All package exports map directly to defining files. Application-specific authority stays in
Backoffice's `workflow-host.ts` and `remote-execution-host.ts`; the production compiler lives in
`apps/cf-sandbox-bridge/src/compiler/`.

## Configuration and development

Node reads `CLOUDFLARE_BRIDGE_URL` and `CLOUDFLARE_BRIDGE_API_KEY`; the key must match the bridge's
`SANDBOX_API_KEY`. HTTPS is required except for loopback HTTP. The client derives the WebSocket
scheme. Codemode always refuses unauthenticated access, including local development.

The bridge needs `LOADER` and includes its compiler. Cloudflare Backoffice retains its own Worker
Loader and binds `CODEMODE_COMPILER` to the bridge's private `CodemodeCompiler` entrypoint.

```sh
pnpm exec turbo build types:check test --filter=@fragno-dev/codemode --filter=@fragno-apps/cf-sandbox-bridge --output-logs=errors-only
```

Package tests exercise real Node/Cap'n Web/workerd/native-RPC conversations, capability lifetimes,
reentrancy, domain outcomes, binary values, compiler admission, and log budgets. The reusable test
compiler does not install npm dependencies. Tests may supply a dependency resolution directory to
bundle explicitly declared, locally installed packages without network installation. Bridge tests
load the Wrangler-built worker and real compiler/Wasm. Backoffice scenarios exercise checkpoint
replay, events, and interruption through real SQLite-backed state. Deployed CPU enforcement and
deployment-time disconnect behavior still require VPS-to-deployed-bridge probes; local tests do not
establish those guarantees.
