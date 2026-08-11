---
name: workflows
description:
  "Orchestrate durable multi-step work with defineWorkflow and operate workflow instances. Use when
  a current task needs retries, sleeps, waiting for an external event, or the user asks to inspect,
  signal, or retry a workflow instance."
---

# Workflows

Use `defineWorkflow` for work that must survive retries, time, or an external continuation.

## Authoring a workflow

1.  **Preflight.** Apply the system guidance's closed-world preflight before calling
    `defineWorkflow`. The workflow authoring declarations are already present in the system
    reference; read the provider declarations selected by that gate.

    **Complete when** the closed-world preflight passes. When it cannot pass, complete this branch
    by reporting the blocking requirement.

2.  **Author.** Define the workflow directly at the top level. Inline definitions automatically
    start; retain the returned `instanceId`. Save a workflow file only when the user asks for
    persistent automation behavior; use the Building Automations skill for that branch.

    ```js
    defineWorkflow({ name: "approval-workflow" }, async (event, step) => {
      const request = await step.do("prepare-request", async () => {
        return { requestId: crypto.randomUUID() };
      });

      const approval = await step.waitForEvent("approval", {
        type: "approval",
        timeout: "15 minutes",
      });

      return { request, approval: approval.payload };
    });
    ```

    Put side effects, provider calls, and expensive work inside `step.do`. Keep pure deterministic
    calculations outside steps. Use stable, descriptive step names because history and retries
    address those names. Use `step.sleep` or `step.sleepUntil` for time and `step.waitForEvent` for
    external continuation.

    **Complete when** every non-deterministic operation has a durable step and every continuation
    has an exact event type.

3.  **Observe.** Copy the returned `instanceId`; code-mode calls do not share in-memory variables.
    Read the run with `workflow.getInstance({ instanceId })`. Inspect output for a completed run,
    confirm the authored event type for a waiting run, and read
    `workflow.getHistory({ instanceId })` when diagnosing an errored run. If instance details are
    temporarily unavailable, call `workflow.listInstances({})` once as a status fallback and report
    the backend failure beside the observed summary.

    **Complete when** the instance is `complete` with observed output, intentionally `waiting` with
    its exact continuation, or `errored` with the failed step and error identified.

## Operating an existing workflow

Read "/static/codemode/providers/workflow.d.ts" for exact inputs:

- `workflow.createInstance({ path, instanceId, payload })` starts a saved `.workflow.js` file.
  Supply a stable `instanceId` and copy it for later calls. Inline `defineWorkflow` runs do not need
  this call.
- `workflow.listInstances({ status, pageSize, cursor })` lists codemode workflow instances.
- `workflow.getInstance({ instanceId })` reads status, output, error, and source path.
- `workflow.getHistory({ instanceId })` exposes steps, events, and emissions for diagnosis.
- `workflow.sendEvent({ instanceId, type, payload })` resumes a waiting instance.
- `workflow.retryInstance({ instanceId, stepKey, delayMs, reason })` retries failed work.

For a waiting instance, send the exact event `type` expected by `step.waitForEvent`. For an errored
instance, inspect the latest failed step before retrying and use its exact `stepKey`.
