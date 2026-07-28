# Debugging

Use workflow history and internal diagnostics to understand what happened and why a workflow is
waiting or failed.

## History and emissions

The history endpoint returns step results, user events, and persisted step emissions.

```bash
curl "$BASE_URL/approval/instances/inst_123/history"
```

Tips:

- Inspect step `status`, `attempts`, `nextRetryAt`, `wakeAt`, and error fields.
- Inspect events to verify their type and whether they were delivered and consumed.
- Inspect emissions to understand values emitted by the active step.
- Use the current-step emissions route with `once=true` for a snapshot, or without it for a live
  JSON stream.

Internal workflow diagnostics can be enabled with the fragment's `logging` config. These logs are
written to the runtime console and are not returned by the history endpoint.

## Common issues

### Instance never runs

- Ensure the durable hooks dispatcher is configured and running.
- Ensure `autoTickHooks` has not been disabled outside a manually driven test.

### Stuck in waiting

- Verify the event `type` matches the workflow's `waitForEvent` call.
- Use history to inspect buffered events and the wait step's `waitEventType` and `wakeAt` fields.

### Repeated retries or timeouts

- Check `retries.limit`, `retries.delay`, and `retries.backoff` on `step.do` calls.
- Check whether the callback threw `NonRetryableError` or a subclass; these bypass the configured
  retry schedule by design.
- Check `timeout` on `waitForEvent` calls. A timeout throws the non-retryable
  `WaitForEventTimeoutError`.
- Look for the latest step error in history; it includes the error name and message.

### Pause/resume not changing status

- The pause request is respected on the next tick; make sure the dispatcher is still running.
- If the instance is terminal (`complete`, `terminated`, `errored`), it will not resume.

## When to open an issue

If the instance is in a non-terminal state but no hooks are being processed, capture:

- the instance status and metadata
- history output
- runtime console diagnostics, if enabled
- dispatcher configuration

## Full documentation

For the full, up-to-date documentation, retrieve the hosted Markdown:

```sh
curl -fL "https://fragno.dev/docs/workflows/debugging" -H "accept: text/markdown"
```
