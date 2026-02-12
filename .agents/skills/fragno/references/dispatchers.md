# Dispatchers (Durable Hooks)

## Summary

Dispatchers run durable hooks in the background so retries and scheduled work happen even when no
requests are arriving. Any fragment that defines durable hooks (for example, Workflows) needs a
dispatcher in production.

## When to use

- The fragment uses durable hooks (`uow.triggerHook` in its services).
- You need retries or scheduled hooks to run without user traffic.

## Docs (curl)

User docs page:

- `curl -L "https://fragno.dev/docs/fragno/for-users/dispatchers" -H "accept: text/markdown"`

Search:

- `curl -s "https://fragno.dev/api/search?query=durable%20hooks%20dispatcher"`

## Key facts from the code

- `createDurableHooksProcessor(fragment)` returns `null` if the fragment has no durable hooks.
- The processor claims pending events in the DB to avoid double-processing.
- Dispatchers only run when `getNextWakeAt()` is due.
- Failed hooks retry with exponential backoff.
- Stuck `processing` hooks are re-queued after 10 minutes by default.

## Node dispatcher (polling)

```ts
import { createDurableHooksProcessor } from "@fragno-dev/db";
import { createDurableHooksDispatcher } from "@fragno-dev/db/dispatchers/node";

const processor = createDurableHooksProcessor(fragment);
if (processor) {
  const dispatcher = createDurableHooksDispatcher({
    processor,
    pollIntervalMs: 2000,
  });

  dispatcher.startPolling();
  process.on("SIGTERM", () => dispatcher.stopPolling());
}
```

## Cloudflare Durable Objects (alarms)

```ts
import { DurableObject } from "cloudflare:workers";
import { createDurableHooksProcessor } from "@fragno-dev/db";
import { createDurableHooksDispatcherDurableObject } from "@fragno-dev/db/dispatchers/cloudflare-do";
import { migrate } from "@fragno-dev/db";
import { createMyFragmentServer, type MyFragment } from "@/fragno/my-fragment";

export class MyFragmentDO extends DurableObject<Env> {
  fragment: MyFragment;
  handler: ReturnType<ReturnType<typeof createDurableHooksDispatcherDurableObject>>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.fragment = createMyFragmentServer({ env, state, type: "live" });
    state.blockConcurrencyWhile(async () => {
      await migrate(this.fragment);
    });

    // Keep the dispatcher in the same DO instance that owns the fragment.
    const processor = createDurableHooksProcessor(this.fragment);
    if (!processor) {
      throw new Error("Fragment has no durable hooks configured.");
    }

    this.handler = createDurableHooksDispatcherDurableObject({
      createProcessor: () => processor,
    })(state, env);
  }

  alarm() {
    return this.handler.alarm?.();
  }
}
```

Note: For Durable Objects, keep the dispatcher in the same DO instance that owns the fragment so it
shares the same storage and scheduling lifecycle.

## Configuring stuck hook recovery

```ts
const fragment = instantiate(fragmentDef)
  .withConfig(config)
  .withOptions({
    databaseAdapter,
    durableHooks: {
      stuckProcessingTimeoutMinutes: 10,
      onStuckProcessingHooks: ({ namespace, timeoutMinutes, events }) => {
        console.warn("Re-queued stuck hooks", namespace, timeoutMinutes, events.length);
      },
    },
  })
  .build();
```

## Common pitfalls

- Not starting the dispatcher in production.
- Running a dispatcher when `createDurableHooksProcessor` returns `null`.
- Forgetting to stop polling on shutdown.
- Non-idempotent hook handlers causing duplicate side effects.
