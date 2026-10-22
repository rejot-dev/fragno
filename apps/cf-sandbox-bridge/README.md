# cloudflare-sandbox-bridge

Cloudflare Worker that exposes Fragno's sandbox HTTP API, codemode execution, and authenticated
compiler APIs. Sandboxes are [Cloudflare Containers](https://developers.cloudflare.com/containers/)
controlled by a Durable Object.

This is Fragno's workspace-integrated bridge, including the Node Backoffice codemode WebSocket
executor. Deploy it from this repository; it does not use the Sandbox SDK bridge or its deploy
template.

## Prerequisites

- Node.js matching this app's `package.json` engines and PNPM matching the root `packageManager`
- A checkout of the full Fragno repository (the app depends on `@fragno-dev/codemode` via
  `workspace:*`)
- A Cloudflare account with access to Containers / Sandbox
- Wrangler is installed by PNPM as a workspace dev dependency

## Getting Started

Run from the repository root, not from a standalone copy of this directory:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@fragno-apps/cf-sandbox-bridge --output-logs=errors-only
cp apps/cf-sandbox-bridge/.dev.vars.example apps/cf-sandbox-bridge/.dev.vars
# Edit that .dev.vars and set SANDBOX_API_KEY (generate one with: openssl rand -hex 32)
pnpm --dir apps/cf-sandbox-bridge run dev
```

The compiler runs inside this Worker; no separate compiler process or deployment is needed.

The worker starts at `http://localhost:8787`.

`GET /health` is an unauthenticated liveness probe that returns `{"ok": true}`.

## Deployment

Deploy this workspace from the repository root. Deploy it before Backoffice versions that bind to
its `CodemodeCompiler` entrypoint. Read the scheduling note below before deploying.

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/cf-sandbox-bridge exec wrangler login
pnpm --dir apps/cf-sandbox-bridge exec wrangler secret put SANDBOX_API_KEY
# Paste a token generated with: openssl rand -hex 32
pnpm --dir apps/cf-sandbox-bridge run deploy
```

The `deploy` script builds this app and its workspace dependencies with Turbo before invoking
Wrangler. The build verifies generated TypeScript declarations and uses Wrangler's dry run to bundle
the Worker and esbuild Wasm into `dist/`, without uploading or rolling out containers. Do not use
the upstream deploy button or deploy this directory without its workspace dependencies.

Verify the deployment:

```sh
curl https://<your-worker>.workers.dev/health
```

### One-way move to Durable Object scheduling

The `Sandbox` container uses the `durable_object` scheduling policy. Each Sandbox Durable Object
starts its own container and chooses the image and instance type at start time, so the configuration
has no `instance_type` or `max_instances`. The policy is immutable: once deployed, Sandbox SDK 0.x
code cannot start containers for the class, even after `wrangler rollback`. Rehearse a deploy that
crosses this boundary on a staging Worker first.

## Sandbox containers

`src/sandbox/sandbox.do.ts` is the only sandbox implementation in the repository, and this bridge
hosts its containers for both Backoffice runtimes. Node Backoffice reaches it through the bridge's
HTTP API; Cloudflare Backoffice binds the bridge's `Sandbox` class directly. Deploy the bridge
before a Backoffice release that depends on a changed `Sandbox` interface:

- `start()` boots the `workspace` image, the Cloudflare-managed `cloudflare/debian-trixie` image
  (`debian`), or a saved snapshot, on the requested instance type. It is idempotent, so a manager
  can retry it. It returns the original restoration timestamp when resuming a snapshot, including on
  idempotent retries, so the manager can renew its saved workspace's expiry.
- `exec()` runs a command in `/workspace` under a Node supervisor. Its deadline covers the main
  process and output held open by descendants; timeout and output-limit cleanup stop the command's
  process group. The combined stdout/stderr budget is 4 MiB.
- `snapshot()` saves the container filesystem. Snapshots expire 30 days after creation or their
  latest restoration; Backoffice retains a one-day safety margin.
- `stop()` destroys the container.

Backoffice's sandbox manager decides when each of these happens and records the image, instance
type, and latest snapshot. The Durable Object holds a lease and the current container's restoration
metadata: an alarm keeps the container running until the manager stops it, or until the lease
expires if the manager never does.

### Reaching Backoffice from a sandbox

Every `start()` registers an outbound HTTP intercept for `backoffice.internal`
(`SANDBOX_BACKOFFICE_ORIGIN` in `sandbox-container-contract.ts`). Inside the container that name
resolves, and its requests go to the `SandboxBackofficeEgress` entrypoint instead of the Internet.
The entrypoint forwards `/api/file-links/` paths to the `BACKOFFICE` service binding,
`rejot-backoffice-web`, and answers 404 for every other path. Backoffice file links therefore work
from sandboxes without a public route to Backoffice, and without passing Cloudflare zone
protections.

- Cloudflare Backoffice, deployed or in `pnpm preview:containers`, builds file-link URLs on this
  origin. In preview, the Vite plugin runs the bridge beside the web Worker, so the binding reaches
  the local Backoffice.
- Node Backoffice uses the deployed bridge, whose binding reaches the deployed Backoffice, so it
  builds file-link URLs on `DOCS_PUBLIC_BASE_URL` instead. Its sandboxes reach a local Backoffice
  only through a public tunnel.
- The binding makes the bridge and `rejot-backoffice-web` depend on each other. Both already exist,
  so either deploys first; sandbox file links work once both are deployed.

`./Dockerfile` builds the `workspace` image: Debian Trixie with Node.js 24, Python 3.13, `uv`,
`git`, `ripgrep`, `curl`, `wget`, `jq`, `procps`, and `gawk`. Commands run as `root`. With the
`durable_object` scheduling policy, every container process has root capabilities regardless of its
Linux user, so a non-root user would not restrict commands.

## Control flow and code ownership

```text
src/
├── index.ts                            # Cloudflare entrypoints and HTTP router composition
├── http/
│   ├── codemode-execution-http-route.ts # authenticate → WebSocket upgrade → bridge session
│   ├── codemode-compiler-http-routes.ts # authenticate → compile/type-check operation
│   └── sandbox-http-routes.ts          # authenticate → Sandbox Durable Object RPC
├── sandbox/
│   ├── sandbox.do.ts                   # container lifecycle, commands, and snapshots
│   ├── sandbox-backoffice-egress.ts    # sandbox requests to backoffice.internal → Backoffice
│   ├── sandbox-command-supervisor.ts   # command deadlines, process groups, and output budgets
│   └── sandbox-container-contract.ts   # requests and outcomes shared with Backoffice
└── compiler/
    ├── codemode-compiler-entrypoint.ts  # named service-binding RPC and compiler fetch handler
    ├── codemode-compiler-operations.ts  # streamed requests, admission, and settlement cleanup
    ├── build-worker-project.ts         # dependency installation and bundling
    └── type-check-project.ts
```

After upgrade, `@fragno-dev/codemode/remote/codemode-bridge-session` owns the connection.
`execution/execute-codemode-activation` generates the appropriate guest source, calls this app's
compiler directly, and invokes one loaded Worker. Immediate functions and modules use `evaluate()`;
workflows use `run(event, step)`. Node owns workflow persistence and replay, not this bridge.

## Compiler

The stateless compiler lives in `src/compiler/`:

- `build-worker-project.ts` installs declared dependencies and bundles guest code with esbuild.
- `type-check-project.ts` checks streamed source files with TypeScript.
- `codemode-compiler-entrypoint.ts` exposes the private `CodemodeCompiler` RPC entrypoint.
- `codemode-compiler-operations.ts` owns the streamed compile/type-check operations shared by RPC
  and HTTP. Public authentication and routing live in `src/http/codemode-compiler-http-routes.ts`.

Activations call the compiler directly, whether they arrive over WebSocket or the `CodemodeExecutor`
entrypoint. Cloudflare Backoffice binds the compiler only for type checking:

```json
{ "binding": "CODEMODE_COMPILER", "service": "cf-sandbox-bridge", "entrypoint": "CodemodeCompiler" }
```

Node processes can use the same compiler over authenticated streaming HTTP:

- `POST /v1/codemode/compile-worker`
- `POST /v1/codemode/type-check-files`

Both routes require `Authorization: Bearer <SANDBOX_API_KEY>` and use the compiler service archive
protocol. `createCodemodeCompilerHttpClient` from
`@fragno-dev/codemode/compiler/compiler-service-client` constructs both Node clients from the bridge
URL and API key. The bridge no longer needs a compiler service binding.

RPC, HTTP compilation, type-checking, and activation compilation share one isolate-local admission
limit, because compiling runs in this isolate's memory. Operations beyond it wait in arrival order,
up to a bounded queue; an activation interrupted while waiting leaves the queue without compiling. A
full queue answers an activation as `unavailable`, which its caller treats as interrupted, and
answers a compiler call with HTTP 503. Compiler calls stop waiting when their caller disconnects or
their compile budget ends. Slots remain occupied until operations settle, including after
disconnects; `ctx.waitUntil` keeps settlement cleanup alive within the platform's lifecycle
allowance. This is not a distributed quota. Compiler work shares the bridge's runtime resources;
JavaScript deadlines cannot interrupt synchronous compiler CPU work. Validate startup, memory, CPU,
and disconnect behavior after deployment.

`build` checks `src/compiler/typescript-standard-library.generated.json` against the pinned
`typescript-runtime` version. After changing that version, regenerate the pack from the repository
root:

```sh
pnpm --dir apps/cf-sandbox-bridge run compiler:generate
```

Backoffice's workerd scenarios import the compiler functions directly through this private app's
explicit compiler source exports. They do not start another bridge. The bridge's own tests load the
Wrangler-built Worker and Wasm in Miniflare to cover named RPC, local-loader consumption, WebSocket
execution, authentication, and shared admission.

## Cloudflare Backoffice

The private `CodemodeExecutor` entrypoint (`src/execution/`) runs one activation per service-binding
call. Backoffice's Codemode Durable Object passes its caller's host capabilities as native RPC
stubs; the bridge compiles the guest, loads it through `LOADER`, and forwards the stubs to it. Each
call is its own request with its own I/O context, so a scope's concurrent guests are not capped by
the Durable Object limit on Dynamic Workers. The WebSocket session and this entrypoint share
`runCodemodeBridgeActivation` from `@fragno-dev/codemode`.

```json
{ "binding": "CODEMODE_EXECUTOR", "service": "cf-sandbox-bridge", "entrypoint": "CodemodeExecutor" }
```

## Node Backoffice

`GET /v2/codemode/execute` accepts one authenticated Cap'n Web session per activation. It runs in an
ordinary Worker and adds no Durable Object or migration. The embedded compiler builds the guest and
`LOADER` runs it in a sealed dynamic Worker. Cap'n Web proxies Node's narrow tool and workflow
capabilities through native Workers RPC; the bridge has no callback or transaction handle tables.
Keep the Sandbox binding even when only exercising codemode.

Set Node Backoffice's `CLOUDFLARE_BRIDGE_URL` to this bridge's `https://` origin and
`CLOUDFLARE_BRIDGE_API_KEY` to its `SANDBOX_API_KEY`. Node uses the HTTP sandbox routes for sandbox
lifecycle and commands, and derives the corresponding WebSocket URL for codemode execution. Local
loopback `http://` is supported. Every route except `/health` fails closed without a configured API
key.

The shared `@fragno-dev/codemode` package owns the execution API v2 and guest runtime generation.
The initial `execute` RPC requires `protocolVersion: 2`; compiler archives and HTTP compiler routes
retain their independent v1 format. Deploy this bridge before updating Node callers: execution v1
has been removed, with no compatibility fallback. Node owns all tools, authorization, persistence,
workflow retry decisions, and Pi sessions. A disconnect ends the activation; there is no reconnect,
stored result, or automatic immediate retry. Tool mutations already performed are not rolled back.
Logs are bounded and returned only at completion. Node and the bridge emit `codemode.activation`
summaries with the execution/workflow IDs, duration, terminal outcome, and bounded message/byte/call
counters; summaries exclude source and tool payloads.

Run builds, type checks, and real-workerd tests from the repository root:

```sh
pnpm exec turbo build types:check test --filter=@fragno-apps/cf-sandbox-bridge --filter=@fragno-dev/codemode --output-logs=errors-only
```

Before production rollout, run VPS-to-deployed-bridge probes for CPU-bound guests, deployment-time
disconnects, and recovery through Node's existing workflow management. Local tests do not establish
Cloudflare's deployed CPU enforcement or routing behavior.

## Sandbox API

Every route takes the manager-scoped physical sandbox ID (`[a-z2-7]{1,128}`) and requires
`Authorization: Bearer <SANDBOX_API_KEY>`. Bodies and responses are the types in
`src/sandbox/sandbox-container-contract.ts`.

| Route                           | Body                                       | Response                              |
| ------------------------------- | ------------------------------------------ | ------------------------------------- |
| `POST /v1/sandbox/:id/start`    | `{ source, instanceType, leaseExpiresAt }` | `200` with a `SandboxStartOutcome`    |
| `POST /v1/sandbox/:id/exec`     | `{ argv, timeoutMs }`                      | `200` with a `SandboxExecOutcome`     |
| `POST /v1/sandbox/:id/snapshot` | none                                       | `200` with a `SandboxSnapshotOutcome` |
| `DELETE /v1/sandbox/:id`        | none                                       | `204`                                 |

Invalid requests return `400` and Durable Object failures return `502`, both as
`{ "code": string, "error": string }`. Authentication failures use the codemode authentication
response shape.

```sh
curl -X POST http://localhost:8787/v1/sandbox/abc234/exec \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv": ["sh", "-lc", "git --version"], "timeoutMs": 10000}'
```

Containers have Internet access, and `exec` runs arbitrary commands. The API key is the only
boundary between a caller and the sandboxes.
