# Integrations

The registered `integrations` tools provide scope-bound discovery, setup, and execution over
existing service-owned configuration. They do not own credentials, binding records, or setup-attempt
history.

Reson8 is the implemented source. Codemode and terminal commands use the same contracts, runtime,
and permissions. Reson8 execution is exposed only through `integrations.*`; its former standalone
tool family and runtime have been removed. The underlying Fragment, Durable Object, native
permissions, events, and organization configuration controls remain intact.

## Public surface

- `discover()`: services and known named setup targets, including unconfigured services.
- `list({ cursor })`: one page of configured `connections` with deterministic IDs.
- `get({ connectionId })`: saved configuration, authorization, and available evidence; no live
  check.
- `actions({ connectionId })`: supported actions with authoritative input/output JSON Schemas.
- `execute({ connectionId, actionId, input })`: invoke the exact live action with JSON input/output.
- `verify({ connectionId })`: explicit supported live checks, returning timestamped evidence.
- `setup({ kind: "check", connectionId })`: read current source-owned setup requirements.
  `setup({ kind: "input", connectionId, input })` submits direct JSON values to the same operation.

`connect`, `continueSetup`, and `disconnect` are not registered. There is no reference object,
caller scope argument, binding name, or retained setup ID. Configuration is not proof of working
credentials; setup-ready is not blanket health, and discovery never authorizes an action.

## Deterministic connection IDs

An ID has the form `namespace#local-id`. The namespace routes to its registered owner; the suffix is
preserved as source identity, including case and additional `#` characters. It is never slugified or
interpreted as a scope selector. These are scoped addresses, not global identities or bearer tokens.

`backoffice#reson8` names the selected organization's existing singleton configuration slot. It
works before setup, survives object/runtime recreation and credential replacement, and remains a
valid slot address after existing configuration controls reset its credentials. It is not an
independently named or revocable binding. Another organization's use of the same address names that
other organization's configuration, not the first organization's credentials.

Implementations declare exact ID claims or whole namespace claims. Registration rejects duplicate
claims and overlapping exact/namespace claims before exposing any operation. Sources may publish
only the addresses they own. This is code-owned routing metadata, not a persistent reservation
store.

Future sources can own `api#<connection-slug>`, `mcp#<server-slug>`, and
`connector#<connected-account-id>`. If native identity is only unique within another source
instance, its local address must include that qualifier losslessly. Those sources are not
implemented by merely reserving their prefixes; unknown addresses fail closed. Service identity
remains separate: a Gmail account can have a Connector address while still being presented as Gmail.

## Service-owned setup

Reson8 setup with `{ kind: "check" }` reads current configuration without contacting the provider or
writing credentials. Missing credentials return `needs-input`, an authoritative input schema, and
`secretFields: ["apiKey"]`. Requested input is validated and saved through the existing
configuration command. If already configured, setup returns `ready` without replacing the existing
key, even if new input was supplied.

In the terminal, omitting `--input-json` checks current requirements; providing it submits the JSON
value directly, without a `response` or `values` wrapper. JSON `null` is a submission, not a check
sentinel. Sources validate submissions against their current requirements; Reson8 requires an object
containing `apiKey`, so null, scalars, and arrays are rejected when configuration is missing. Empty
or malformed flag values fail rather than silently becoming checks. `--response-json` is not an
alias. Codemode uses explicit `kind: "check"` / `kind: "input"` variants to preserve the same
distinction.

There is no private continuation state in the shared interface. Setup can resume across requests or
object restarts by reading the source again. Resetting configuration makes the same address request
input again. Concurrent submissions retain the existing store's write semantics; the facade does not
promise reservations, exactly-once setup, or permanently retained terminal outcomes.

Only named-connection setup is currently supported. A future source whose account ID is assigned
after authorization needs explicit start/continuation variants with a source-owned attempt locator.
Do not invent an account ID, encode private state in a public token, or add an integrations-owned
attempt store to fit that flow into the named-connection operation.

## Implementation boundary

- `integration-contracts.ts`: canonical public schemas and inferred types.
- `integration-tools.ts`: the seven tools, Bash adapters, and scope-bound runtime contract.
- `integration-implementation.ts`: connection ID claims, explicit setup capability, and resolved
  request-local connection operations. No binding/setup generics or shared private state schemas.
- `integration-registry.ts`: claim ownership, source dispatch, and composite cursor pagination.
- `integrations-runtime.ts`: production source assembly and public operation dispatch.
- `reson8-integration.ts`: existing organization configuration, authorized Fragno routes, and action
  validation. The only provider transport seam is injected fetch.

An implementation can describe multiple services and owns listing, source-local resolution, and any
supported setup. Setup capability is `supported` or `unsupported`, never an optional method.

Resolution establishes the selected connection and execution authority. It returns identity plus
bound `inspect`, `actions`, and `verify` operations. Inspection is lazy: actions must not acquire an
extra configuration-read requirement merely because the runtime resolved their target. Action
handlers capture authority and the private locator for this request; callers cannot supply a
different invocation context. None of these closures is persisted or returned through the public
tools.

Action metadata and invocation remain coupled. Input/output use JSON values only, including scalars,
arrays, and null. Binary fields are schema-declared integer byte arrays (0–255), converted
privately. Result contracts retain domain and asynchronous semantics; a no-payload result is null.
There is no second persisted dispatcher or handwritten duplicate contract.

The registry returns source pages without materializing all connections. Its opaque cursor
identifies the next source and that source's unchanged cursor. An unknown source or malformed cursor
fails rather than silently restarting. Pagination never changes execution scope or grants access.

## Codemode usage

In an organization-scoped provider, supply a requested API key and valid audio bytes:

```ts
const target = { connectionId: "backoffice#reson8" };
let setup = await integrations.setup({ ...target, kind: "check" });
if (setup.status === "needs-input") {
  setup = await integrations.setup({
    ...target,
    kind: "input",
    input: { apiKey },
  });
}
if (setup.status !== "ready") throw new Error("Reson8 setup is not ready.");

const connectionId = setup.connectionId;
const actions = await integrations.actions({ connectionId });
const checked = await integrations.verify({ connectionId });
const transcript = await integrations.execute({
  connectionId,
  actionId: "prerecorded.transcribe",
  input: { audio: { bytes: audioBytes }, query: null },
});
```

## Terminal usage

Each command supports `--help`, `--format json` / `--json`, and `--print <selector>`. Setup and
action `--input-json` accept any JSON value; each source/action validates its own shape.
`--connection-id` is a scalar string, not a JSON reference.

The dashboard starts a fresh shell per submission, so these commands do not depend on shell
variables from earlier submissions. In an organization scope:

```sh
integrations.discover
integrations.setup --connection-id 'backoffice#reson8' --format json

# If needs-input, replace the placeholder with the requested API key.
integrations.setup --connection-id 'backoffice#reson8' \
  --input-json '{"apiKey":"YOUR_RESON8_API_KEY"}' \
  --format json

integrations.list --print connections.0.connectionId
integrations.get --connection-id 'backoffice#reson8'
integrations.actions --connection-id 'backoffice#reson8' --format json
integrations.verify --connection-id 'backoffice#reson8' --format json
integrations.execute --connection-id 'backoffice#reson8' \
  --action-id prerecorded.transcribe \
  --input-json "$(cat /workspace/transcription-input.json)" \
  --format json
```

The input file contains real audio integer bytes and `query: null` (or the discovered explicit query
shape). Illustrative bytes are not a valid audio recording for a live provider.

## Authority and evidence

Umbrella `integrations.read`, `.manage`, and `.execute` apply at the tool boundary. Setup and
verification require manage. They neither replace native permissions nor broaden role grants.
Configuration inspection/setup reads require `connections.read`; submitted keys require
`connections.manage`; transcription and live checks require `reson8.use`.

Verify performs a read-only custom-model listing. It neither transcribes, mints tokens, persists
health, nor publishes provider credential echoes. A subsequent get remains `not-checked`.
Receiving-object authorization denials, including unavailable authority resolution, propagate as
execution errors rather than failed provider checks. Provider HTTP errors still return sanitized
check evidence.

Concrete scenarios use real temporary SQLite, runtime/kernel authority, registered Codemode and Bash
tools, object restarts, authorized object HTTP, and real route handlers. Only external provider
fetch is substituted. They cover claim conflicts, deterministic addressing, both permission layers,
scope isolation, setup without handles, binary/query transport, output contracts, and check
evidence.
