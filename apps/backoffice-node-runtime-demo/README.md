# Backoffice Node Runtime Graft Showcase

A standalone HTTP app built only against the public exports of
`@fragno-private/backoffice-node-runtime`. It uses a filesystem-backed Graft remote so the complete
demo runs locally without S3 credentials.

The app demonstrates:

- one worker thread and object instance per `SHOWCASE:<name>` identity;
- authority-bound node registration, object claims, fencing epochs, readiness, and graceful release;
- application SQL and Durable Object-style KV in the same per-object Graft database;
- implicit per-call durability plus single-object and multi-object `runWithOutputGate()` batching;
- alarms and `waitUntil` work on the serving object instance;
- Cap'n Web callbacks, copied structured values, returned capabilities, and promise pipelining;
- Request/Response RPC, including a streamed response body;
- full local-cache deletion followed by recovery in a fresh process.

## Run the complete walkthrough

Use the repository's Node.js 26.10.0 runtime from `.node-version`. Build dependencies first because
object workers import the runtime's compiled worker module and this app's compiled object factory.

```sh
pnpm exec turbo run build --filter=@fragno-private/backoffice-node-runtime-demo
pnpm --filter=@fragno-private/backoffice-node-runtime-demo demo
```

The walkthrough starts the HTTP server in a child process, exercises every feature above, shuts down
cleanly, deletes the process-local Graft cache, and starts another process. It fails unless the
second process restores the durable count and KV value under fencing epoch 2.

## Run the server

```sh
pnpm exec turbo run build --filter=@fragno-private/backoffice-node-runtime-demo
pnpm --filter=@fragno-private/backoffice-node-runtime-demo start
```

Open `http://127.0.0.1:3210` or use the API directly:

```sh
curl http://127.0.0.1:3210/objects/demo

curl -X POST http://127.0.0.1:3210/objects/demo/increments \
  -H 'content-type: application/json' \
  -d '{"deltas":[2,3],"label":"one-output-gate"}'

curl -X POST http://127.0.0.1:3210/multi-object-increments \
  -H 'content-type: application/json' \
  -d '{"increments":[{"name":"demo","delta":1},{"name":"secondary","delta":7}]}'

curl -X POST http://127.0.0.1:3210/objects/demo/compatibility-value \
  -H 'content-type: application/json' \
  -d '{"value":"durable KV"}'

curl -X POST http://127.0.0.1:3210/objects/demo/capability \
  -H 'content-type: application/json' \
  -d '{"deltas":[4,1]}'

curl -X POST http://127.0.0.1:3210/objects/demo/alarm \
  -H 'content-type: application/json' \
  -d '{"delayMs":0}'
curl -X POST http://127.0.0.1:3210/tick

curl http://127.0.0.1:3210/objects/demo/fetch/stream
curl http://127.0.0.1:3210/control/demo
```

The app exposes two fixed object names, `demo` and `secondary`. It preprovisions both object logs
before the first authority claim because concurrent or late first-object provisioning is not yet
part of the distributed control protocol.

State is stored under `apps/backoffice-node-runtime-demo/.data/`:

- `cache/` is disposable process-local Graft state;
- `remote/` is the demo's durable filesystem remote;
- `control-remote-log-id` is the durable control-log locator;
- `graft.toml` points the process at those directories.

Stop with `Ctrl-C` so the app can stop admission, drain workers, and conditionally release its exact
control claims. The current runtime does not renew leases or provide a process watchdog. A
hard-killed server therefore leaves objects owned until its configured lease expires; this is
expected fencing behavior, not a production restart strategy.

## Configuration

| Environment variable                             | Default               |
| ------------------------------------------------ | --------------------- |
| `BACKOFFICE_NODE_RUNTIME_DEMO_HOST`              | `127.0.0.1`           |
| `BACKOFFICE_NODE_RUNTIME_DEMO_PORT`              | `3210`                |
| `BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR`          | this app's `.data/`   |
| `BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS` | `1000`                |
| `BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS` | `86400000` (24 hours) |

The filesystem remote is for local demonstration. It does not qualify production S3/R2 behavior, and
the runtime still lacks automatic lease renewal, peer routing, distributed alarm discovery, and
concurrent first-object provisioning.
