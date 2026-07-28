# Step Events & Emissions

`step.do` callbacks receive a `WorkflowStepTx`. In addition to database and service mutations, this
transaction can publish step emissions and observe durable events while the step is active.

## Publish with `tx.emit`

Use `tx.emit(payload)` for progress, tokens, status changes, or other output that observers should
receive before the step completes:

```ts
await step.do("generate-report", async (tx) => {
  tx.emit({ type: "status", phase: "started" });

  const report = await generateReport((completed, total) => {
    tx.emit({ type: "progress", completed, total });
  });

  tx.emit({ type: "status", phase: "finished" });
  return report;
});
```

Emissions are persisted with an `actor`, `stepKey`, attempt `epoch`, sequence, payload, and creation
time. The runner also publishes system control emissions such as `step-started` and
`step-committed`; do not assume every emission payload was authored by your workflow.

Emissions are live, step-scoped data rather than a permanent audit log. After an attempt commits,
the durable cleanup hook removes that attempt's persisted emissions. Consume the current-step stream
for live UI and use step results or your own tables for durable domain history.

## Inspect with `tx.previousEmissions`

`await tx.previousEmissions()` returns emissions for the same step key that were already persisted
when the current attempt was loaded. This can help an attempt inspect partial streamed output that
is still available from an earlier epoch:

```ts
await step.do("stream-answer", { retries: { limit: 2, delay: "1 s" } }, async (tx) => {
  const previous = await tx.previousEmissions();
  const previousTokens = previous
    .filter((emission) => emission.actor === "user")
    .map((emission) => emission.payload)
    .filter(
      (payload): payload is { type: "token"; value: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "token",
    );

  const answer = previousTokens.map((token) => token.value).join("");
  return await continueGeneration(answer, (value) => {
    tx.emit({ type: "token", value });
  });
});
```

The result can include workflow-authored and system emissions. It does not include calls to
`tx.emit` made during the current attempt because those were not loaded before the attempt began.
Use `stepKey`, `epoch`, `sequence`, `actor`, and the payload shape to select the records you need.

`previousEmissions` is not a durable checkpoint store. The cleanup hook can remove completed attempt
epochs before a later retry begins. Persist recovery state in your own schema when it must survive
cleanup.

## Receive events with `tx.onEvent`

`tx.onEvent(type, handler)` subscribes an active `step.do` callback to durable workflow events of an
exact type. It returns an unsubscribe function.

```ts
await step.do("interactive-review", async (tx) => {
  const reviewed = new Promise<{ approved: boolean }>((resolve) => {
    const unsubscribe = tx.onEvent("review", (event) => {
      event.consume();
      unsubscribe();
      resolve(event.payload as { approved: boolean });
    });
  });

  tx.emit({ type: "status", phase: "waiting-for-review" });
  return await reviewed;
});
```

Each event provides:

```ts
{
  id: string;
  type: string;
  payload: Readonly<unknown>;
  timestamp: Date;
  consume(): void;
}
```

Calling `event.consume()` queues durable consumption. That consumption commits only when the
surrounding step completes successfully. If the attempt retries, the handler may receive the event
again. Make handlers replay-safe, and call the returned unsubscribe function when the active step no
longer needs delivery.

Use `step.waitForEvent(...)` when the event itself is the durable step boundary. Use
`tx.onEvent(...)` when a long-running `step.do` callback must receive events while it continues
running.

## Observe current-step emissions

The HTTP route streams both persisted snapshot rows and new live emissions:

```http
GET /:workflowName/instances/:instanceId/current-step/emissions
```

Pass `once=true` for the current snapshot without keeping the stream open. Framework clients expose
the same route through `useCurrentStepEmissions`.

The instance history route also returns emissions that are still persisted at read time. Because
completed attempt emissions are cleaned up asynchronously, do not treat the history response as a
permanent emission archive.

## Event consumption hooks

The `onConsume` callback of `step.waitForEvent` receives a narrower transaction that also supports
`emit` and `previousEmissions`:

```ts
await step.waitForEvent("approval", {
  type: "approval",
  onConsume: async (tx, event) => {
    tx.emit({ type: "approval-received", payload: event.payload });
    const previous = await tx.previousEmissions();
    // Queue mutate-only database work if needed.
  },
});
```

Work queued by `onConsume` commits atomically with consumption of the event and completion of the
wait step.

## Full documentation

For the full, up-to-date documentation, retrieve the hosted Markdown:

```sh
curl -fL "https://fragno.dev/docs/workflows/step-events-emissions" -H "accept: text/markdown"
```
