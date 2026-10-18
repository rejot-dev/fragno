# Backoffice

Backoffice deploys as two Cloudflare Workers:

- `rejot-backoffice` owns the Durable Objects and backend bindings.
- `rejot-backoffice-web` is the public React Router Worker.

Compilation and type-checking live in the separately deployed
[`cf-sandbox-bridge`](../cf-sandbox-bridge/README.md#compiler). Both Backoffice Workers bind
`CODEMODE_COMPILER` to its private `CodemodeCompiler` entrypoint; guest execution still uses
Backoffice's own Worker Loader. There is no standalone compiler Worker. For local Cloudflare
codemode development, start the bridge's `dev` script alongside Backoffice.

## Static agent-context graph

[`content/CONTEXT-GRAPH.md`](../../content/CONTEXT-GRAPH.md) is a generated map of how files in
`apps/backoffice/content/static/` can enter an agent's context. Use it to review the guidance an
agent can discover and spot missing references, cycles, repeated expansions, and unreachable files
when changing system guidance, skills, or codemode declarations.

The graph starts at the automatically injected `SYSTEM.md` and every discoverable `SKILL.md`. Skill
descriptions explain when to load each skill; nested references represent follow-up reads, not files
that are all injected upfront. The scanner recursively follows concrete `/static/...` file
references and relative inline Markdown links, and models `__BACKOFFICE_CODEMODE_DTS__` as an
expansion through `/static/codemode/system.d.ts`. This is a textual map of checked-in static
content, not a trace of actual agent reads or a map of workspace skills and dynamic runtime content.

From the repository root, regenerate and stage the graph after changing its inputs:

```bash
pnpm backoffice:context
git add content/CONTEXT-GRAPH.md
```

[`scripts/generate-backoffice-context-graph.ts`](../../scripts/generate-backoffice-context-graph.ts)
uses the Backoffice context CLI's scanner and formats the result with `.oxfmtrc.json`. Do not edit
the generated graph manually.

Check the working-tree graph without rewriting it:

```bash
pnpm backoffice:context:check
```

Lefthook runs `pnpm backoffice:context:check-staged` after `static:fix` updates generated static
content, including codemode declarations. Both the working-tree and staged graph must match freshly
generated content, so regenerating without staging is not enough. If the check fails, regenerate and
stage the graph again.

See the [Backoffice context CLI README](../backoffice-context-cli/README.md) for parsing rules and
commands to print ad hoc graphs or inspect another static directory.

## Build outputs

`pnpm --dir apps/backoffice build` produces:

```text
dist/rejot_backoffice/wrangler.json        # rejot-backoffice
build/server/wrangler.json                  # rejot-backoffice-web
```

React Router owns the primary Worker build under `build/server`. Cloudflare's Vite plugin builds the
object host as an independent auxiliary Worker module graph under `dist`.

Use these generated configs for uploads. They point to compiled bundles where Vite has resolved
virtual modules and raw asset imports. The source configs, `wrangler.jsonc` and
`wrangler.web.jsonc`, are sufficient when activating versions because activation does not rebuild
the source.

## Node runtimes

Both Node runtimes serve the same React Router application and use the configured Cloudflare bridge
for codemode and sandbox execution. Create `.dev.vars` from `.dev.vars.example` and set stable auth
and internal-request secrets plus the bridge URL and API key.

| Runtime     | Command         | Entrypoints             | Build output         | Storage                                              |
| ----------- | --------------- | ----------------------- | -------------------- | ---------------------------------------------------- |
| SQLite Node | `start:node`    | `scripts/node-server/`  | `build-node/`        | `.backoffice-node/`                                  |
| Graft Node  | `start:graft`   | `scripts/graft-server/` | `build-graft/`       | `.backoffice-graft/` or explicit Graft configuration |
| Cloudflare  | `dev` / `build` | Worker entrypoints      | `build/` and `dist/` | Cloudflare bindings                                  |

Shared process supervision, proxy-origin policy, and request logging live in `scripts/server/`.
Build jobs serialize shared React Router type generation; each runtime retains its own build output.
The two Node servers use port 5173 by default. To run both simultaneously, give them different
`PORT` values and matching public URLs; Graft also needs its private peer listener on a free port.

### Run the SQLite Node server

```bash
pnpm --dir apps/backoffice start:node
# Optional local Cloudflare bridge:
pnpm --dir apps/backoffice start:node -- --local-bridge
```

This restores the Express server and separate durable-hook processor. The supervisor starts and
stops both together. `start:node:server` and `start:node:processor` remain available for independent
launches. SQLite data stays in `.backoffice-node/`, or `BACKOFFICE_SQLITE_DIR` when configured. The
SQLite runtime does not read Graft configuration, load the Graft extension, or require a control log
ID. Existing SQLite data remains usable; neither runtime imports or overwrites the other's store.

For SQLite containers, use `docker:build:node` / `docker:build:node:deployment` and
`Dockerfile.node`. Mount a persistent volume at `/data` (`BACKOFFICE_SQLITE_DIR` in the image) and
supply the same secrets and bridge settings through your environment file. Only the application port
5173 is exposed.

## Run on Node with Graft

Node uses `@fragno-private/backoffice-node-runtime` with the existing `InMemory*Object`
implementations. One entrypoint, `scripts/graft-server/backoffice-node.mts`, serves HTTP and
schedules object alarms. Each object runs in its own worker, constructs its own services and bridge
clients, and stores Fragment SQL, Auth SQL, Pi SQL, KV, and alarms on its Graft-managed object
connection. Durable hooks run through the owning object's alarms; there is no separate
hook-processor process.

Create `apps/backoffice/.dev.vars` from `.dev.vars.example`. Set strong, stable
`AUTH_ACCESS_TOKEN_SECRET` and `BACKOFFICE_INTERNAL_REQUEST_SECRET` values (the latter must contain
at least 32 characters). Configure `CLOUDFLARE_BRIDGE_URL` and `CLOUDFLARE_BRIDGE_API_KEY` for the
`cf-sandbox-bridge` deployment. Codemode derives WSS from the HTTPS origin; local development also
allows `http://127.0.0.1:8787`. Missing bridge configuration fails startup; an unavailable bridge
fails the invocation without a local fallback or automatic replay. Node does not need Deno.

### Default local storage

Leave `GRAFT_CONFIG` and `BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID` empty for `start:graft`.
Development startup creates `.backoffice-graft/graft.toml`, a local cache, and a filesystem remote.
It reserves a control-log ID, atomically persists it to `.backoffice-graft/control-log-id` before
publishing any remote history, and reuses that identity on every restart. Interrupted first-run
publication resumes with the persisted ID. Keep the ID file and remote together; the cache can be
reconstructed. An explicit `BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID` overrides the local ID.

Startup refuses to create a replacement if the local remote has history but its ID file is missing,
or if that file is empty. Restore the original ID rather than deleting the remaining store. The
generated config is owned by this local default; use explicit configuration if you want to edit it.

### Bootstrap production or custom storage once

Production, a nonempty `GRAFT_CONFIG`, or an existing `graft.toml` in the working directory require
an explicitly published control-log ID. They never bootstrap a replacement automatically. If you
copied an older `.dev.vars.example`, clear `GRAFT_CONFIG=./graft.toml` to enable the local default
(provided no working-directory `graft.toml` exists).

For custom storage, set `GRAFT_CONFIG=./graft.toml` and create `apps/backoffice/graft.toml`. For a
filesystem remote, use absolute paths and create both directories before bootstrapping:

```toml
data_dir = "/absolute/path/to/fragno/apps/backoffice/.backoffice-graft/cache"
make_default = false

[remote]
type = "fs"
root = "/absolute/path/to/fragno/apps/backoffice/.backoffice-graft/remote"
```

Build the runtime and reserve the canonical control-log identity from the repository root:

```bash
pnpm exec turbo run build --filter=@fragno-private/backoffice-node-runtime --output-logs=errors-only
pnpm --dir packages-private/backoffice-node-runtime cli bootstrap reserve \
  --graft-config ../../apps/backoffice/graft.toml
```

Copy the reserved ID into `BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID` in `.dev.vars` **before**
publishing it, then publish that exact identity:

```bash
pnpm --dir packages-private/backoffice-node-runtime cli bootstrap publish \
  --graft-config ../../apps/backoffice/graft.toml \
  --control-remote-log-id '<reserved-id>'
```

`publish` can be rerun with the same ID after interruption. Explicitly configured serving startup
requires the config and published ID; it never creates a replacement control log. Set `GRAFT_CONFIG`
to another config path if needed. Keep the remote and control ID across restarts; the local cache
can be reconstructed. The local config and `.backoffice-graft/` directory are git-ignored.

**Graft starts with a separate store.** Existing `.backoffice-node/` databases are not imported, and
`BACKOFFICE_SQLITE_DIR` is not used by Graft. Continue using `start:node` for those databases, or
perform a separate application-data import if you want to move them to Graft.

```bash
pnpm --dir apps/backoffice start:graft
```

To run the local `cf-sandbox-bridge` under the same supervisor, configure its API key and pass
`--local-bridge`:

```bash
cp apps/cf-sandbox-bridge/.dev.vars.example apps/cf-sandbox-bridge/.dev.vars
# Set SANDBOX_API_KEY in apps/cf-sandbox-bridge/.dev.vars.
pnpm --dir apps/backoffice start:graft -- --local-bridge
```

The flag starts the bridge at `http://127.0.0.1:8787`, copies its `SANDBOX_API_KEY` into
Backoffice's `CLOUDFLARE_BRIDGE_API_KEY`, and sets `CLOUDFLARE_BRIDGE_URL` in
`apps/backoffice/.dev.vars`. If Backoffice's file does not exist, it is created from
`.dev.vars.example`. The supervisor stops the bridge and the single Backoffice host together.

The local `start:node*` and `start:graft` commands run with `NODE_ENV=development`. In this mode,
the Node server serves the browser SQLite worker's source maps directly from the installed
dependency for DevTools; they are never copied into build artifacts. Production Node launches use
`NODE_ENV=production`, and neither they nor Cloudflare serve these maps.

### Run the Graft version in Docker

Build the production image for local use from the repository root:

```bash
pnpm --dir apps/backoffice docker:build:graft
```

The command prunes the workspace on the host before starting Docker, builds for the local machine's
native architecture, and reuses persistent pnpm and Turbo BuildKit caches. The final image contains
the bundled Node build, its launcher, runtime worker modules, production dependencies, and the
pinned native Graft extension. A build-time smoke check loads the extension in the final image,
publishes a temporary control database, and verifies it through a fresh clone. Codemode, TypeScript
checking, and sandbox execution use the configured Cloudflare bridge; Deno is not bundled.

Deployment targets use AMD64 and require an explicit immutable image tag:

```bash
BACKOFFICE_IMAGE_TAG="registry.example.com/backoffice:$(git rev-parse HEAD)" \
  pnpm --dir apps/backoffice docker:build:graft:deployment
```

The deployment command loads the AMD64 image into the local Docker image store so it can be pushed
with `docker push "$BACKOFFICE_IMAGE_TAG"`.

Create an environment file outside the repository with stable secrets. Keep the same values when
restarting against an existing data volume.

```dotenv
AUTH_ACCESS_TOKEN_SECRET=<strong-random-secret>
BACKOFFICE_INTERNAL_REQUEST_SECRET=<different-strong-random-secret>
CLOUDFLARE_BRIDGE_URL=https://cf-sandbox-bridge.rejot.workers.dev/
CLOUDFLARE_BRIDGE_API_KEY=<bridge-SANDBOX_API_KEY>
DOCS_PUBLIC_BASE_URL=http://backoffice.localhost:5173
GRAFT_CONFIG=/config/graft.toml
BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID=<published-control-log-id>
BACKOFFICE_NODE_APPLICATION_ORIGIN=http://backoffice.localhost:5173
BACKOFFICE_NODE_INTERNAL_ORIGIN=http://backoffice-node:5174
```

Mount a Graft config whose `data_dir` points under `/data`, and configure a durable remote. For a
single-container local filesystem remote, also put its `root` under `/data` and bootstrap the
control log against that volume before serving:

```bash
docker run --rm \
  --name backoffice-node \
  --publish 127.0.0.1:5173:5173 \
  --volume fragno-backoffice-data:/data \
  --volume /absolute/path/to/graft-config:/config:ro \
  --env-file /absolute/path/to/backoffice-node.env \
  fragno-backoffice-graft
```

The image runs as the non-root `node` user. Its public listener binds `0.0.0.0:5173`, and private
peer ingress binds `0.0.0.0:5174`. **Do not publish the peer port to the public network.** Wildcard
binds require explicit `BACKOFFICE_NODE_APPLICATION_ORIGIN` and `BACKOFFICE_NODE_INTERNAL_ORIGIN`.
These are node addresses used for routing, not substitutes for `DOCS_PUBLIC_BASE_URL`; in a fleet,
set them to addresses reachable by the gateway and peers. The image contains no `.dev.vars` or local
secrets. It does not bundle Deno or run sandbox containers locally.

`start:graft` builds with Turbo and starts one Backoffice process, optionally alongside the local
bridge. The host preloads the Node OpenTelemetry SDK, and object workers inherit that preload. With
no `HOST` override, the application binds `127.0.0.1:5173`; use that explicit address as the
canonical local URL. Private ingress defaults to `127.0.0.1:5174` and can be configured with
`BACKOFFICE_NODE_INTERNAL_HOST` and `BACKOFFICE_NODE_INTERNAL_PORT`. Shell environment variables
take precedence over `.dev.vars`. Build output lives in `build-graft/`, separately from SQLite Node
and Cloudflare builds. Invitation and email-verification requirements follow `.dev.vars`.

The host owns renewable node authority, fenced object activation, durability-gated HTTP output, peer
routing, cold alarm discovery, and idempotent shutdown. Hook processors for fragments sharing one
object connection execute serially; no adapter starts its own SQLite transaction engine. New
handlers wait for initialization and open transactions. Owning operation continuations use ordinary
SQL, while unrelated operations cannot join their transaction. Application requests are not replayed
on failure. Shutdown stops admission, closes worker-local resources (including Pi), drains pending
work, proves storage durable, and closes connections. Authority cannot cancel an external effect
already in flight; handlers and hooks still need idempotency.

Node OpenTelemetry starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured and identifies the
host and workers as `rejot-backoffice-web`. Application responses emit the existing structured
`backoffice.request.completed` log on wire completion or disconnect, including request ID, outcome,
status, duration, and trace identifiers. Set `GOOGLE_CLOUD_PROJECT` for Cloud Logging trace resource
names. Durable hooks retain W3C propagation context, not baggage. Worker shutdown flushes its
telemetry after application cleanup; host shutdown flushes the process SDK. Without an exporter,
trace instrumentation is a no-op and request completion logging remains enabled.

One worker owns each object's mutable local state. A replacement reconstructs it from that object's
Graft log; do not share old local SQLite files between processes. Initialization and configuration
refresh remain part of the existing object implementation. Keep persisted shared state in SQL/KV and
use Fragno OCC or runtime transactions for read/await/write operations; handler interleaving is not
an invocation lock.

Codemode executes in a sealed dynamic Worker in `cf-sandbox-bridge`, with compilation performed
directly inside that bridge. One authenticated WebSocket carries each expression, JavaScript module,
or workflow activation. Node keeps runtime-tool authorization, scoped/MCP providers, workflow
checkpoints, and durable agent state. The executor owns no durable state, cannot reconnect to an old
activation, and does not grant the guest direct internet access. Source, frames, calls, logs, CPU,
subrequests, and activation duration are bounded by `@fragno-dev/codemode`.

If you access Node Backoffice through an HTTPS reverse proxy, set `DOCS_PUBLIC_BASE_URL` to its
public HTTPS URL. Have the proxy **preserve the public `Host` header** and overwrite
`X-Forwarded-Proto` with `https` and `X-Forwarded-For` with the client IP. The Node server ignores
`X-Forwarded-Host` and rejects other origins (HTTP 421). It trusts `X-Forwarded-Proto` only from
loopback by default; for a proxy on another machine, set `BACKOFFICE_TRUST_PROXY` to its IP address
or CIDR and explicitly set `HOST` to the Node bind address. Set `BACKOFFICE_TRUST_PROXY=false` to
disable proxy trust. Keep the Node port inaccessible to untrusted clients when binding outside
loopback.

Graft persists Auth, Fragment, and Pi SQL together with each object's KV and alarms. Local caches
must be node-local; a fleet shares the durable remote and canonical control log, not cache files.
Cloudflare bindings such as external upload buckets and sandbox containers are not emulated.
Cloudflare account integrations require their configured credentials, and sandbox lifecycle and
commands use the bridge. Verify bridge limits and interruption behavior before rollout. Production
still requires durable-remote backups, TLS, trusted proxies, private peer networking, and a policy
for the rate-limit bucket when a client IP cannot be determined.

## Release

Deploy `cf-sandbox-bridge` before releasing Backoffice versions that use its compiler entrypoint.
Backoffice release scripts do not deploy the bridge or its containers. When migrating an existing
installation, keep the former compiler service available until all callers have switched to the
bridge.

When a release adds a Durable Object class, an inactive upload cannot provision its namespace.
Bootstrap that release instead:

```bash
pnpm --dir apps/backoffice run deploy:bootstrap
```

Bootstrap builds and **activates** the object and web Workers in dependency order so the object
Worker can provision its classes before the web Worker binds to them. It skips container image
rollout (`--containers-rollout=none`); deploy container changes separately if the release requires
them. This is a live release, not an inactive upload.

For releases without new Durable Object classes, upload an inactive version of all Workers with one
shared tag:

```bash
VERSION_TAG=release-$(date -u +%Y%m%d-%H%M%S)
pnpm --dir apps/backoffice run deploy:upload -- --tag "$VERSION_TAG"
```

Activate the tagged versions in dependency order: object host, then web Worker:

```bash
pnpm --dir apps/backoffice run deploy -- \
  --version-tag "$VERSION_TAG@100%" \
  --yes
```

The two activations are sequential, so releases must remain compatible during the rollout.
