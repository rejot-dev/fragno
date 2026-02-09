# Durable Hooks - distilled

Source: Fragno Docs — Durable Hooks

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/durable-hooks" -H "accept: text/markdown"`

## Purpose

- Persist side effects in the same transaction and execute them after commit.
- Failed hooks are retried with exponential backoff; implementations must be idempotent.

## Defining hooks

- Define hooks on the fragment definition with `provideHooks` + `defineHook`.
- Use `function` syntax so `this` is available (includes `this.idempotencyKey`).

## Triggering hooks

- Use `uow.triggerHook("hookName", payload)` inside the mutation phase.
- The trigger is part of the transaction; if the transaction rolls back, the hook does not run.

## Scheduling

- Pass `processAt` to delay the first execution attempt.

## Dispatchers

- Run a background dispatcher so hooks execute even without new requests.
- Node polling dispatcher and Cloudflare Durable Objects dispatcher are supported.

## Stuck processing recovery

- Hooks stuck in `processing` are re-queued after a timeout (configurable).
- You can disable this behavior; keep handlers idempotent to allow retries.
