# cloudflare-sandbox-bridge

Cloudflare Worker that exposes the Sandbox HTTP API, codemode execution, and authenticated compiler
APIs. Creates and manages sandboxed execution environments backed by
[Cloudflare Containers](https://developers.cloudflare.com/containers/).

This is Fragno's workspace-integrated bridge, including the Node Backoffice codemode WebSocket
executor. Deploy it from this repository; the upstream Sandbox deploy template does not include this
implementation or its embedded compiler.

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

### Development tools

When running locally, a few routes make it easy to explore the API:

- **`GET /v1/openapi.html`** — self-contained browser UI rendered from the OpenAPI spec. Open this
  in your browser to explore every endpoint interactively. Auth is skipped when `SANDBOX_API_KEY` is
  not set in `.dev.vars`.
- **`GET /v1/openapi.json`** — machine-readable OpenAPI 3.1 schema. Requires
  `Authorization: Bearer <token>` when the token is set.
- **`GET /health`** — unauthenticated liveness probe; returns `{"ok": true}`.

## Deployment

Deploy this workspace from the repository root. Deploy it before Backoffice versions that bind to
its `CodemodeCompiler` entrypoint. Review the container sizing below before deploying.

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

### Container instance type

`wrangler.jsonc` defaults to **`instance_type: "standard-1"` with `max_instances: 3`**. This is a
production-sized container configuration, not the smaller `"lite"` development configuration. Review
both settings before deploying; change the instance type to `"lite"` and/or reduce the instance
ceiling if that better fits your workload and budget. The warm-pool target defaults to `0`, but
containers can still start on demand.

## Updating

The bridge worker depends on two versioned artifacts that should be kept in sync:

1. **`@cloudflare/sandbox`** — the SDK package in `package.json`, pinned to `0.12.4`.
2. **`cloudflare/sandbox` Docker image** — `FROM docker.io/cloudflare/sandbox:0.12.4` in
   `Dockerfile`.

Update both to the same exact version together, then regenerate the repository's PNPM lockfile. Do
not use a wildcard or version range for the SDK: it could resolve to a different version than the
image. Run these commands from the repository root after editing both pins:

```sh
pnpm install
pnpm exec turbo run build types:check test --filter=@fragno-apps/cf-sandbox-bridge --output-logs=errors-only
pnpm --dir apps/cf-sandbox-bridge run dev     # verify locally; stop before deploying
pnpm --dir apps/cf-sandbox-bridge run deploy
```

## Control flow and code ownership

```text
src/
├── index.ts                            # Cloudflare entrypoints and HTTP router composition
├── http/
│   ├── codemode-execution-http-route.ts # authenticate → WebSocket upgrade → bridge session
│   ├── codemode-compiler-http-routes.ts # authenticate → compile/type-check operation
│   └── sandbox-lifecycle-http-routes.ts
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

WebSocket activations call the compiler directly. Cloudflare Backoffice uses a service binding and
then executes the returned bundle with its own Worker Loader:

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

RPC, HTTP compilation, type-checking, and WebSocket compilation share the isolate-local admission
limit. Slots remain occupied until operations settle, including after disconnects; `ctx.waitUntil`
keeps settlement cleanup alive within the platform's lifecycle allowance. This is not a distributed
quota. Compiler work shares the bridge's runtime resources; JavaScript deadlines cannot interrupt
synchronous compiler CPU work. Validate startup, memory, CPU, and disconnect behavior after
deployment.

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

## Node Backoffice

`GET /v2/codemode/execute` accepts one authenticated Cap'n Web session per activation. It runs in an
ordinary Worker and adds no Durable Object or migration. The embedded compiler builds the guest and
`LOADER` runs it in a sealed dynamic Worker. Cap'n Web proxies Node's narrow tool and workflow
capabilities through native Workers RPC; the bridge has no callback or transaction handle tables.
Keep the existing Sandbox and WarmPool bindings even when only exercising codemode.

Set Node Backoffice's `CLOUDFLARE_BRIDGE_URL` to this bridge's `https://` origin and
`CLOUDFLARE_BRIDGE_API_KEY` to its `SANDBOX_API_KEY`. Node uses the HTTP sandbox routes for sandbox
lifecycle and commands, and derives the corresponding WebSocket URL for codemode execution. The
bridge adds `PUT /v1/sandbox/:id/configuration` so Node can apply `keepAlive` and `sleepAfter` to
the WarmPool-assigned Sandbox Durable Object before startup. Local loopback `http://` is supported.
Unlike the Sandbox SDK development routes, codemode always fails closed without a configured API
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

## Authentication

All `/v1/sandbox/*` and `/v1/openapi.*` routes require:

```
Authorization: Bearer <SANDBOX_API_KEY>
```

If `SANDBOX_API_KEY` is not configured on the worker, auth is skipped — convenient for local dev
without a `.dev.vars` file. Set the secret before deploying:

```sh
# From the repository root:
pnpm --dir apps/cf-sandbox-bridge exec wrangler secret put SANDBOX_API_KEY
```

## Sandbox Interface

This worker is an HTTP bridge for the `BaseSandboxSession` abstract interface. Each abstract method
maps to exactly one route:

| `BaseSandboxSession` method | Route                                 | Description                                      |
| --------------------------- | ------------------------------------- | ------------------------------------------------ |
| _(create session)_          | `POST /v1/sandbox`                    | Generate a new sandbox ID                        |
| `_exec_internal()`          | `POST /v1/sandbox/:id/exec`           | Run a command; returns stdout/stderr/exit_code   |
| `read()`                    | `GET /v1/sandbox/:id/file/*`          | Read a file from the workspace                   |
| `write()`                   | `PUT /v1/sandbox/:id/file/*`          | Write a file into the workspace                  |
| `running()`                 | `GET /v1/sandbox/:id/running`         | Check sandbox liveness                           |
| `resolve_exposed_port()`    | `POST /v1/sandbox/:id/tunnel/:port`   | Create or reuse a tunnel for a port              |
| _(delete tunnel)_           | `DELETE /v1/sandbox/:id/tunnel/:port` | Delete the tunnel for a port                     |
| `persist_workspace()`       | `POST /v1/sandbox/:id/persist`        | Serialize workspace to a tar archive             |
| `hydrate_workspace()`       | `POST /v1/sandbox/:id/hydrate`        | Populate workspace from a tar archive            |
| `shutdown()`                | `DELETE /v1/sandbox/:id`              | Destroy sandbox via `destroy()` (returns 204)    |
| _(terminal)_                | `GET /v1/sandbox/:id/pty`             | WebSocket PTY proxy (bidirectional terminal I/O) |
| `mountBucket()`             | `POST /v1/sandbox/:id/mount`          | Mount an S3-compatible bucket                    |
| `unmountBucket()`           | `POST /v1/sandbox/:id/unmount`        | Unmount a mounted bucket                         |
| _(create session)_          | `POST /v1/sandbox/:id/session`        | Create an execution session                      |
| _(delete session)_          | `DELETE /v1/sandbox/:id/session/:sid` | Delete an execution session                      |

## API Reference

All examples assume `SANDBOX_API_KEY=your-secret` and the worker running at `http://localhost:8787`.

#### `GET /health`

Unauthenticated liveness probe.

```sh
curl http://localhost:8787/health
```

#### `POST /v1/sandbox`

Create a new sandbox session. Returns a unique sandbox ID.

```sh
curl -X POST http://localhost:8787/v1/sandbox \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{ "id": "mfrggzdfmy2tqnrzgezdgnbv" }
```

---

---

#### `POST /v1/sandbox/:id/exec`

Run a shell command inside the sandbox. Returns base64-encoded stdout/stderr and an exit code.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/exec \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv": ["sh", "-lc", "echo hello"], "timeout_ms": 10000, "cwd": "/workspace"}'
```

---

#### `GET /v1/sandbox/:id/file/:path`

Read a file from the sandbox filesystem. The file path is given in the URL after `/file/` as an
absolute path without the leading slash (e.g. `workspace/main.py` for `/workspace/main.py`). Must
resolve within `/workspace`. Returns raw bytes (`application/octet-stream`).

```sh
curl -X GET http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/file/workspace/main.py \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `PUT /v1/sandbox/:id/file/:path`

Write a file into the sandbox filesystem. The file path is given in the URL after `/file/`, and the
file contents are sent as the raw request body.

```sh
curl -X PUT http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/file/workspace/main.py \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @main.py
```

---

#### `GET /v1/sandbox/:id/running`

Check whether the sandbox container is alive.

```sh
curl http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/running \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `POST /v1/sandbox/:id/tunnel/:port`

Create or reuse a tunnel for a service that is already running inside the sandbox. This may
provision tunnel infrastructure, but it does not start the application listening on the port. Send
no body for an ephemeral `*.trycloudflare.com` tunnel, or pass `name` to choose the subdomain prefix
for a named tunnel, such as `"app"`. Do not pass a full hostname.

Ephemeral tunnel:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Named tunnel:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "app"}'
```

Response:

```json
{
  "id": "11111111-2222-3333-4444-555555555555",
  "port": 8080,
  "url": "https://app.example.com",
  "hostname": "app.example.com",
  "name": "app",
  "createdAt": "2026-05-29T00:00:00.000Z"
}
```

Named tunnels require `CLOUDFLARE_API_TOKEN`. If the account or zone cannot be inferred from the
token, set `CLOUDFLARE_TUNNEL_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`, and/or set
`CLOUDFLARE_ZONE_ID`.

---

#### `DELETE /v1/sandbox/:id/tunnel/:port`

Delete the tunnel for a sandbox port. This stops the tunnel process and removes any named-tunnel
Cloudflare resources tracked by the sandbox.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Returns `204 No Content` when the tunnel was deleted or already absent.

---

#### `POST /v1/sandbox/:id/persist`

Serialize the sandbox workspace to a tar archive. Returns raw tar bytes.

```sh
curl -X POST "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/persist?excludes=.venv,__pycache__" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -o workspace.tar
```

---

#### `POST /v1/sandbox/:id/hydrate`

Populate the sandbox workspace from a tar archive.

```sh
curl -X POST "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/hydrate" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @workspace.tar
```

---

#### `GET /v1/sandbox/:id/pty`

Open a WebSocket PTY session to the sandbox. The connection is a bidirectional proxy to the
container's terminal via `sandbox.terminal()`.

**Query parameters:**

| Param     | Type   | Default | Description                           |
| --------- | ------ | ------- | ------------------------------------- |
| `cols`    | number | 80      | Terminal width in columns             |
| `rows`    | number | 24      | Terminal height in rows               |
| `shell`   | string | —       | Shell binary (e.g. `/bin/bash`)       |
| `session` | string | —       | SDK session ID for session-scoped PTY |

**WebSocket frame protocol:**

| Direction       | Frame type  | Content                                                               |
| --------------- | ----------- | --------------------------------------------------------------------- |
| Client → Server | Binary      | UTF-8 encoded keystrokes / input                                      |
| Server → Client | Binary      | Terminal output (including ANSI escape sequences)                     |
| Client → Server | Text (JSON) | Control messages (e.g. `{"type": "resize", "cols": 120, "rows": 30}`) |
| Server → Client | Text (JSON) | Status messages (`ready`, `exit`, `error`)                            |

The request must include the `Upgrade: websocket` header; plain HTTP requests return `400`.

```sh
# Example using websocat
websocat "ws://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/pty?cols=120&rows=30" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `DELETE /v1/sandbox/:id`

Destroy the sandbox via `sandbox.destroy()`. Returns 204 No Content on success.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/my-sandbox \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `POST /v1/sandbox/:id/mount`

Mount an S3-compatible bucket (R2, S3, GCS, etc.) as a local directory inside the container.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/mount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bucket": "my-bucket", "mountPath": "/mnt/data", "options": {"endpoint": "https://ACCT.r2.cloudflarestorage.com"}}'
```

To mount a Worker R2 binding without credentials, provide the top-level `binding` field and omit
`options.endpoint`:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/mount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"binding": "MY_BUCKET", "mountPath": "/mnt/data", "options": {"prefix": "/uploads/"}}'
```

**Request body:**

| Field                                 | Type    | Required | Description                                                                     |
| ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `bucket`                              | string  | no       | Remote bucket name for endpoint-based S3-compatible mounts                      |
| `binding`                             | string  | no       | Worker R2 binding name for credential-less R2 binding mounts                    |
| `mountPath`                           | string  | yes      | Absolute path in the container to mount at                                      |
| `options.endpoint`                    | string  | no       | S3-compatible endpoint URL for remote mounts; mutually exclusive with `binding` |
| `options.readOnly`                    | boolean | no       | Mount as read-only (default: false)                                             |
| `options.prefix`                      | string  | no       | Subdirectory prefix within the bucket                                           |
| `options.credentials.accessKeyId`     | string  | no       | Explicit access key (auto-detected if omitted)                                  |
| `options.credentials.secretAccessKey` | string  | no       | Explicit secret key (auto-detected if omitted)                                  |
| `options.credentialProxy`             | boolean | no       | Keep credentials in the Durable Object and sign intercepted s3fs requests       |

Credentials are optional — the SDK auto-detects from Worker secrets
(`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).

---

#### `POST /v1/sandbox/:id/unmount`

Unmount a previously mounted bucket.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/unmount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mountPath": "/mnt/data"}'
```

---

#### `POST /v1/sandbox/:id/session`

Create an execution session. Sessions provide separate working directories, environment variables,
and command execution state within one sandbox. Use separate sandbox IDs for separate users or
account workspaces.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/session \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{ "id": "sess_abc123" }
```

Pass the returned session ID via the `Session-Id` header on subsequent `/exec`, `/pty`, and file
operations to scope them to the session.

---

#### `DELETE /v1/sandbox/:id/session/:sid`

Delete an execution session.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/session/sess_abc123 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Returns 204 No Content on success.

---

## Session Support

The bridge supports the Sandbox SDK session mechanism through the `Session-Id` request header.
Sessions separate command execution contexts, such as working directory and environment variables,
within one sandbox. For user-facing applications, use one sandbox ID per user or account workspace.

- **Create a session**: `POST /v1/sandbox/:id/session` — returns a session ID.
- **Use a session**: Pass `Session-Id: <session-id>` on `/exec`, `/pty`, and file operation
  requests.
- **Delete a session**: `DELETE /v1/sandbox/:id/session/:sid` — tears down the session.
- **Headerless requests are stateless**: When no `Session-Id` header is provided, command and file
  requests do not reuse the SDK's default shell session. Use an explicit session when you need `cd`,
  exported environment variables, or other shell state to persist across calls.

### Session limitations

- **Custom sessions don't survive container sleep.** Custom sessions are ephemeral — if the
  container sleeps and restarts, custom sessions are lost. Create a new session after restart before
  sending session-scoped requests.
- **`destroy()` kills in-flight operations immediately.** Deleting a sandbox via
  `DELETE /v1/sandbox/:id` calls `sandbox.destroy()`, which terminates all running commands and
  sessions without waiting for completion.
- **Deleted sandbox IDs can be reused.** After destroying a sandbox, the same ID can be used again —
  it gets a fresh container.

---

See `/v1/openapi.html` in local dev for full request/response schemas.

## Container Warm Pool

The worker includes an optional **warm pool** that pre-starts sandbox containers so new sessions
boot instantly. The implementation is adapted from
[cf-container-warm-pool](https://github.com/mikenomitch/cf-container-warm-pool).

### How it works

A singleton `WarmPool` Durable Object maintains a set of pre-started containers. When a new sandbox
session arrives, it is assigned a container from the pool instead of cold-starting one. Once
assigned, a container is consumed and never returned to the pool. An alarm-driven loop continuously
health-checks containers and replenishes the pool to the configured target.

The pool is primed (its alarm loop started) in two ways:

1. **Cron trigger** — a `* * * * *` (every-minute) cron is configured in `wrangler.jsonc`. On each
   tick the `scheduled()` handler calls `configure()` on the `WarmPool` DO, which starts the alarm
   loop. This ensures the pool is active immediately after deploy, even with no HTTP traffic.
2. **`POST /v1/pool/prime`** — an explicit HTTP route that does the same thing. Useful for manual
   priming or CI/CD scripts.

### Configuration

Set these variables in `wrangler.jsonc` (under `vars`) or via `wrangler secret put`:

| Variable                     | Default   | Description                                                                                                                                         |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WARM_POOL_TARGET`           | `"0"`     | Number of idle containers to keep warm. **0 disables the pool** (no surprise bills).                                                                |
| `WARM_POOL_REFRESH_INTERVAL` | `"10000"` | Milliseconds between pool health-check / replenishment cycles.                                                                                      |
| `WARM_POOL_MAX_INSTANCES`    | `"0"`     | Capacity ceiling the pool plans against. Set it to match `containers[].max_instances`. **0 leaves the ceiling to be learned from capacity errors.** |
| `WARM_POOL_SCALE_BATCH_SIZE` | `"5"`     | Number of containers started in parallel per scale-up batch. Clamped to `[1, 20]`.                                                                  |

The cron trigger frequency can be adjusted in `wrangler.jsonc` under `triggers.crons`. Remove the
cron entirely if you only want manual priming via `POST /v1/pool/prime`.

### Pool management routes

These routes require the same `Authorization: Bearer <SANDBOX_API_KEY>` as sandbox routes.

#### `GET /v1/pool/stats`

Returns current pool statistics.

```sh
curl http://localhost:8787/v1/pool/stats \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{
  "warm": 3,
  "assigned": 2,
  "total": 5,
  "config": { "warmTarget": 3, "refreshInterval": 10000 },
  "maxInstances": 10
}
```

#### `POST /v1/pool/shutdown-prewarmed`

Stops all idle (unassigned) warm containers. Does not affect containers currently assigned to
sandbox sessions.

```sh
curl -X POST http://localhost:8787/v1/pool/shutdown-prewarmed \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

#### `POST /v1/pool/prime`

Primes the warm pool by pushing the current configuration and starting the alarm loop. Called
automatically by the cron trigger; can also be called manually.

```sh
curl -X POST http://localhost:8787/v1/pool/prime \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

## Container Image

`./Dockerfile` extends `docker.io/cloudflare/sandbox` and pre-installs the tools agents commonly
use:

- `git` — version control
- `ripgrep` (`rg`) — fast text and file search
- `curl`, `wget` — HTTP fetching
- `jq` — JSON processing
- `procps` — process management (`ps`, `pkill`)
- `sed`, `gawk` — text processing

Extend the `Dockerfile` to add languages or tools needed for your workloads (e.g. `python3`,
`nodejs`, `npm`).

## Security

The worker applies multiple layers of security to constrain operations within the sandbox:

### Authentication

All `/v1/sandbox/*` and `/v1/openapi.*` routes require a Bearer token (`SANDBOX_API_KEY`). When the
token is not configured, auth is skipped for local development convenience but a warning is logged.
Always set the token before deploying:

```sh
# From the repository root:
pnpm --dir apps/cf-sandbox-bridge exec wrangler secret put SANDBOX_API_KEY
```

### Workspace containment

All file operations (`/file/*`) and the `cwd` parameter on `/exec` are validated to resolve within
`/workspace`. Paths are POSIX-normalised (`.` and `..` segments resolved) before the prefix check,
preventing traversal attacks such as `/workspace/../../etc/passwd`.

The `/persist` and `/hydrate` endpoints always operate on `/workspace` — there is no configurable
root parameter. Exclude entries on `/persist` are validated against path traversal and shell-quoted
before interpolation into commands.

### Non-root container user

The container image creates a dedicated `sandbox` user. `/workspace` is owned by this user;
sensitive directories like `/root` are locked down. This limits what commands executed via `/exec`
can access — system files such as `/etc/shadow` are not readable.

### Input validation

- **Sandbox IDs** must match `[a-z2-7]{1,128}` (base32 lowercase).
- **Shell arguments** in `/exec` are single-quote-escaped via `shellQuote()` before being passed to
  the container shell.
- **Tar payloads** on `/hydrate` are capped at 32 MiB.

### Known limitations

- **Exec runs arbitrary commands.** The `/exec` endpoint does not restrict which programs can be
  run. The non-root user and filesystem permissions are the primary constraints. Tools like `curl`
  remain available and could be used to exfiltrate data from the workspace or probe the network.
- **Symlink escape.** Path validation happens at the HTTP layer by normalising path strings. It
  cannot resolve symlinks, which exist only inside the container. A caller could use `/exec` to
  create a symlink from `/workspace/link` to a file outside the workspace, then read that symlink
  via `/file/*`. The non-root user mitigates the impact (sensitive root-owned files are
  inaccessible), but world-readable files like `/etc/passwd` could still be read this way.
- **`USER` directive scope.** The `USER sandbox` directive in the Dockerfile sets the default user
  for the container entrypoint. Whether `sandbox.exec()` inherits this user depends on the
  Cloudflare Sandbox runtime behaviour. Verify after deployment that commands run as `sandbox` (e.g.
  `exec ["whoami"]`).
- **No network restrictions.** There are no egress network controls within the container. If your
  threat model requires it, consider restricting outbound access at the container or platform level.
