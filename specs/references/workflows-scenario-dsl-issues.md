# Scenario DSL: Issues With Current Gaps

This note captures the concrete issues behind the two previously mentioned improvements.

## 1) Hook-Draining Helper (runPendingHooks / drainHooks)

**Problem** The Scenario DSL currently requires you to manually choose the `reason` for
`runUntilIdle` (`create`, `event`, `wake`, `retry`, `resume`). This is easy to get wrong when a
workflow transitions into a sleep or retry state.

**What breaks**

- If a step suspends for a **wake** (e.g., `sleep` / `sleepUntil`) and you run a tick with the wrong
  reason, the runner will suspend again and the instance stays `waiting`.
- If a step schedules a **retry**, a normal run (`create` / `event`) will also suspend again, and
  the retry never happens.

**Why it’s painful**

- Tests end up with extra boilerplate and knowledge of internal runner semantics.
- You have to manually remember to do `advanceTimeAndRunUntilIdle` or `retryAndRunUntilIdle`, often
  paired with explicit clock manipulation.
- It’s easy to forget a follow-up tick after a `sleep`/`retry`, which makes a scenario look “stuck”
  even though the workflow is behaving correctly.

**Net effect** The DSL feels lower-level than intended and tests couple to internal scheduling
details.

## 2) Event Inspection Helper (exposing stable ordering key)

**Problem** `utils.getEvents()` returns mapped rows, but the runner’s event-consumption order is
based on the raw DB `id` string. When events share the same timestamp, the only stable tie-breaker
is that raw `id` ordering.

**What breaks**

- Tests that assert “first event consumed before second” can be **flaky** or **wrong** because
  `getEvents()` does not expose the raw ID string or a stable ordering key.
- We had to drop to `ctx.harness.db.find("workflow_event", ...)` just to reproduce the runner’s
  deterministic ordering.

**Why it’s painful**

- `utils.getEvents()` is supposed to be the canonical DSL helper, but it’s insufficient for
  validating ordering-sensitive behavior.
- This pushes tests back to raw DB access, which defeats the purpose of the DSL utilities.

**Net effect** The DSL makes it hard to assert event order without leaking internal storage details.
