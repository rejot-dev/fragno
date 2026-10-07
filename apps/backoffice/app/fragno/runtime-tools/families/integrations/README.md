# Integrations

The registered `integrations` tools provide scope-bound discovery, setup, and execution over
existing service-owned configuration. They do not own credentials, binding records, or setup-attempt
history.

Reson8 and Connector are implemented sources. Codemode and terminal commands use the same contracts,
runtime, and permissions. Reson8 execution is exposed only through `integrations.*`; its former
standalone tool family and runtime have been removed. Connector's existing native tools remain
available. Both retain their underlying Fragments, Durable Objects, native permissions, ownership,
and configuration controls.

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

Future sources can own `api#<connection-slug>` and `mcp#<server-slug>`. If native identity is only
unique within another source instance, its local address must include that qualifier losslessly.
Those sources are not implemented by merely reserving their prefixes; unknown addresses fail closed.

### Connector addresses

Connector is registered only in user scope. Its namespace contains compact, reversible base64url
encodings of source selectors, not encoded setup state:

- `connector#a_<token>` selects one saved native account by its account ID. Listing publishes these
  addresses so duplicate names and historical null names never collapse or disappear.
- `connector#n_<token>` selects the exact project ID, provider configuration ID, and connection
  name. This address works before OAuth assigns an account ID and resumes through the Fragment's
  named lookups. A name matching multiple accounts fails explicitly.

Copy opaque addresses from discovery and listing; do not base64-encode the old JSON array. The
canonical encoder in `connector-connection-id.ts` packs lowercase canonical UUIDs into 16 bytes and
preserves every other component as a UTF-8 JSON string. A flags byte identifies packed UUIDs; JSON
strings are NUL-terminated, since JSON escapes embedded NUL and lone UTF-16 surrogates. The entire
payload uses unpadded base64url. An account UUID produces a 35-character address; two UUID selectors
and the name `backoffice` produce a 74-character named address.

Whitespace, case, quotes, Unicode, and additional `#` characters inside source components remain
unchanged; uppercase UUID spellings use the lossless string representation, not normalization.
Malformed and noncanonical encodings, including padding, fail closed. Old JSON-array addresses are
not aliases. Tokens are reversible, not encrypted, and introduce no lookup or alias store. Neither
form contains a user selector: the established execution scope owns every read. The same address in
another user's scope selects that user's source, not the original user's data.

Discovery groups provider configurations by their authoritative service IDs, such as `gmail`, rather
than publishing `connector` as a service. It offers a preassigned `backoffice` name for each
provider as a concrete setup target. This is a source alias, not a reservation, generated account
ID, or facade-owned binding. Advanced callers can select another exact name. Configured listing uses
account-ID addresses; a named address remains an independently usable selector when unambiguous.

The native source currently exposes account metadata through cursor pages, not a by-ID metadata
endpoint. Account-ID resolution reads those pages sequentially until the account is found, retaining
only one page at a time. Listing always forwards exactly one native page and its cursor.

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

Connector named setup first reads the exact account and saved request. An unconfigured name returns
`needs-input` with the source-owned schema `{ start: true }` and no secret fields. Explicit input
starts the existing native OAuth route with a server-selected return URL. Serial repeat submissions
reuse the saved pending request instead of starting another one. Checks of an existing pending
request call native refresh: they may persist gateway-confirmed consent in the Fragment, but never
start consent, trust caller confirmation, execute a provider action, or write facade state.

Saved `failed` and `expired` requests remain terminal. The facade does not create a replacement that
would make future named lookup ambiguous. Use a fresh exact name for another attempt, or use the
native request-ID tools for retained history. Multiple matching requests or accounts return
`blocked` during setup; ordinary named resolution fails rather than guessing a current record. A
single confirmed account makes its name ready even when request history is ambiguous. A retained
connected request without a current matching account is blocked: native reauthorization may have
moved that same account ID to another name, and historical consent cannot make the old selector
ready.

Concurrent starts can still create multiple remote links and saved requests: alias is not an
idempotency key, and no lock, cleanup, or exactly-once promise is introduced. A lost upstream
response or unsuccessful local save is not claimed to be recoverable by name. Account-ID setup
reports ready only for an existing locally confirmed account; it cannot invent a pre-authorization
account ID.

A future source without preassignable names or another authoritative pre-authorization identity
needs an explicit interface decision. Do not invent an account ID, encode private continuation state
in a public token, or add an integrations-owned attempt store to fit it into named setup.

## Implementation boundary

- `integration-contracts.ts`: canonical public schemas and inferred types.
- `integration-tools.ts`: the seven tools, Bash adapters, and scope-bound runtime contract.
- `integration-implementation.ts`: connection ID claims, explicit setup capability, and resolved
  request-local connection operations. No binding/setup generics or shared private state schemas.
- `integration-registry.ts`: claim ownership, source dispatch, and composite cursor pagination.
- `integrations-runtime.ts`: production source assembly and public operation dispatch.
- `reson8-integration.ts`: existing organization configuration, authorized Fragno routes, and action
  validation, with injected provider fetch for scenarios.
- `connector-connection-id.ts`: canonical, lossless base64url encoding of native Connector
  selectors.
- `connector-integration.ts`: user-owned native requests/accounts, source-qualified addresses,
  provider allowlists, authoritative catalog validation, and read-only profile evidence.

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

Connector acquires only this provider configuration's allowed catalog actions. Input must satisfy
both the native object's transport shape and the published input schema. Input contracts must
explicitly declare an object root; unsupported transport shapes fail discovery instead of
advertising an unusable action. Execution returns the validated provider payload, not the native
execution-ID envelope, so its shape matches the published output schema exactly. Output failure
happens after the action has run and must not trigger a retry.

Catalog schemas without an explicit dialect use JSON Schema 2020-12. Incompatible explicit dialects,
unresolved references, and unsupported dynamic-reference/vocabulary semantics fail before actions
are published. Self-contained ordinary references are supported; no remote schema fetch or inferred
output contract is introduced.

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

In a user-scoped provider, select a discovered service target and explicitly start consent:

```ts
const services = await integrations.discover();
const target = services.find((service) => service.id === "gmail")?.setupTargets[0];
if (!target) throw new Error("No Gmail setup target is available.");
let setup = await integrations.setup({ kind: "check", connectionId: target.connectionId });
if (setup.status === "needs-input") {
  setup = await integrations.setup({
    kind: "input",
    connectionId: target.connectionId,
    input: { start: true },
  });
}
// If needs-authorization, complete browser consent. A later invocation checks the same scoped ID.
if (setup.status === "needs-authorization") return setup;
if (setup.status !== "ready") throw new Error("Gmail setup is not ready.");
return await integrations.execute({
  connectionId: target.connectionId,
  actionId: "gmail.search_threads",
  input: { query: "is:unread" },
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

In a user scope, first discover and copy the real project/provider target. The illustrative token
below encodes `project-1`, `gmail-provider`, and `backoffice`; replace it with the discovered
target. Each submission is independent:

```sh
integrations.discover --json
integrations.setup --connection-id 'connector#n_ACJwcm9qZWN0LTEiACJnbWFpbC1wcm92aWRlciIAImJhY2tvZmZpY2UiAA' --json
integrations.setup --connection-id 'connector#n_ACJwcm9qZWN0LTEiACJnbWFpbC1wcm92aWRlciIAImJhY2tvZmZpY2UiAA' \
  --input-json '{"start":true}' --json

# Complete browser consent, then check the same source-backed address.
integrations.setup --connection-id 'connector#n_ACJwcm9qZWN0LTEiACJnbWFpbC1wcm92aWRlciIAImJhY2tvZmZpY2UiAA' --json
integrations.execute --connection-id 'connector#n_ACJwcm9qZWN0LTEiACJnbWFpbC1wcm92aWRlciIAImJhY2tvZmZpY2UiAA' \
  --action-id gmail.search_threads --input-json '{"query":"is:unread"}' --json
```

## Authority and evidence

Umbrella `integrations.read`, `.manage`, and `.execute` apply at the tool boundary. Setup and
verification require manage. They neither replace native permissions nor broaden role grants. For
Reson8, configuration inspection/setup reads require `connections.read`; submitted keys require
`connections.manage`; transcription and live checks require `reson8.use`.

Connector discovery and action contracts require `connector.providers.read`. Listing, source-account
selection, and profile checks require `connector.accounts.read`. Named request lookup, OAuth start,
and refresh require `connector.connections.create`; invocation additionally requires
`connector.actions.execute`. Source-account metadata is necessary to bind the provider contract, so
Connector execution needs account-read and provider-read authority as well as action execution. It
does not call `inspect`, verify a profile, or acquire `connections.read` before invoking an action.
Both caller and receiving-object checks use the original execution authority; no roles gain grants.

Reson8 verify performs a read-only custom-model listing. It neither transcribes, mints tokens,
persists health, nor publishes provider credential echoes. A subsequent get remains `not-checked`.
Receiving-object authorization denials, including unavailable authority resolution, propagate as
execution errors rather than failed provider checks. Provider HTTP errors still return sanitized
check evidence.

Connector verify performs a read-only provider profile request. Success proves that request, not
message access, action scopes, or provider-wide health. Evidence is timestamped and sanitized;
profile data and server credentials are not included, and subsequent inspection remains not-checked.
Receiving-object denials remain execution errors, including when authority is revoked after
resolution.

Concrete scenarios use real temporary SQLite, runtime/kernel authority, registered Codemode and Bash
tools, object restarts, authorized object HTTP, and real route handlers. External transport is an
injected fetch for Reson8 and a stateful local HTTP gateway for Connector. Scenarios cover claim
conflicts, deterministic and exact addressing, both permission layers, owner isolation, setup
without handles, retained OAuth history, ambiguity, source pagination, binary/query transport, live
contracts, output failures without retries, and sanitized verification evidence.
