# Rules of Workflows

> Fragno Workflows is based in part on Cloudflare Workflows. This guide adapts Cloudflare's
> [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) to
> Fragno's API, database-backed runner, and tested replay behavior.

A workflow may run from the beginning many times. Each runner tick invokes the workflow callback
again, while completed steps normally return their persisted results without rerunning their
callbacks. A full restart discards every checkpoint. Retrying a failed top-level step discards and
reruns all nested checkpoints beneath that step, including completed ones. Sleeps, event waits,
retries, process restarts, and concurrent ticks can all create another passage through the workflow
function.

These rules keep those passages deterministic and make step attempts safe to repeat.

## Make external calls idempotent

A `step.do` callback is replay-safe only after its successful result and the runner's database
changes commit. Before that boundary, an error, retry, or competing tick can run the callback again.
External systems are not part of that database transaction.

Use an idempotency key whenever an API supports one. A workflow instance ID plus a stable operation
name usually makes a good key:

```ts
import { defineWorkflow } from "@fragno-dev/workflows/workflow";

export const ChargeSubscriptionWorkflow = defineWorkflow<
  "charge-subscription",
  { customerId: string; amount: number },
  { charged: true }
>({ name: "charge-subscription" }, async (event, step) => {
  await step.do(
    "charge monthly subscription",
    { retries: { limit: 3, delay: "5 s", backoff: "exponential" } },
    async () => {
      await payments.charge({
        customerId: event.payload.customerId,
        amount: event.payload.amount,
        idempotencyKey: `${event.instanceId}:monthly-charge`,
      });
    },
  );

  return { charged: true };
});
```

A check-before-write can help, but it is not a substitute for an atomic idempotency key when the
remote service can accept the request and lose the response.

For Fragno database work, prefer `tx.mutate`, mutate-only `tx.serviceCalls`, or
`tx.workflowServiceCalls`. Those operations are buffered and commit atomically with the successful
step boundary. They are not applied during normal replay of a completed step. A full restart or a
failed-step retry that discards the step's checkpoint can run and commit them again.

## Keep steps granular

Treat each step as a retryable unit of work. Separate unrelated services so a failure in one does
not repeat successful work against another:

```ts
const customer = await step.do("load customer", async () => {
  return await customers.get(event.payload.customerId);
});

const invoice = await step.do("create invoice", async () => {
  return await billing.createInvoice({
    customerId: customer.id,
    idempotencyKey: `${event.instanceId}:invoice`,
  });
});

await step.do(
  "send invoice email",
  { retries: { limit: 5, delay: "10 s", backoff: "exponential" } },
  async () => {
    await email.sendInvoice({
      invoiceId: invoice.id,
      idempotencyKey: `${event.instanceId}:invoice-email`,
    });
  },
);
```

Avoid putting the entire workflow in one step. Long, CPU-heavy callbacks and steps containing many
unrelated external calls discard more work when an attempt has to restart.

## Mark permanent failures as non-retryable

A normal error follows the `step.do` retry policy. Throw `NonRetryableError` when another attempt
cannot succeed without different input or an external state change:

```ts
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";

export const ChargeOrderWorkflow = defineWorkflow({ name: "charge-order" }, async (event, step) => {
  await step.do(
    "charge order",
    { retries: { limit: 3, delay: "10 s", backoff: "exponential" } },
    async () => {
      const result = await payments.charge({
        orderId: event.payload.orderId,
        idempotencyKey: `${event.instanceId}:charge-order`,
      });

      if (result.status === "declined") {
        throw new NonRetryableError("PAYMENT_DECLINED");
      }

      return result.receiptId;
    },
  );
});
```

`NonRetryableError` bypasses the configured retry schedule, marks the step as terminally errored on
its current attempt, and commits work registered with `tx.onTerminalError.mutate`. If the error
escapes the workflow callback, the instance becomes `errored`.

Use it for permanent domain failures such as invalid input, authorization rejection, or a final
provider response. Keep transient network errors, rate limits, and temporary service failures as
ordinary errors so the configured retry policy can handle them.

`WaitForEventTimeoutError` extends `NonRetryableError`. A timed-out `step.waitForEvent` therefore
fails as a terminal error unless the workflow catches and handles it.

## Rebuild state from step results

Local variables are not durable. The workflow callback starts again after a sleep, event wait,
retry, or runner restart. A completed `step.do` returns its stored result, but its callback does not
run again to reproduce mutations to surrounding variables.

```ts
// 🔴 Bad: pushes happen only when each callback executes.
const imageIds: string[] = [];

await step.do("load first image", async () => {
  imageIds.push(await images.getFeaturedId(0));
});

await step.do("load second image", async () => {
  imageIds.push(await images.getFeaturedId(1));
});

await step.sleep("wait before processing", "3 hours");

// `imageIds` can be empty after replay because the completed callbacks are skipped.
await step.do("process images", async () => processImages(imageIds));
```

Build durable state from step return values instead:

```ts
const firstImageId = await step.do("load first image", async () => {
  return await images.getFeaturedId(0);
});

const secondImageId = await step.do("load second image", async () => {
  return await images.getFeaturedId(1);
});

await step.sleep("wait before processing", "3 hours");

await step.do("process images", async () => {
  return await processImages([firstImageId, secondImageId]);
});
```

Persist larger or independently queried state in your own database schema and return a stable
reference from the step.

## Keep side effects inside steps

Code outside a step runs on every passage through the workflow function. Do not create records, send
messages, call external services, or choose random values there.

```ts
export const ReportWorkflow = defineWorkflow({ name: "report" }, async (event, step) => {
  // 🔴 These can happen again on the next runner tick.
  console.log("starting report", event.instanceId);
  const randomBucket = Math.floor(Math.random() * 10);

  // ✅ The selected value is persisted as the step result.
  const bucket = await step.do("choose report bucket", async () => {
    return Math.floor(Math.random() * 10);
  });

  return await step.do("generate report", async () => {
    return await generateReport({ bucket });
  });
});
```

Putting a side effect inside `step.do` prevents it from running after that step has durably
completed. It does **not** make an external side effect exactly-once: failed attempts can still
repeat. Keep external calls idempotent.

To create another workflow instance atomically with step completion, queue a workflow operation:

```ts
await step.do("create delivery workflow", async (tx) => {
  tx.workflowServiceCalls(() => [
    {
      type: "createInstance",
      workflowName: "deliver-order",
      instanceId: `${event.instanceId}:delivery`,
      params: { orderId: event.payload.orderId },
    },
  ]);
});
```

## Treat workflow input as immutable

`event.payload` is typed as readonly. The runner rebuilds it from the persisted instance params on
each tick. Mutating the object may affect later code during the same passage, then disappear when
the workflow runs again.

```ts
// 🔴 Bad: this is transient in-memory mutation.
event.payload.customerId = "another-customer";

// ✅ Return new state from a step.
const customer = await step.do("load customer", async () => {
  return await customers.get(event.payload.customerId);
});

await step.do("process customer", async () => {
  return await processCustomer(customer);
});
```

When input must change, store the new value in a step result or in your own database model. Workflow
instance params remain the original creation input.

## Name steps deterministically

Step identity is built from the step type, supplied name, nesting scope, and repeated occurrence.
Changing that identity creates different durable work instead of finding the previously completed
step.

```ts
// 🔴 Bad: a different name can be produced on replay.
await step.do(`load customer at ${Date.now()}`, async () => {
  return await customers.get(event.payload.customerId);
});

// ✅ Good: stable name.
const customer = await step.do("load customer", async () => {
  return await customers.get(event.payload.customerId);
});
```

Dynamic names are safe when derived from durable values and traversed in a stable order:

```ts
const itemIds = await step.do("load order item ids", async () => {
  return await orders.getItemIds(event.payload.orderId);
});

for (const itemId of itemIds) {
  await step.do(`load order item ${itemId}`, async () => {
    return await orders.getItem(itemId);
  });
}
```

Repeated names in one scope receive occurrence suffixes such as `#1`, so their order must also
remain deterministic. Step names cannot contain `>`, `#`, or a null character because Fragno
reserves those characters for nested and repeated step keys.

## Persist `Promise.race` and `Promise.any` decisions

Fragno supports parallel and nested steps, including `Promise.all`, `Promise.race`, and
`Promise.any`. The winner selected by `race` or `any` is ordinary in-memory state unless an
enclosing step persists it.

```ts
const provider = await step.do("select first provider", async () => {
  return await Promise.race([
    step.do("call primary provider", async () => {
      return await primaryProvider.lookup(event.payload.query);
    }),
    step.do("call backup provider", async () => {
      return await backupProvider.lookup(event.payload.query);
    }),
  ]);
});

await step.do("use selected provider response", async () => {
  return await useProviderResponse(provider);
});
```

The losing branch is not cancelled. It may remain waiting, finish later, or run again during a later
passage. Keep every branch idempotent. Also take care with `Promise.all`: if one branch suspends or
retries before a sibling commits, the sibling callback can run again.

## Use unique instance IDs

Instance IDs are unique within a workflow name. Fragno stores a unique database index over
`workflowName` and `instanceId`.

Creating the same ID again is idempotent: Fragno returns the existing instance and ignores the new
params. This remains true after the instance reaches a terminal state while its row is still
present.

```ts
const instanceId = `order-${order.id}-${crypto.randomUUID()}`;

await fetch("/api/workflows/process-order/instances", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: instanceId,
    params: { orderId: order.id },
  }),
});
```

Do not use a reusable customer or tenant ID when each invocation represents distinct work. Use an
order, transaction, or task ID, or store a mapping from your domain record to generated workflow
instance IDs.

## Await every step

A step promise is part of workflow control flow, not durable background work. Always await it,
return it, or include it in an awaited promise combinator.

```ts
// 🔴 Bad: errors and suspension escape the workflow's awaited control flow.
step.do("send receipt", async () => {
  await receipts.send(event.payload.orderId);
});

// ✅ Good.
await step.do("send receipt", async () => {
  await receipts.send(event.payload.orderId);
});

// ✅ Good: both branches are awaited.
await Promise.all([
  step.do("update analytics", async () => updateAnalytics(event.payload.orderId)),
  step.do("notify warehouse", async () => notifyWarehouse(event.payload.orderId)),
]);
```

The same rule applies to `step.sleep`, `step.sleepUntil`, and `step.waitForEvent`.

## Branch only on durable values

Conditions and loops outside steps are safe when they use original input params or persisted step
results. Do not use `Math.random()`, `Date.now()`, mutable module state, or `event.timestamp` to
choose the workflow path. `event.timestamp` reflects the current runner tick and can change between
passages.

```ts
const config = await step.do("load notification config", async () => {
  return await settings.getNotificationConfig(event.payload.accountId);
});

// ✅ Durable: based on a persisted step result.
if (config.emailEnabled) {
  await step.do("send email notification", async () => {
    await notifications.sendEmail(event.payload.accountId);
  });
}

// ✅ Durable: based on original instance params.
if (event.payload.priority === "high") {
  await step.do("page on-call", async () => {
    await notifications.pageOnCall(event.payload.accountId);
  });
}
```

If a decision depends on time or randomness, calculate it inside a step and branch on the returned
value.

## Batch instance creation

Use the batch route or `createBatch` service when creating many instances. The batch route accepts
at most 100 entries, requires an ID for every entry, and creates them in one request.

```ts
await fetch("/api/workflows/process-order/instances/batch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    instances: orders.map((order) => ({
      id: `order-${order.id}`,
      params: { orderId: order.id },
    })),
  }),
});
```

Existing instance IDs and duplicate IDs within the same batch are skipped and omitted from the
returned `instances` array. Chunk inputs larger than 100 before calling the route.

## Full documentation

For the full, up-to-date documentation, retrieve the hosted Markdown:

```sh
curl -fL "https://fragno.dev/docs/workflows/rules-of-workflows" -H "accept: text/markdown"
```
