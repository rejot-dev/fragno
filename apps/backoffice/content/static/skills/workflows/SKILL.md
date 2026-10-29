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
    calculations outside steps. An instance pins the saved modules it imports when it is created.
    Use stable, descriptive step names because history and retries address those names. Use
    `step.sleep` or `step.sleepUntil` for time and `step.waitForEvent` for external continuation.

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

### Prompting a durable Pi agent

Use the `pi` runtime tools when a workflow needs model work. Prompt a defined agent by name; list
them with `pi.listAgents({})`, and read `/static/skills/pi-agents/SKILL.md` to define a new one.
`pi.submitPrompt` queues the prompt and returns at once. Use the run's instance ID as its
`requestId`: a step retried after an uncertain outcome then keeps the original prompt instead of
queuing a second turn, and the turn's events name the run waiting for them.

```js
await step.do("submit classification", async () => {
  return await pi.submitPrompt({
    agentName: "assistant",
    requestId: event.instanceId,
    content: `Classify this text and explain the decision concisely:\n\n${text}`,
  });
});

// The payload is the agent's pi event.
const settled = await step.waitForEvent("wait for classification", { type: "pi-turn-settled" });

const classification = await step.do("read classification", async () => {
  if (settled.payload.eventType !== "turn.completed") {
    return null;
  }
  // The event carries no answer; reading it needs pi.read.
  const prompt = await pi.getPrompt({ agentName: "assistant", requestId: event.instanceId });
  // An answer that said nothing is null.
  return prompt?.status === "completed" ? prompt.answer : null;
});
```

The wait ends when a route sends the prompt's turn event to the run. Save the workflow, start it
from a route whose `instanceIdTemplate` gives its runs a shared prefix, and add one
`send_workflow_event` route for each of the `pi` events `turn.completed`, `turn.failed`,
`turn.aborted`, and `queue.dropped`: match `$.subject.agentName` and the prefix on
`$.subject.requestId`, target `{ kind: "instance_id", template: "${event.subject.requestId}" }`, and
send `eventType` `"pi-turn-settled"`. Read `/static/skills/building-automations/SKILL.md` for
routes. A run waits for one prompt this way, since the prompt's request ID is the run's instance ID.

An agent has one ongoing conversation and runs one turn at a time; a prompt to a busy agent waits
for the current turn. The turn runs with the workflow's current permissions, narrowed by the agent's
definition. Keep unrelated external effects in separate `step.do` calls with their own stable
idempotency keys.

## Operating an existing workflow

Read "/static/codemode/providers/workflow.d.ts" for exact inputs:

- `workflow.createInstance({ path, instanceId, payload, notifyWhenDone })` starts a saved
  `.workflow.js` file. Supply a stable `instanceId` and copy it for later calls. With
  `notifyWhenDone: true`, an agent hears a `workflows` `instance.completed` event, carrying the
  run's status, output, and error, when it ends, also for a run started in another scope through
  `context.org(...)` or `context.user(...)`; end your turn instead of polling. The event's subject
  names the run's `scope`, `workflowName`, and `instanceId`: read or retry the run in that scope.
  Inline `defineWorkflow` runs do not need this call, and always notify the agent that defined them.
- `workflow.listInstances({ status, pageSize, cursor })` lists codemode workflow instances.
- `workflow.getInstance({ instanceId })` reads status, output, error, and source path.
- `workflow.showInstance({ instanceId })` shows a run in this scope to the user as a card in your
  reply, live as an inline run's card: its steps, every interface they return, and its output. Show
  a saved run the user should follow or answer, such as one waiting on a form, instead of relaying
  its state; reading a run with `getInstance` shows nothing.
- `workflow.getHistory({ instanceId })` exposes steps, events, and emissions for diagnosis.
- `workflow.sendEvent({ instanceId, type, payload })` resumes a waiting instance.
- `workflow.retryFailedStep({ instanceId, delayMs })` retries the latest failed top-level step.

For a waiting instance, send the exact event `type` expected by `step.waitForEvent`. Failed-step
retry requires the latest top-level step to be the only failed top-level step. Retrying a `do` step
reruns all of its nested steps, including completed steps, so their effects and mutations must be
repeatable. Retrying a failed event wait starts a fresh timeout window and considers pending events
before the new deadline.
