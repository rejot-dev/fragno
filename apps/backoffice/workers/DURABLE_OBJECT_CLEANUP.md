# Durable Object cleanup notes

Use these patterns when cleaning up other `*.do.ts` files.

## Phase 1: generic Fragno Durable Object host

Use this when a Durable Object hosts Fragno fragments but is not yet using the backoffice runtime
controller.

### Runtime lifecycle

- Use `createFragmentDurableObjectHost(...)` for Fragno fragments instead of local `migrate(...)`,
  dispatcher creation, alarm state, and manual hook notification.
- Keep the Durable Object responsible for lifecycle boundaries:
  - call `this.#host.initialize(...)` inside `state.blockConcurrencyWhile(...)`
  - store the returned runtime on the DO instance
  - forward `alarm()` with `await this.#host.alarm()`
- Prefer an explicit runtime union:

```ts
type Runtime =
  | { configured: false }
  | { configured: true; stored: StoredConfig; config: FragmentConfig; fragment: Fragment };
```

- Avoid lazy `#ensureFragment()` methods that mix config loading, runtime creation, migration,
  dispatcher setup, and cache invalidation.
- Add small accessors for configured runtime:
  - `#getConfiguredRuntime()` for nullable flows
  - `#getConfiguredRuntimeOrThrow()` for RPC methods that require configuration

### Hook behavior

- Do not manually call dispatcher `notify(...)` after direct fragment calls when using the hosted
  fragment from `createFragmentDurableObjectHost(...)`.
- Let the shared host wrap direct fragment calls and handle durable hook notification internally.

## Phase 2: backoffice fragment Durable Object controller

Use `workers/lib/backoffice-fragment-durable-object.ts` for backoffice DOs that are config-backed,
org-bound, and host Fragno fragments.

This helper should replace the repeated local implementation of:

- storage-backed config loading
- configured/unconfigured runtime state
- runtime source derivation and fingerprint reuse
- migration/runtime initialization through `createFragmentDurableObjectHost(...)`
- durable-hook alarm forwarding
- durable-hook queue inspection
- fetch proxying through hosted fragments/mounts
- standard backoffice org-id binding checks
- standard `NOT_CONFIGURED` and `ORG_ID_MISMATCH` responses

### Org-based DO migration checklist

Track every org-scoped Durable Object here. The primary migration target is
`createBackofficeFragmentDurableObject(...)` when the DO hosts Fragno fragments. For org-scoped DOs
that are not a fit for the helper, still apply the broader cleanup rules: explicit constructor
initialization, no lazy lifecycle setup, standard org-id validation, direct `Response.json(...)`,
and small domain-only methods.

- [x] `telegram.do.ts` — migrated to `createBackofficeFragmentDurableObject(...)`.
- [x] `pi.do.ts` — migrated to `createBackofficeFragmentDurableObject(...)`.
- [ ] `automations.do.ts` — org-scoped multi-fragment runtime; migrate lifecycle/hooks/alarm/fetch
      plumbing to the shared host/helper where possible.
- [ ] `cloudflare-wfp.do.ts` — org-bound Cloudflare fragment; replace local config/org/migration/
      dispatcher/fetch plumbing.
- [ ] `otp.do.ts` — org-scoped OTP fragment; replace lazy fragment/dispatcher setup and hook queue
      boilerplate.
- [ ] `resend.do.ts` — org-bound Resend fragment; add/preserve stored `orgId`, then move config,
      migration, hook queue, alarm, and fetch plumbing to the helper.
- [ ] `reson8.do.ts` — org-scoped config-backed fragment; add/preserve stored `orgId` if needed and
      remove local config/runtime/fetch boilerplate.
- [ ] `upload.do.ts` — org-bound multi-provider upload fragments; migrate provider runtime caching,
      migration, hook queue, alarm, and fetch plumbing to shared conventions.
- [ ] `github.do.ts` — org-scoped GitHub fragment, keyed by org id; replace local runtime/config
      caching and fetch/not-configured plumbing where possible.

Do not include singleton DOs in this checklist, such as `auth.do.ts` or
`github-webhook-router.do.ts`. Also exclude non-fragment sandbox DOs: `sandbox-registry.do.ts` is
org-scoped but only tracks sandbox ids, and `sandbox.do.ts` is keyed by sandbox id rather than org
id.

### Constructor pattern

Create the controller in the DO constructor and keep the `blockConcurrencyWhile(...)` call in the
constructor, not hidden behind a helper method:

```ts
this.#host = createBackofficeFragmentDurableObject({
  name: "Telegram",
  state,
  env,
  toSource: (stored) => ({
    botToken: stored.botToken,
    webhookSecretToken: stored.webhookSecretToken,
    botUsername: stored.botUsername,
    apiBaseUrl: stored.apiBaseUrl,
  }),
  createRuntime: (config) => createTelegramServer(config, state),
});

void state.blockConcurrencyWhile(async () => {
  await this.#host.initializeFromStored(await this.#host.loadStored());
});
```

The constructor should make the lifecycle obvious:

1. create the backoffice fragment host
2. initialize it from stored config inside `blockConcurrencyWhile(...)`

Do not add a `boot()` wrapper around that call.

### Options should stay small

The helper is intentionally convention-heavy. Do not reintroduce options for behavior that every
backoffice fragment DO should share.

Current shared conventions:

- config storage key defaults to `${name.toLowerCase()}-config`
- org binding is always enabled
- stored config must expose a string `orgId` when configured
- fetch org mismatch compares `stored.orgId` with request `?orgId=`
- unconfigured fetch responses use standard `NOT_CONFIGURED` JSON
- org mismatches use standard `409 ORG_ID_MISMATCH` JSON
- `requireConfigured()` defaults to `${name} is unavailable.`

Only provide options for behavior that truly varies by fragment, such as:

- `parseStored` for validating corrupt persisted config
- `isConfigured` for partial config states
- `toSource` when runtime input is narrower than stored config
- `fingerprint` when runtime reuse should ignore storage-only fields
- `createRuntime`
- `getMigrationFragments`, `hostRuntime`, and `mounts` for multi-fragment runtimes

### Stored config vs source vs runtime

Use the shared terminology consistently:

- `stored`: the full config record persisted in DO storage. It may contain admin/UI fields like
  timestamps, webhook URLs, masked-secret metadata, or incomplete setup state.
- `source`: the subset/shape derived from `stored` that actually affects runtime construction and
  migration. If a stored field should not rebuild the fragment, keep it out of `source` or the
  fingerprint.
- `runtime`: the migrated hosted fragment or multi-fragment runtime returned by `createRuntime`.

For example, Telegram stores `webhookBaseUrl`, `createdAt`, and `updatedAt`, but these do not affect
fragment construction. Its source only includes the bot/API values used by the Telegram fragment.

### Clean up `.do.ts` files aggressively

When moving a DO to `createBackofficeFragmentDurableObject(...)`, remove local code that just
mirrors the helper:

- local runtime union types
- local `#runtime` fields
- local `#loadConfig()` wrappers around `this.#host.loadStored()`
- local `#getStoredOrgId()` helpers; use `this.#host.getStoredOrgId(...)`
- local org mismatch helpers and responses
- local not-configured fetch responses
- local `getHookQueue` empty-state responses
- local fetch proxying through fragment handlers/mounts
- local migration failure state management

Keep only domain-specific DO methods and callbacks, such as Telegram webhook registration, Telegram
file download, Pi session filesystem setup, or Pi harness/API-key normalization.

### Admin config updates

Admin config methods should generally follow this shape:

```ts
const parsed = inputSchema.parse(payload);
const existing = await this.#host.loadStored();
this.#host.assertSameOrg(existing, parsed.orgId);

const stored = buildStoredConfig(parsed, existing);
await this.#host.storeAndInitialize(stored);

return buildConfigState(stored);
```

`assertSameOrg(...)` handles the standard backoffice tenant-binding invariant. Do not duplicate this
logic in each DO.

### Fetch, alarms, and hook queues

Forward these directly unless the DO has domain-specific behavior to add:

```ts
async alarm() {
  await this.#host.alarm();
}

async fetch(request: Request): Promise<Response> {
  return await this.#host.fetch(request);
}

async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
  return await this.#host.getHookQueue(options, ({ runtime }) => runtime);
}
```

For multi-fragment runtimes, select the target queue fragment at the callsite:

```ts
return await this.#host.getHookQueue(parsedOptions, ({ runtime }, queueOptions) =>
  queueOptions?.fragment === "workflows" ? runtime.workflowsFragment : runtime.piFragment,
);
```

## Config and validation

- Replace hand-written payload parsing with local Zod schemas.
- Inline simple schema pieces; avoid tiny schema helper functions unless they are reused several
  times across files.
- Use direct `.parse(...)` / `.safeParse(...)` at the callsite instead of generic wrappers like
  `parseSchema(...)`.
- Avoid deprecated Zod APIs such as `.passthrough()` and `.finite()`.
- Prefer `z.string().trim().min(1, { error: "message" })` for required strings.
- Use schema transforms for normalization such as empty optional strings to `undefined`.

## Stored config invariants

- Treat persisted config shape problems as corrupt state, not as “not configured”.
- If a stored required identifier is missing, throw loudly during initialization.
- Keep nullable handling only for legitimate unconfigured state.

## Responses and RPC methods

- Use `Response.json(payload, { status })` instead of custom JSON response helpers.
- Validate public/RPC method inputs at the method boundary with a schema.
- Keep non-throwing behavior only where the caller expects it, such as admin status or queue
  inspection.
