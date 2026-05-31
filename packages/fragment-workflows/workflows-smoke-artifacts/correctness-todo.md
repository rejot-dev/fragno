# Workflows Correctness Checklist (Current API)

This checklist reflects the current workflow fragment source:

- public routes: list workflows, list/create/batch instances, get instance, full history, pause,
  resume, terminate, send event, and current-step emissions;
- no public `restart` route or `runNumber` contract;
- no public `_runner/tick` route; execution is driven by durable hook dispatchers;
- history is returned as a full ordered snapshot, while instance listing is cursor-paginated;
- no retention/GC policy is currently exposed.

## Smoke scripts

Run the example app first:

```bash
WF_EXAMPLE_DATABASE_URL=postgres://postgres:postgres@localhost:5436/wilco \
  pnpm --filter @fragno-example/wf-example dev
```

Then run scripts with:

```bash
BASE_URL=http://localhost:5173/api/workflows \
  node packages/fragment-workflows/workflows-smoke-artifacts/<script>.js
```

Some fault-injection scripts require `tsx`, `psql`, Docker, or `WF_DISABLE_INTERNAL_DISPATCHER=1`;
see the script headers/env vars.

## Checklist

- [ ] API contract: list workflows, reject invalid identifiers, reject duplicate creates, validate
      params, and page `GET /:workflowName/instances` with cursors.
- [ ] Basic lifecycle: create active instance, wait for `waitForEvent`, send events, complete, and
      verify status output/history metadata.
- [ ] Batch create: create up to the route limit, skip duplicate IDs in a batch, and verify every
      created instance emits exactly one create hook.
- [ ] Event buffering/idempotency: send duplicate events before/after waits, while paused, and while
      racing resume; only one event should be consumed per wait step.
- [ ] Pause/resume: pause active and waiting instances, ensure no user event is consumed while
      paused, resume, and verify progress resumes from the same step.
- [ ] Termination: terminate active, waiting, and in-flight long steps; no later hook/tick may
      overwrite the terminal `terminated` state.
- [ ] Retry/backoff: drive retrying steps to success and exhaustion; attempts must never exceed
      `maxAttempts`, retry hooks must honor `nextRetryAt`, and terminal errors must be stable.
- [ ] Sleep/wake/timeout: sleep and `waitForEvent` timeout hooks should not fire early, should fire
      after wake time, and should reject late events after timeout.
- [ ] Parallel/nested/race semantics: `Promise.all`, `Promise.race`, and nested step trees should
      keep stable step keys/parents and replay only incomplete work.
- [ ] Step transaction semantics: `tx.mutate`, `tx.serviceCalls`, `tx.onTerminalError`, `tx.emit`,
      `tx.previousEmissions`, and `tx.onEvent` should commit only under their documented outcome.
- [ ] Current-step emissions: live and `once=true` streams should show in-flight emissions, support
      remote observers, and clean up after completion/error/retry suspension.
- [ ] Durable hook dispatcher concurrency: run multiple processors, duplicate hook/event storms, and
      skewed clocks; state must remain idempotent with no attempt overflows.
- [ ] Process/DB faults: kill dispatchers, kill the app during long steps, and restart Postgres;
      work should recover or terminate according to status without partial commits.
- [ ] Large payloads: hundreds of KB of params/event payload/output should round-trip through status
      and history without truncation.
- [ ] Migration safety: concurrent `migrate(fragment)` calls and dispatchers should be idempotent,
      with no duplicate indexes or partial schema versions.
- [ ] Client integration: React/Vue/Svelte/Solid/vanilla clients should invalidate
      list/detail/history hooks after creates, batch creates, pause/resume/terminate, and send-event
      mutators.
