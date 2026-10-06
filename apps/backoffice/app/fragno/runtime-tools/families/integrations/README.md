# Integration implementation sketch

This directory contains the public integration contracts and the private implementation interface.
It does **not** implement an integration registry, setup persistence, action dispatch, or service
backends. The tool family is not registered in `runtimeToolFamilies`, so it is unavailable and its
provider declaration is intentionally not generated.

## Files

- `integration-contracts.ts`: canonical public schemas and their inferred domain types.
- `integration-tools.ts`: unregistered tool-family sketch and the scope-bound `IntegrationsRuntime`
  contract.
- `integration-implementation.ts`: interface for one service, private setup steps, and executable
  action definitions.

Once a production `IntegrationsRuntime` exists, register `integrationsToolFamily` in
`runtimeToolFamilies` and run `pnpm --filter @fragno-apps/backoffice-rr run static:generate`. That
will restore `content/static/codemode/providers/integrations.d.ts` from the canonical contracts; do
not maintain a handwritten copy.

## One service, any mechanism

The proposed boundary is:

```text
Public integrations tools
          |
Scope-bound IntegrationsRuntime
          |
IntegrationImplementation<SetupState, Binding>
          |
Private native / HTTP / MCP / Connector collaborators
```

An implementation represents a service definition, not an entire mechanism. A Connector-backed
factory could produce separate Slack and Gmail implementations. An HTTP-backed implementation needs
real action contracts; an endpoint URL alone cannot supply them.

`describe` supplies a service identity, description, scoped connection cardinality, availability,
and declared events. The runtime aggregates those descriptions for `discover`; it does not ask
callers to choose a backend. Service clients, storage, and other concrete collaborators belong in
implementation assembly rather than a catch-all dependency bag on `IntegrationContext`.

## Ownership

| Runtime responsibility                               | Implementation responsibility                               |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Aggregate discovery and paginate configured bindings | Describe one service in the selected scope                  |
| Own public references and enforce their owner scope  | Interpret private binding identity                          |
| Own setup IDs and retain setup progress              | Interpret private continuation state and setup requirements |
| Enforce umbrella permissions                         | Enforce service- and action-specific permissions            |
| Attach public identity and name to inspection        | Supply configuration, authorization, and check evidence     |
| Select the action and publish only its definition    | Validate and invoke the service operation                   |
| Disable a disconnected public reference              | Release resources owned only by that binding                |

A caller-supplied scope is not evidence of ownership. The runtime resolves binding and setup handles
within the selected execution scope before invoking an implementation. Its ownership check and the
implementation's service permissions are both required.

## Private typed state

`SetupState` is the private value needed to continue a setup attempt. `Binding` is the private value
needed to inspect and use an established connection. Neither appears in public setup progress,
references, or inspection output.

Illustrative private identities, not backend implementations:

| Implementation              | Possible setup state                   | Possible binding                      |
| --------------------------- | -------------------------------------- | ------------------------------------- |
| Native API-key service      | Current requested-input stage          | Scoped configuration locator          |
| OAuth-connected service     | Pending authorization-request locator  | Confirmed connected-account locator   |
| HTTP-backed service         | Registration and consent locators      | Registered connection locator         |
| MCP-backed service          | Registration and consent locators      | Registered server locator             |
| Environment-managed service | Administrator intervention requirement | Scoped access to shared configuration |

The implementation supplies `setupStateSchema` and `bindingSchema` so retained private data can earn
trust at the runtime's loading boundary. Domain methods then receive concrete typed values, not
`unknown`. These schemas do not prescribe a storage backend or serialization protocol. Private state
should reference credential storage rather than copy secrets into publicly visible attempt data.

## Setup progression

`IntegrationSetupStep` derives its user-facing requirements from the canonical
`IntegrationSetupProgress` type. It replaces runtime-owned handles with private values:

- `needs-input`, `needs-authorization`, and `pending` carry a typed `state`.
- `ready` carries a typed `binding`, not a public reference.
- `blocked` and `expired` are terminal results with a reason and no continuation state.

The proposed runtime sequence for `connect` is:

1. Resolve the selected service implementation and authorize setup in the selected scope.
2. Apply the implementation's declared `connectionCardinality`. For a singleton, reuse the existing
   binding or nonterminal attempt; otherwise atomically reserve a new slot before service side
   effects.
3. Only for a new slot, call its `connect` operation with the proposed name.
4. Retain the attempt's service, owner, name, progress, and private continuation state.
5. If ready, retain the private binding behind a public reference.
6. Return only public progress with the runtime-owned setup ID.

For `continueSetup`, resolve and authorize the retained attempt first. A nonterminal attempt
supplies its validated private state to the implementation; the caller supplies only `input` or
`check`. The implementation accepts input only for the current requirement and checks authoritative
external state when appropriate. An input submission can return another requirement instead of
completing.

Repeated continuation of a ready attempt returns its existing reference, not a new binding. Terminal
blocked or expired attempts return their retained result without calling the implementation again. A
new setup attempt is explicit; continuation never silently restarts consent.

The runtime owns retention, ownership checks, and public projection. The implementation owns the
service-specific transition. Transaction boundaries, concurrency handling, and secret storage remain
backend work; this sketch does not add a second durable workflow engine.

## Singleton configuration semantics

`connectionCardinality` is service metadata, not a native/HTTP/MCP/Connector selector:

- `singleton`: at most one active binding or nonterminal setup attempt per integration ID and owner
  scope. Repeated `connect` returns the existing ready progress/reference or the current setup
  progress, retaining its setup ID and name. It does not call the implementation again, restart
  consent, rename the connection, or replace credentials. Concurrent connects must converge on the
  same slot before either can start service side effects.
- `multiple`: each explicit `connect` starts an independent setup; the name is a display label, not
  an idempotency key or credential-store identity.

Existing native singleton configuration stays in its current scope-owned store. A binding contains
its locator, not an independently named copy of credentials. Shared environment/application
configuration remains owned by its existing store as well; bindings never become its owners.

Singleton `disconnect` disables the reference and frees its slot, but does not clear the underlying
configuration or revoke access through legacy service tools. Reconnecting creates a new reference
and may reuse that configuration. Credential replacement or deletion is not an implicit side effect
of naming, reconnecting, or disconnecting; any setup operation that explicitly changes shared
configuration requires its existing configuration-owner permissions. Blocked/expired attempts remain
terminal; a new explicit connect can reserve a new attempt once there is no active binding/setup.

These are interface requirements for the deferred runtime, not implemented uniqueness or storage.

## Actions are executable definitions

`IntegrationActionImplementation` couples a public `definition` with a private `invoke` boundary.
The public definition contains its ID, label, description, and authoritative input/output schemas.
The invocation handler captures the selected private binding.

The proposed runtime behavior is:

- `actions`: resolve the binding and return the action definitions, never their handlers.
- `execute`: resolve the binding, find the exact action, and invoke it with current execution
  authority.

There is no separate implementation-level `execute(actionId)` dispatcher to keep aligned with the
catalog. The contract and input/output validation must come from the same authoritative source;
adapters must not publish guessed schemas or generic empty schemas for unknown operations.

`invoke` is the boundary for untrusted action input and service responses. It establishes the live
contract and action-specific authorization before side effects, then delegates to typed domain
operations. An umbrella `integrations.execute` grant is not blanket permission to use a service.

Results retain the operation's own semantics. A transcription action can return a job handle; a
profile action can return a profile. The interface does not force every result into one synchronous
payload or a universal asynchronous-job abstraction. Existing service-specific tools remain intact
until their eventual migration to actions.

## Action value representation

Action input and output use the existing canonical `JsonValue` type/schema: null, booleans, finite
numbers, strings, arrays, and string-keyed objects containing only those values. The generated tool
boundary validates that representation; `invoke(context, input: JsonValue): Promise<JsonValue>`
still owns validation against the selected action's authoritative schema before service side
effects.

Native `ArrayBuffer`, typed arrays, Blob, Date, functions, bigint, and undefined are not action
values. Binary fields use ordinary arrays of integer bytes (0–255), declared at the field's location
in the action's input/output JSON Schema. The implementation converts validated bytes to the native
buffer its client expects and encodes native results back to the published JSON shape. This does not
wrap every action in a binary envelope or invent a file-reference resolution protocol. An action
with no result payload returns `null` and publishes a null output schema, not `undefined`.

For example, a future transcription action can publish an `audio.bytes` array whose items schema is
`{ "type": "integer", "minimum": 0, "maximum": 255 }`, then privately pass the bytes to Reson8. The
existing Reson8 tool's buffer-accepting interface is unchanged; it cannot simply be exposed as a
JSON Schema integration action without this conversion.

## Inspection, verification, and disconnect

`inspect` reads saved state and existing evidence. `verify` performs supported checks and returns
fresh evidence; it does not start consent or execute a service action. Credentials being present do
not prove live access, and declared events do not prove delivery.

`disconnect` ends access through this scoped binding. Its implementation releases only binding-owned
resources; it must not remove shared application credentials, erase external data, or imply
provider-wide token revocation. The runtime disables the public reference independently of any
provider-specific cleanup.
