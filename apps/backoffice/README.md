# Backoffice

Backoffice deploys as three Cloudflare Workers:

- `rejot-codemode-compiler` owns the stateless TypeScript and esbuild service.
- `rejot-backoffice` owns the Durable Objects and backend bindings.
- `rejot-backoffice-web` is the public React Router Worker.

## Build outputs

`pnpm --dir apps/backoffice build` produces:

```text
dist/rejot_codemode_compiler/wrangler.json # rejot-codemode-compiler
dist/rejot_backoffice/wrangler.json        # rejot-backoffice
build/server/wrangler.json                  # rejot-backoffice-web
```

React Router owns the primary Worker build under `build/server`. Cloudflare's Vite plugin builds the
compiler and object host as independent auxiliary Worker module graphs under `dist`.

Use these generated configs for uploads. They point to compiled bundles where Vite has resolved
virtual modules and raw asset imports. The source configs, `wrangler.compiler.jsonc`,
`wrangler.jsonc`, and `wrangler.web.jsonc`, are sufficient when activating versions because
activation does not rebuild the source.

## Run on Node with file-backed SQLite

For a file-backed Node instance without Cloudflare bindings, create `apps/backoffice/.dev.vars` from
`.dev.vars.example` if you do not already have one. Set `AUTH_ACCESS_TOKEN_SECRET` and
`BACKOFFICE_INTERNAL_REQUEST_SECRET` there; replace the example secrets with strong values and keep
them unchanged across restarts. Install Deno for codemode execution; Node discovers it from `PATH`,
`DENO_INSTALL`, or `~/.deno/bin`, and `DENO_EXECUTABLE` can select another executable. SQLite data
defaults to `.backoffice-node/`; set `BACKOFFICE_SQLITE_DIR` in `.dev.vars` to use another path. The
file and default data directory are ignored by git.

```bash
pnpm --dir apps/backoffice start:node
```

The local `start:node*` commands run with `NODE_ENV=development`. In this mode, the Node server
serves the browser SQLite worker's source maps directly from the installed dependency for DevTools;
they are never copied into build artifacts. Production Node launches use `NODE_ENV=production`, and
neither they nor Cloudflare serve these maps.

### Run the Node version in Docker

Build the production image for local use from the repository root:

```bash
pnpm --dir apps/backoffice docker:build:node
```

The command prunes the workspace on the host before starting Docker, builds for the local machine's
native architecture, and reuses persistent pnpm and Turbo BuildKit caches. The final image contains
only the bundled Node build, its launcher, Deno, and the native SQLite runtime dependency.

Deployment targets use AMD64 and require an explicit immutable image tag:

```bash
BACKOFFICE_IMAGE_TAG="registry.example.com/backoffice:$(git rev-parse HEAD)" \
  pnpm --dir apps/backoffice docker:build:node:deployment
```

The deployment command loads the AMD64 image into the local Docker image store so it can be pushed
with `docker push "$BACKOFFICE_IMAGE_TAG"`.

Create an environment file outside the repository with stable secrets. Keep the same values when
restarting against an existing data volume.

```dotenv
AUTH_ACCESS_TOKEN_SECRET=<strong-random-secret>
BACKOFFICE_INTERNAL_REQUEST_SECRET=<different-strong-random-secret>
DOCS_PUBLIC_BASE_URL=http://backoffice.localhost:5173
```

Run the web server and processor in one container, backed by a named SQLite volume:

```bash
docker run --rm \
  --name fragno-backoffice-node \
  --publish 127.0.0.1:5173:5173 \
  --volume fragno-backoffice-data:/data \
  --env-file /absolute/path/to/backoffice-node.env \
  fragno-backoffice-node
```

The image binds `0.0.0.0:5173` inside the container, persists SQLite under `/data`, runs as the
non-root `node` user, and includes Deno for sandboxed codemode execution. The default public URL is
`http://backoffice.localhost:5173`; the dedicated `.localhost` name lets container traffic pass the
same strict origin checks used outside Docker without treating the Docker bridge as a direct
loopback connection. Set `DOCS_PUBLIC_BASE_URL` to the externally visible HTTPS URL and configure
the trusted proxy settings described below when exposing the container through a reverse proxy. Pass
optional integration credentials as additional environment variables; the image does not contain
`.dev.vars` or other local environment files.

`start:node` builds with Turbo once, then multiplexes the web server and runtime processor as two
separate Node processes. This matches the production process topology while keeping one local
command. Both processes load the **same `.dev.vars`** used for local Cloudflare development, and the
command stops the remaining process if either process exits. Without an explicit `HOST`, the server
claims both `127.0.0.1` and `::1` on `PORT` (default `5173`). Startup fails and releases both
listeners if either loopback address is unavailable, preventing `localhost` and `127.0.0.1` from
silently reaching different applications. Use `http://127.0.0.1:PORT` as the canonical local URL;
`localhost` remains an alias. Set `DOCS_PUBLIC_BASE_URL` to the public URL for Backoffice links and
proxy access, and set `PORT` too if the local port changes. Direct loopback access remains available
only without proxy forwarding headers, including for `/api/auth/*`; it does not change the public
URL used in generated links. Shell environment variables take precedence over the file. The Node
build goes to `build-node/`, separate from the Worker build. Email verification and sign-up
invitation requirements follow their settings in `.dev.vars`.

To run or deploy either process independently, start them in separate terminals:

```bash
pnpm --dir apps/backoffice start:node:processor
pnpm --dir apps/backoffice start:node:server
```

Both commands construct the same file-backed runtime against `BACKOFFICE_SQLITE_DIR`. The web
process only starts Express. The processor starts Fragno durable-hook polling and services
object-owned alarms without opening a public HTTP listener. SQLite remains the authoritative object
store. Ordinary requests and Fragment operations use SQLite transactions and Fragno OCC, without
object-wide execution leases. Renewable claims are limited to `blockConcurrencyWhile` callbacks and
alarm delivery. New events wait for active initialization; cross-process initialization waits have a
30-second timeout. Existing requests are not stopped. Alarm claims prevent overlapping delivery,
expire after a crashed owner, and acknowledge only the successfully handled generation. Claimed
object-storage mutations fence expired owners, but claims cannot cancel JavaScript or external side
effects: handlers must remain idempotent.

Node OpenTelemetry is enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Both child
processes preload the Node SDK before application modules, export OTLP HTTP/protobuf traces, and
identify themselves as `rejot-backoffice-web` and `rejot-backoffice-processor`. The web process also
emits one structured `backoffice.request.completed` log when every HTTP request finishes or aborts,
including its `backoffice.request_id`, outcome, status, duration, and active trace identifiers when
present. The log includes Cloud Logging's native trace and span fields; set `GOOGLE_CLOUD_PROJECT`
to format the trace as its full Google Cloud resource name. Search logs by the request ID first,
then follow `trace_id` when the collector retained that trace. Durable-hook records persist only W3C
`traceparent` and optional `tracestate`, allowing the processor to continue the enqueuing request
trace without persisting baggage. Cloudflare and Node bind their tracing and Fragment-host
operations through runtime-specific object implementations; the reusable `InMemory*` objects contain
no instrumentation selection or Cloudflare fallback logic. Shutdown drains each runtime and then
flushes its telemetry. For local collection, point the common endpoint at an OTLP HTTP receiver, for
example `http://127.0.0.1:4318`; without an endpoint trace instrumentation remains a no-op while
request completion logs continue to be emitted.

Node objects must not treat mutable process-local fields as authoritative shared state.
Config-backed Fragment hosts reload persisted configuration before events and processor discovery,
reusing derived runtimes only while their source configuration is unchanged. Other shared state
belongs in SQLite; read/await/write sequences need OCC, a transaction, or an explicit
`blockConcurrencyWhile` boundary, not an assumed invocation lock. Run one web process and one
processor process in production; `start:node` runs that same topology under one local process
multiplexer.

Codemode executes in a separate Deno process and Web Worker with filesystem, network, environment,
subprocess, system, FFI, and remote-import permissions denied. The Node process communicates with it
over a capability-based stdio RPC bridge and terminates executions after a hard timeout. Node
codemode currently accepts one bundled JavaScript entry point and rejects requested npm
dependencies.

If you access Node Backoffice through an HTTPS reverse proxy, set `DOCS_PUBLIC_BASE_URL` to its
public HTTPS URL. Have the proxy **preserve the public `Host` header** and overwrite
`X-Forwarded-Proto` with `https` and `X-Forwarded-For` with the client IP. The Node server ignores
`X-Forwarded-Host` and rejects other origins (HTTP 421). It trusts `X-Forwarded-Proto` only from
loopback by default; for a proxy on another machine, set `BACKOFFICE_TRUST_PROXY` to its IP address
or CIDR and explicitly set `HOST` to the Node bind address. Set `BACKOFFICE_TRUST_PROXY=false` to
disable proxy trust. Keep the Node port inaccessible to untrusted clients when binding outside
loopback.

This stores auth, object key/value state and alarms, and Fragment databases in SQLite files under
the selected data directory. Fragno's Node hook processor polls durable hooks, while the runtime
processor services the remaining object-owned alarms. Do not run multiple processor replicas against
the same directory. Cloudflare-specific integrations, the Cloudflare Sandbox integration, and
external upload storage are **not** provided by this mode. Deno permissions constrain codemode
capabilities but are not host-level CPU or memory quotas. Do not expose it as a production service
without addressing those capabilities, resource containment, the shared rate-limit bucket when a
client IP cannot be determined, and the operational requirements of backups, TLS and trusted
proxies.

## Release

When a release adds a Durable Object class, an inactive upload cannot provision its namespace.
Bootstrap that release instead:

```bash
pnpm --dir apps/backoffice run deploy:bootstrap
```

Bootstrap builds and **activates** the compiler, object, and web Workers in dependency order so the
object Worker can provision its classes before the web Worker binds to them. It skips container
image rollout (`--containers-rollout=none`); deploy container changes separately if the release
requires them. This is a live release, not an inactive upload.

For releases without new Durable Object classes, upload an inactive version of all Workers with one
shared tag:

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG"
```

Activate the tagged versions in dependency order: compiler, object host, then web Worker:

```bash
pnpm --dir apps/backoffice run deploy -- \
  --version-tag "$VERSION_TAG@100%" \
  --yes
```

The three activations are sequential, so releases must remain compatible during the rollout.
