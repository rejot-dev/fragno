# Backoffice

Backoffice deploys as two Cloudflare Workers:

- `rejot-backoffice` owns the Durable Objects and backend bindings.
- `rejot-backoffice-web` is the public React Router Worker.

Codemode guests compile and run in the separately deployed
[`cf-sandbox-bridge`](../cf-sandbox-bridge/README.md#compiler). Both Backoffice Workers bind
`CODEMODE_EXECUTOR` to its private `CodemodeExecutor` entrypoint, which runs each activation as its
own request, and `CODEMODE_COMPILER` to `CodemodeCompiler` for type checking. Backoffice loads no
Dynamic Workers itself. Deploy the bridge before Backoffice when either entrypoint changes. `dev`
and `preview` run the bridge as an auxiliary Worker, so local development needs no second command.

Every codemode activation (the Pi `codemode` tool, `js.build`, `js.run`, Pi workspace extensions,
and each workflow tick) goes through the scope's `CODEMODE` Durable Object, which calls the bridge
and keeps seven days of run history: outcome, error, and bounded logs. Guests have no network
egress; use the `web.*` tools for internet access.

## Tests

While working, run only the tests your changes reach from the repository root:

```bash
pnpm exec turbo run test:changed --filter=@fragno-apps/backoffice-rr
```

This runs every Cloudflare test plus the Node tests whose imports reach a changed file, or the full
suite when a change is outside the import graph; see
[Changed tests](../../CONTRIBUTING.md#changed-tests). Run the full Node and Cloudflare suites with:

```bash
pnpm exec turbo run test --filter=@fragno-apps/backoffice-rr
```

Turbo builds workspace dependencies and generates static content before testing. Tests consume
application source, so they do not require a Backoffice production build. Vitest uses half the
available CPUs, leaving capacity for other package tasks running alongside it.

Watch application and workspace dependency changes with:

```bash
pnpm test:watch --filter=@fragno-apps/backoffice-rr
```

This uses `turbo watch test`: dependencies are rebuilt before the test task reruns. To use Vitest's
own file watcher instead, run
`pnpm exec turbo watch test:watch --filter=@fragno-apps/backoffice-rr`; Turbo prepares dependencies
and restarts the watcher when their inputs change. Running `pnpm --dir apps/backoffice test:watch`
directly assumes dependency outputs and static content are already current.

Cloudflare tests use `tests/wrangler.vitest.jsonc` with deterministic test bindings and no remote
bindings. Keep that directory free of `.dev.vars` and `.env` files: Wrangler resolves development
secrets beside its configuration, and local credentials must not affect cached tests.

Ordinary tests do not start the Codemode bridge. Cloudflare tests serve the bridge's executor
in-process, with the test pool's Worker Loader and an unbundled compiler, from
`workers/vitest-codemode-executor-setup.ts`. The service-binding hop, bundling, npm installation,
and type checking are tested in `cf-sandbox-bridge`. Pure Codemode helpers are tested in the owning
package under Node.

Node-specific bridge transport and recovery scenarios run separately through `test:bridge`,
including binary codemode setup and in-flight event subscriptions. CI runs the Backoffice bridge
suite; local ordinary test runs do not. Run it together with the Codemode package's bridge lifecycle
tests when changing that boundary:

```bash
pnpm exec turbo run test:bridge --filter=@fragno-apps/backoffice-rr --filter=@fragno-dev/codemode --output-logs=errors-only
```

This explicit task starts a local workerd bridge; it does not require a separately running or
deployed bridge. These scenarios remain separate because direct Cloudflare RPC does not test Node's
WebSocket/HTTP transport, authentication, or interrupted activation recovery.

Coverage is disabled for ordinary test runs. Generate Backoffice-specific coverage separately:

```bash
pnpm exec turbo run test:coverage --filter=@fragno-apps/backoffice-rr
```

The task caches its reports under `apps/backoffice/coverage/`, including the HTML report at
`coverage/index.html`. The root `pnpm test:coverage` command remains the existing library-package
coverage aggregation workflow; it does not include Backoffice.

## PostHog (Cloudflare only)

The browser client in `app/posthog.client.ts` enables analytics only for a production Cloudflare
build served at `VITE_POSTHOG_APP_ORIGIN`. `app/entry.client.tsx` initializes the SDK synchronously
before hydration and provides it through PostHog's React provider; there is no awaited SDK chunk or
custom event queue. Initialization failures leave the application running without analytics. The
slim React bindings use only this explicitly supplied client, with no global SDK fallback. Node
builds, development servers, and local previews do not initialize the browser SDK. The Cloudflare
backend also captures server outcomes, exceptions, and Pi Durable Object generation metadata; Node
never installs a backend analytics client.

Provide these public values in the Cloudflare **build environment**, or in a git-ignored `.env` file
beside `package.json` (see `.env.example`):

- `VITE_POSTHOG_PROJECT_TOKEN`: the project's public client token, not a personal API key.
- `VITE_POSTHOG_HOST`: the ingestion host, currently `https://eu.i.posthog.com`.
- `VITE_POSTHOG_APP_ORIGIN`: the exact deployed origin, currently `https://backoffice.rejot.dev`.

These values are embedded at build time; setting Worker runtime secrets does not configure the
browser SDK. Changes require rebuilding the frontend, and Turbo includes these values in its build
cache key.

The initial integration captures pageviews, identifies authenticated users by their stable user ID,
resets identity after sign-out, and records browser exceptions. Six explicit product events cover
organization invitations, member role changes/removals, session message submissions/compaction
requests, and marketplace installation starts. Custom events exclude message contents, instructions,
and installation paths. A `before_send` hook strips query strings and fragments from URL properties,
including nested initial/person/session attribution and exception-frame URLs; referrers retain only
their origin. Campaign/search attribution is omitted, and failed redaction drops the event rather
than sending an unsafe payload. This applies before the first automatic capture and to attribution
already stored by the SDK. Autocapture masks text and element attributes; session replay is
disabled. `HydratedRouter.onError` reports caught client route/render failures independently of
nested route error boundaries, with route patterns instead of raw locations or parameters. Expected
route responses are not reported as exceptions. Server log capture is not enabled.

### Backend runtime configuration

Set the same public project token as a runtime secret named `POSTHOG_PROJECT_TOKEN` on **both**
`rejot-backoffice-web` and `rejot-backoffice`. It is intentionally not a Wrangler default:
deployment secrets are unavailable to local development and preview, keeping local backend traffic
out of PostHog. Do not copy this binding into `.dev.vars`. Both Wrangler configs set `POSTHOG_HOST`
to the EU ingestion host. Missing or invalid backend configuration disables capture without breaking
the application; frontend `VITE_*` values do not enable backend capture.

The public Worker records `backoffice_request_completed` with method, status, handler duration,
request ID, the verified `user_id` (null without a credential), and the scope a page names, without
URLs, headers, query strings, or bodies. Server product events record successful session creation,
prompt/compaction admission, completed aborts, and marketplace ingestion admission. These are
separate from browser submission events; admission does not mean an agent or ingestion workflow has
finished. Product identity comes from verified request authority, never a client-supplied analytics
ID. Request IDs match the existing `backoffice-request-id` response header.

The Pi Durable Object emits `$ai_generation` for terminal provider responses, with model/provider,
token/cache usage, cost, stop reason, and agent/conversation/task identifiers. No prompts,
instructions, model outputs, or tool arguments are included.

- **Person:** `user_id` and the distinct ID are the prompting user, the same ID as browser
  analytics. Turns no person prompted (automations, apps, system work) have a null `user_id` and the
  agent-scoped distinct ID `pi-agent:<agent>`, without creating person profiles.
- **Owner:** `scope`, `scope_kind`, and `organization_id` describe the agent's scope, which is fixed
  when the agent is created, so they name the owner at execution time rather than anyone's current
  membership. `organization_id` is the scope's root organization; it is null for personal scopes (a
  user's own scope, projects, and apps) and for `system`. `organization_slug` names it readably; the
  agent looks it up from Auth once, as renaming keeps the slug. Before 2026-10-23 09:20 UTC,
  user-scope generations carried the then-active billing organization instead, so personal
  attribution starts there.
- **Tokens:** pi-ai reports `input` without cached tokens for every provider, which
  `$ai_cache_reporting_exclusive: true` tells PostHog. Input, cache-read, cache-write, and output
  tokens therefore add up to the request's total. Cost is pi-ai's estimate from its model prices
  (`$ai_cost_passthrough`), not an amount billed to customers.
- **Replays:** a response replayed after a restart (a deferred poll that restarts) is reported again
  with the same UUID, timestamp, and properties, which PostHog deduplicates. Billing records it
  once.

The usage ledger (`app/fragno/billing/README.md`) is authoritative for customer usage. PostHog
reports provider responses, so it also counts responses a restart cut off before they were
committed, and it can lose events whose delivery was cut off.
`app/fragno/pi/extensions/posthog/posthog-extension.scenario.test.ts` reconciles the two per owner.

Events carry `$groups.organization`, but the project is on PostHog's free plan without Group
Analytics, so PostHog ignores it. Break down by the `organization_slug` property instead, which
request and generation events carry beside `organization_id`; earlier events have only the ID.

Active users in a period are the distinct `user_id`s of `backoffice_request_completed`; active
organizations are the distinct `organization_id`s of those requests, which name an organization's
workspace or one of its projects. Neither is a registered total, which only Auth knows.

Each Worker request or Pi response owns its own server client. Batches flush through the owner's
`waitUntil`, and streaming exceptions use immediate delivery through that same lifetime boundary.
Capture is best-effort, bounded, and cannot change an already committed application outcome; it is
not a durable audit log. Development builds and runtimes without a deployment token do not capture.

The wizard created the **Analytics basics (wizard)** dashboard in EU PostHog project `296980`,
dashboard `1003657`. It will populate after the configured Cloudflare frontend is deployed and used.

## Blobs (Cloudflare only)

The `blobs.*` runtime tools keep large files in R2 and move their bytes through presigned S3 API
URLs, never through the Worker. All scopes share one bucket per jurisdiction, each under its own
prefix. An R2 bucket's jurisdiction is fixed when it is created, so a deployment needs three buckets
with the same name: one without a jurisdiction, for owners that chose none, and one in each of `eu`
and `us`. Locally, Miniflare serves a single bucket and needs none of this.

Before the first release with blobs:

1. Create the buckets:

   ```bash
   cd apps/backoffice
   pnpm exec wrangler r2 bucket create rejot-backoffice-blobs
   pnpm exec wrangler r2 bucket create rejot-backoffice-blobs --jurisdiction eu
   pnpm exec wrangler r2 bucket create rejot-backoffice-blobs --jurisdiction us
   ```

2. In the Cloudflare dashboard, under **R2 > Manage API tokens**, create an API token with **Object
   Read & Write** on all three buckets. Note its access key ID and secret access key.
3. Set the object Worker's secrets. The endpoint is the account's, without a jurisdiction;
   Backoffice derives `https://<account-id>.eu.r2.cloudflarestorage.com` and the `us` endpoint from
   it.

   ```bash
   pnpm exec wrangler secret put BLOBS_R2_ENDPOINT # https://<account-id>.r2.cloudflarestorage.com
   pnpm exec wrangler secret put BLOBS_R2_ACCESS_KEY_ID
   pnpm exec wrangler secret put BLOBS_R2_SECRET_ACCESS_KEY
   ```

4. Release with `deploy:bootstrap` (see [Release](#release)), as blobs add the `Blobs` Durable
   Object class.

`BLOBS_R2_BUCKET` is set in `wrangler.jsonc`. Clients reach the presigned URLs with `curl` and other
non-browser tools, which need no CORS policy; a browser that moves blobs directly does, on each of
the three buckets (`wrangler r2 bucket cors set ... --jurisdiction ...`).

## Run on Node with file-backed SQLite

For a file-backed Node instance without Cloudflare bindings, create `apps/backoffice/.dev.vars` from
`.dev.vars.example` if you do not already have one. Set `AUTH_ACCESS_TOKEN_SECRET` and
`BACKOFFICE_INTERNAL_REQUEST_SECRET` there; replace the example secrets with strong values and keep
them unchanged across restarts. Codemode and Cloudflare sandbox management require
`apps/cf-sandbox-bridge`, which provides remote execution, TypeScript checking, and sandbox HTTP
APIs. Set `CLOUDFLARE_BRIDGE_URL` to the bridge's `https://` origin and `CLOUDFLARE_BRIDGE_API_KEY`
to its `SANDBOX_API_KEY`. Codemode derives `wss://` for WebSocket activations. For local Wrangler
development, `http://127.0.0.1:8787` is allowed. Both Node processes use these same settings.
Missing configuration fails startup; bridge unavailability fails the invocation without a local
fallback or automatic immediate retry. Node no longer needs Deno. A disconnected activation has an
unknown outcome: tool effects already performed are not rolled back. Workflow retries follow the
existing Node-owned step policy and checkpoints. SQLite data defaults to `.backoffice-node/`; set
`BACKOFFICE_SQLITE_DIR` in `.dev.vars` to use another path. The file and default data directory are
ignored by git.

`web.download` is not available on Node and fails as not configured. Node's `fetch` connects to
whatever a hostname resolves to, so a URL could reach the server's private network, such as cloud
metadata or internal services. Deployed Workers cannot connect to private addresses. Supporting Node
needs a transport that checks every address its DNS lookup returns before connecting.

```bash
pnpm --dir apps/backoffice start:node
```

To run the local `cf-sandbox-bridge` under the same supervisor, configure its API key and pass
`--local-bridge`:

```bash
cp apps/cf-sandbox-bridge/.dev.vars.example apps/cf-sandbox-bridge/.dev.vars
# Set SANDBOX_API_KEY in apps/cf-sandbox-bridge/.dev.vars.
pnpm --dir apps/backoffice start:node -- --local-bridge
```

The flag starts the bridge at `http://127.0.0.1:8787`, copies its `SANDBOX_API_KEY` into
Backoffice's `CLOUDFLARE_BRIDGE_API_KEY`, and sets `CLOUDFLARE_BRIDGE_URL` in
`apps/backoffice/.dev.vars`. If Backoffice's file does not exist, it is created from
`.dev.vars.example`. The supervisor stops the bridge, web server, and processor together.

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
only the bundled Node build, its launcher, and the native SQLite runtime dependency. Codemode,
TypeScript checking, and sandbox execution use the configured Cloudflare bridge; Deno is not
bundled.

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
CLOUDFLARE_BRIDGE_URL=https://cf-sandbox-bridge.rejot.workers.dev/
CLOUDFLARE_BRIDGE_API_KEY=<bridge-SANDBOX_API_KEY>
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

This stores auth, object key/value state and alarms, and Fragment databases in SQLite files under
the selected data directory. Fragno's Node hook processor polls durable hooks, while the runtime
processor services the remaining object-owned alarms. Do not run multiple processor replicas against
the same directory. Cloudflare-specific account integrations and external upload storage are **not**
provided by this mode. Sandbox lifecycle and command execution use the configured bridge without
running containers locally. Verify the deployed bridge's resource limits and interruption behavior
before rollout. Production still requires backups, TLS, trusted proxies, and a policy for the shared
rate-limit bucket when a client IP cannot be determined.

## Run objects as Rivet Actors (moving off Cloudflare)

With `BACKOFFICE_OBJECT_HOST=rivet`, the Node server runs every Backoffice object as a
[Rivet Actor](https://rivet.dev) instead of on SQLite files, and copies each object from its
Cloudflare Durable Object the first time the actor starts. Each actor's SQLite holds its object's
tables, Durable Object storage keys (`__do_kv`) and alarm (`__do_meta`) as on Cloudflare; Rivet
schedules the alarm, which processes durable hooks, so the hook processor does not run.

| Variable                        | Meaning                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `BACKOFFICE_OBJECT_HOST=rivet`  | Run objects as Rivet Actors.                                                        |
| `RIVET_ENDPOINT`                | The Rivet Engine. Defaults to `http://127.0.0.1:6420`, which starts a local engine. |
| `CLOUDFLARE_OBJECTS_WORKER_URL` | The `rejot-backoffice` Worker's workers.dev URL. Unset starts every object empty.   |
| `WORKER_MIGRATOR_TOKEN`         | The same secret as on that Worker (`wrangler secret put WORKER_MIGRATOR_TOKEN`).    |

```bash
pnpm --dir apps/backoffice exec turbo run build:node --filter=@fragno-apps/backoffice-rr
BACKOFFICE_OBJECT_HOST=rivet node --env-file=apps/backoffice/.dev.vars apps/backoffice/build-node/node-server.mjs
```

The objects Worker serves only `/__migrate/*` from
[`@rivet-dev/durable-object-migrator`](https://github.com/rivet-dev/durable-object-migrator), and
each copied Durable Object rejects app traffic. To cut over: deploy the Worker with
`WORKER_MIGRATOR_TOKEN` set, start the Node server against the Rivet Engine, then point
`backoffice.rejot.dev` at it. Objects nobody requests stay on Cloudflare until something reaches
them; there is no backfill. To roll back, point the domain back at Cloudflare and set
`MIGRATOR_DISABLED=true` on the Worker; writes made on Rivet stay there.

## Release

Deploy `cf-sandbox-bridge` before releasing Backoffice versions that use its compiler entrypoint or
change its `Sandbox` interface. The object Worker binds the bridge's `Sandbox` class, so the bridge
owns the Sandbox container application and image; Backoffice release scripts deploy neither. When
migrating an existing installation, keep the former compiler service available until all callers
have switched to the bridge.

When a release adds a Durable Object class, an inactive upload cannot provision its namespace.
Bootstrap that release instead:

```bash
pnpm --dir apps/backoffice run deploy:bootstrap
```

Bootstrap builds and **activates** the object and web Workers in dependency order so the object
Worker can provision its classes before the web Worker binds to them. This is a live release, not an
inactive upload.

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
