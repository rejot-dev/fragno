# Backoffice Node Runtime Demo

A standalone multi-process demonstration built against the public exports of
`@fragno-private/backoffice-node-runtime`.

The deployed application is storage-provider neutral. It receives a complete Graft configuration
through `GRAFT_CONFIG`; bucket names, remote types, credentials, endpoints, and cache placement
belong to Graft and deployment configuration rather than application code.

There are three serving process roles:

- **Fleet supervisor:** local development tool that provisions a filesystem remote, starts
  independent runtime nodes, serves the switchboard, and forwards debugging requests to one exact
  selected node. It does not host objects or claim ownership.
- **Gateway:** discovers live workers without launching them, probes authority-aware readiness, and
  streams one attempt per application request to the application origin stored in each node lease.
  It never provisions objects or exposes peer ingress.
- **Runtime node:** owns separate application and internal HTTP listeners, authenticated internal
  peer WebSocket ingress, alarm polling, idle eviction, automatic Fetch output gates, request-owned
  namespace handles, readiness probe, and shutdown ordering. Each resident object runs in its own
  worker thread inside this process.

The app demonstrates lazy object placement, cross-node Cap'n Web RPC, SQL and KV persistence,
callbacks, returned capabilities, promise pipelining, structured values, Fetch streaming, alarms,
`waitUntil`, renewable node authority, fencing, hard-kill takeover, and complete cache-deletion
recovery.

## Source layout

```text
src/
├── start-fleet.ts                       # Local supervisor listener, configuration, and signals
├── start-node.ts                        # Runtime host, explicit networking, and signals
├── start-gateway.ts                     # Read-only gateway, no worker launcher
├── gateway/                             # Runtime gateway end-to-end process scenario
├── fleet/
│   ├── fleet-supervisor.ts              # Node slots, observations, forwarding, and lifecycle
│   ├── fleet-app.ts                     # Switchboard HTTP API
│   ├── fleet-page.ts                    # Switchboard HTML and browser controls
│   ├── node-process.ts                  # Spawn, await readiness, stop, and crash child nodes
│   ├── local-filesystem-graft-storage.ts # Local fleet filesystem setup
│   └── fleet.scenario.ts                # Supervisor end-to-end process scenario
├── node/
│   ├── node-app.ts                      # Application-only object routes
│   ├── node-internal-app.ts             # Internal-only inspection and administrative routes
│   ├── node-request-boundary.ts         # Shared HTTP input validation and error mapping
│   ├── node-page.ts                     # Read-only node control overview
│   ├── node-ready-message.ts            # Child-process IPC readiness contract
│   └── node.scenario.ts                 # Direct-node durability and failover scenario
├── objects/
│   ├── demo-object.ts                   # Worker-importable object factory and capabilities
│   └── demo-object-definition.ts        # Object binding definition and name constraints
├── storage/
│   └── configured-graft-storage.ts      # GRAFT_CONFIG and control locator boundary
├── testing/
│   ├── native-graft-extension-smoke.ts  # Final-image native extension smoke
│   └── fixtures/                        # Isolated scenario child processes
└── inspection/
    ├── object-control-overview.ts       # Fresh control-log queries and debug snapshot types
    └── object-status.ts                 # Ownership and alarm status interpretation
```

Runtime setup imports the object definition directly, not through the HTTP app. Control inspection
reads the shared log without activating objects or resetting their idle timers. Process scenarios
are colocated with the subsystem they exercise.

The durable binding remains `SHOWCASE:<name>`, and the SQL tables remain `runtime_showcase_counter`
and `runtime_showcase_events`.

## Run the supervised local fleet

Use the repository's Node.js 26.10.0 runtime from `.node-version`:

```sh
pnpm exec turbo run build --filter=@fragno-private/backoffice-node-runtime-demo --output-logs=errors-only
pnpm --filter=@fragno-private/backoffice-node-runtime-demo start -- --nodes 3
```

Open `http://127.0.0.1:3210`. The local fleet app provisions a shared filesystem control log, starts
each node with two ephemeral loopback ports and an independent cache, and shows:

- node process, identity, lease, cache, and observation latency;
- an object-by-node placement board;
- per-node read, increment, control, and alarm forms;
- a multi-object form and generic exact-node request console;
- graceful stop, hard crash, restart, and delete-cache-and-restart controls.

The fleet API is:

```text
GET  /api/fleet
POST /api/nodes/:slot/requests
POST /api/nodes/:slot/lifecycle
```

Forwarded requests require `{ ingress: "application" | "internal", method, path, body }`. The
console's listener selector and control buttons choose the destination explicitly; neither the
supervisor nor gateway classifies paths. The fleet UI is a local administrative tool, not public
ingress.

The selected ingress node need not own or execute the requested object. `Ctrl-C` first stops fleet
node selection, then gracefully drains every live node.

## Run the process scenarios

```sh
pnpm exec turbo run test --filter=@fragno-private/backoffice-node-runtime-demo --output-logs=errors-only
```

The test command runs:

- gateway discovery, route isolation, streaming, cancellation, and uncertain-delivery handling;
- direct-node peer routing, durability, takeover, and cache deletion;
- the three-node supervisor lifecycle scenario.

Backend-specific qualification does not live in this application. Remote implementation tests and
published native artifacts belong to the Graft repository.

## Supply Graft configuration

Serving nodes, gateways, and the runtime bootstrap CLI read:

```sh
GRAFT_CONFIG=/path/to/graft.toml
```

The default is `./graft.toml`. The Docker image sets the default to `/config/graft.toml`.

A local filesystem example is:

```toml
data_dir = "/runtime-data/cache"
make_default = false

[remote]
type = "fs"
root = "/data/remote"
```

The application verifies that the path identifies a file but does not parse or rewrite its contents.
Each process needs an isolated `data_dir`; all fleet members must point their remote configuration
at the same durable history.

## Bootstrap a configured deployment

Bootstrap belongs to `@fragno-private/backoffice-node-runtime`, which owns the control schema. The
runtime CLI exposes two explicit phases. First reserve the durable control-log identity without
publishing anything:

```sh
GRAFT_CONFIG=/path/to/graft.toml \
  pnpm --filter=@fragno-private/backoffice-node-runtime cli \
  bootstrap reserve
```

The command prints:

```text
GRAFT_CONTROL_REMOTE_LOG_RESERVED:{"controlRemoteLogId":"..."}
```

Persist that ID in deployment configuration. Then publish and verify the control history:

```sh
GRAFT_CONFIG=/path/to/graft.toml \
  pnpm --filter=@fragno-private/backoffice-node-runtime cli \
  bootstrap publish --control-remote-log-id 'reserved-id'
```

`publish` is safe to rerun with the same ID after interruption. It either creates the control schema
or verifies the existing schema through a fresh clone. Deployment tooling is responsible for
persisting the reservation and ensuring that only one bootstrap operation chooses the canonical ID.
Worker and gateway startup never bootstrap storage.

## Run nodes manually

Each node requires the same control-log ID and peer authentication secret. Processes on the same
host need separate Graft files because their `data_dir` values must differ.

```sh
GRAFT_CONFIG=.data/node-a.toml \
BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID='reserved-id' \
BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET='replace-with-at-least-32-characters' \
HOST=127.0.0.1 \
PORT=3210 \
BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT=3211 \
  pnpm --filter=@fragno-private/backoffice-node-runtime-demo start:node

GRAFT_CONFIG=.data/node-b.toml \
BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID='reserved-id' \
BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET='replace-with-at-least-32-characters' \
HOST=127.0.0.1 \
PORT=3212 \
BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT=3213 \
  pnpm --filter=@fragno-private/backoffice-node-runtime-demo start:node
```

When the listen address is not the address other processes should use, provide both advertised
addresses explicitly:

```sh
BACKOFFICE_NODE_RUNTIME_DEMO_APPLICATION_ORIGIN=http://10.20.0.4:8080
BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_ORIGIN=http://10.20.0.4:8081
BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT=8081
```

The application origin is stored in the node lease and must be reachable from the gateway. The
runtime derives the peer WebSocket endpoint on the internal origin (`/__node-object-peer`, WS or WSS
according to the origin's HTTP or HTTPS scheme). The internal origin is returned to the local fleet
but is not another control-schema field. There is no metadata-server discovery or
deployment-platform mode; the deployer owns address selection and internal network access controls.
Do not route public ingress to the internal listener. Administrative authentication remains the
integrator's responsibility; a separate port alone is not authorization.

Send requests to either node:

```sh
curl http://127.0.0.1:3210/objects/demo

curl -X POST http://127.0.0.1:3212/objects/demo/increments \
  -H 'content-type: application/json' \
  -d '{"deltas":[2,3],"label":"one-output-gate"}'

curl http://127.0.0.1:3212/objects/demo/fetch/stream
# Inspection and administration use the internal listener, never application ingress.
curl http://127.0.0.1:3211/control/demo
```

The app accepts object names matching `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`. Object logs are created
lazily by the first operation; concurrent creators select one canonical log through the
receipt-backed control command before activation.

The application listener reserves `GET /_runtime/ready`. It returns `200` only while the node
retains serving authority. The internal listener serves the inspection page at `/`, `/health`,
`/debug/overview`, `/control/:name`, and `POST /tick`. Internal read-only diagnostics remain
available after self-fencing; commands still enforce runtime authority. Unknown paths never fall
back to the other listener.

## Run the gateway

The demo wires the runtime package's gateway primitive to an HTTP listener. It has no application
route allowlist: the node's application router is the single source of truth. Discovery, readiness
checks, single-attempt forwarding, and resource cleanup belong to the runtime package. The gateway
reads the same Graft control history but never claims node or object ownership:

```sh
GRAFT_CONFIG=/path/to/gateway-graft.toml \
BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID='reserved-id' \
HOST=0.0.0.0 \
PORT=8080 \
  pnpm --filter=@fragno-private/backoffice-node-runtime-demo start:gateway
```

Each node lease contains the application origin validated when the node registers. The gateway uses
that authoritative origin directly and:

- forwards application paths without knowing the application's routing table;
- verifies the leased node ID and process generation;
- preserves application `Authorization` and cookies; strips hop-by-hop and proxy credentials;
- streams request and response bodies with cancellation and backpressure;
- makes exactly one application delivery attempt.

A failed response after delivery is reported as uncertain and is never replayed automatically.
Authentication and authorization belong to the application, not the gateway. The runtime's
`/_runtime/ready` response supplies the leased node ID and process generation; discovery does not
depend on the demo's `/health` route.

## Request scripts

Run these from the app directory. They default to the supervised fleet at `http://127.0.0.1:3210`
and target `node-1`:

```sh
./scripts/requests/status.sh
./scripts/requests/mutations.sh
./scripts/requests/rpc.sh
./scripts/requests/alarms.sh
```

Choose another exact ingress node and object identity:

```sh
./scripts/requests/status.sh --node node-2 --name customer-42
./scripts/requests/mutations.sh --node node-2 --name customer-42
```

## Run the container

The Dockerfile consumes Turborepo's pruned build context, builds the pinned native Graft extension,
and starts one runtime node with application port `8080` and internal port `8081`. Native artifact
publication remains future work.

```sh
rm -rf /tmp/backoffice-node-runtime-demo-prune
pnpm exec turbo prune @fragno-private/backoffice-node-runtime-demo \
  --docker \
  --out-dir=/tmp/backoffice-node-runtime-demo-prune

docker build \
  --file apps/backoffice-node-runtime-demo/Dockerfile \
  --tag backoffice-node-runtime-demo \
  /tmp/backoffice-node-runtime-demo-prune
```

The image declares `/config`, `/data`, and `/runtime-data` as volumes and defaults `GRAFT_CONFIG` to
`/config/graft.toml`. Mount configuration read-only. `/data` supports the included local filesystem
example; other remote layouts remain entirely defined by the supplied Graft file.

Reserve an ID, persist it outside the container, then publish it:

```sh
docker run --rm \
  --mount type=bind,source="$PWD/apps/backoffice-node-runtime-demo/graft.container.toml",target=/config/graft.toml,readonly \
  --mount source=backoffice-node-runtime-demo-data,target=/data \
  backoffice-node-runtime-demo backoffice-node-runtime bootstrap reserve

# Copy the printed controlRemoteLogId into CONTROL_REMOTE_LOG_ID.

docker run --rm \
  --mount type=bind,source="$PWD/apps/backoffice-node-runtime-demo/graft.container.toml",target=/config/graft.toml,readonly \
  --mount source=backoffice-node-runtime-demo-data,target=/data \
  backoffice-node-runtime-demo backoffice-node-runtime bootstrap publish \
  --control-remote-log-id "$CONTROL_REMOTE_LOG_ID"
```

Start a node:

```sh
docker run --rm \
  --publish 127.0.0.1:3210:8080 \
  --publish 127.0.0.1:3211:8081 \
  --mount type=bind,source="$PWD/apps/backoffice-node-runtime-demo/graft.container.toml",target=/config/graft.toml,readonly \
  --mount source=backoffice-node-runtime-demo-data,target=/data \
  --env BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID="$CONTROL_REMOTE_LOG_ID" \
  --env BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET='replace-with-at-least-32-characters' \
  --env BACKOFFICE_NODE_RUNTIME_DEMO_APPLICATION_ORIGIN=http://127.0.0.1:3210 \
  --env BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_ORIGIN=http://127.0.0.1:3211 \
  backoffice-node-runtime-demo
```

This single-node example publishes both ports only on host loopback. For a multi-container fleet,
advertise each node's reachable network name and container ports instead (for example,
`http://runtime-node:8080` and `http://runtime-node:8081`), and do not publicly publish the internal
port. Docker `EXPOSE` is metadata, not an access-control rule.

## Persistence and lifecycle

The local fleet stores state under `apps/backoffice-node-runtime-demo/.data/` by default:

- `cache/<node>/` contains disposable process-local Graft state;
- `remote/` is the shared filesystem remote;
- `control-remote-log-id` is the local fleet's published control locator;
- `bootstrap-reserved-control-log-id` preserves the locator across interrupted local bootstrap.

Idle sweeps default to every five seconds, evicting activations idle for sixty seconds. Active
calls, open output scopes, and registered pending work prevent eviction. Eviction terminates the
resident object worker and releases ownership, but does not delete SQL, KV, object logs, or future
alarms.

Stop a direct node with `Ctrl-C` so the host can stop admission, settle active Fetch handlers, close
peer sessions, drain object workers, and conditionally release exact claims. A hard-killed node
leaves objects owned until its last durable lease expiry plus the declared clock-skew allowance.

## Configuration

| Environment variable                                             | Default or requirement                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GRAFT_CONFIG`                                                   | `./graft.toml`; Docker: `/config/graft.toml`                                 |
| `BACKOFFICE_NODE_RUNTIME_DEMO_CONTROL_REMOTE_LOG_ID`             | Required by node and gateway                                                 |
| `BACKOFFICE_NODE_RUNTIME_DEMO_PEER_AUTHENTICATION_SECRET`        | Required by nodes; minimum 32 characters                                     |
| `HOST`                                                           | Node: `127.0.0.1`; gateway: `0.0.0.0`                                        |
| `PORT`                                                           | Node: `3210`; gateway: `8080`                                                |
| `BACKOFFICE_NODE_RUNTIME_DEMO_APPLICATION_ORIGIN`                | Required with explicit internal origin; otherwise derived from local bind    |
| `BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_ORIGIN`                   | Required with explicit application origin; otherwise derived from local bind |
| `BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_HOST`                     | Same as the application listen host                                          |
| `BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT`                     | `3211`; Docker: `8081`; local fleet: ephemeral                               |
| `BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS`                 | `1000`                                                                       |
| `BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS`                 | `10000`, minimum `2001`                                                      |
| `BACKOFFICE_NODE_RUNTIME_DEMO_OBJECT_EVICTION_SWEEP_INTERVAL_MS` | `5000`                                                                       |
| `BACKOFFICE_NODE_RUNTIME_DEMO_OBJECT_IDLE_TIMEOUT_MS`            | `60000`                                                                      |
| `BACKOFFICE_NODE_RUNTIME_DEMO_FLEET_HOST`                        | Local fleet: `127.0.0.1`                                                     |
| `BACKOFFICE_NODE_RUNTIME_DEMO_FLEET_PORT`                        | Local fleet: `3210`                                                          |
| `BACKOFFICE_NODE_RUNTIME_DEMO_NODE_COUNT`                        | Local fleet: `3`                                                             |
| `BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR`                          | Local fleet only: this app's `.data/`                                        |

`FRAGNO_GRAFT_EXTENSION_PATH` selects the native extension binary and remains independent from the
configured remote backend.
