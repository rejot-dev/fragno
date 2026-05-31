# Durable Object cleanup notes

Use these patterns when cleaning up other `*.do.ts` files.

## Runtime lifecycle

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

## Config and validation

- Replace hand-written payload parsing with local Zod schemas.
- Inline simple schema pieces; avoid tiny schema helper functions unless they are reused several
  times across files.
- Use direct `.parse(...)` / `.safeParse(...)` at the callsite instead of generic wrappers like
  `parseSchema(...)`.
- Avoid deprecated Zod APIs such as `.passthrough()` and `.finite()`.
- Prefer `z.string().trim().min(1, "message")` for required strings.
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

## Hook behavior

- Do not manually call dispatcher `notify(...)` after direct fragment calls when using the hosted
  fragment from `createFragmentDurableObjectHost(...)`.
- Let the shared host wrap direct fragment calls and handle durable hook notification internally.
