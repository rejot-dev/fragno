# Workflows Fragment (@fragno-dev/workflows)

## Summary

Durable, replayable workflows with steps, timers, retries, and event waits. State is stored in your
DB, and the fragment exposes an HTTP API plus a CLI for management.

## Use when

- You need long-running, multi-step business processes.
- You need retries, timers, or external event waits.
- You want an HTTP API and CLI to inspect and manage workflow instances.

## Config

The fragment config controls what workflows exist and how they run.

What you provide:

- `workflows`: a registry of workflow definitions.
- `runtime`: a `FragnoRuntime` (use `defaultFragnoRuntime` in production).
- `runner`: set after you create a runner with `createWorkflowsRunner`.
- `enableRunnerTick` (optional): expose `POST /_runner/tick` for external schedulers.
- `authorizeRequest` and related hooks (optional): route-level auth controls.

Optional config:

- `dispatcher`: a custom dispatcher to wake the runner if you are not using durable hooks.
- `dbNow`: override for DB time source.

What the fragment needs via options:

- `databaseAdapter`: required for workflow state tables.
- `mountRoute` (optional): defaults to `/api/workflows`.

## What you get

- Workflow definitions with typed params and outputs.
- A runner and dispatcher model for execution.
- HTTP routes for create, manage, and inspect instances.
- `fragno-wf` CLI to interact with workflows.

## Docs (curl)

Main docs pages:

- `curl -L "https://fragno.dev/docs/workflows/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/workflows/routes" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/workflows/runner-dispatcher" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/workflows/cli" -H "accept: text/markdown"`

Search:

- `curl -s "https://fragno.dev/api/search?query=workflows"`

## Prerequisites

- A database and `@fragno-dev/db` adapter.
- Durable hooks configured for the fragment.
- A runner plus a dispatcher (Node in-process or Cloudflare Durable Object).

## Install

`npm install @fragno-dev/workflows @fragno-dev/db`

## Define workflows

Create workflows with `defineWorkflow` and a registry map:

```ts
import { defineWorkflow } from "@fragno-dev/workflows";

export const ApprovalWorkflow = defineWorkflow(
  { name: "approval-workflow" },
  async (event, step) => {
    const approval = await step.waitForEvent("approval", {
      type: "approval",
      timeout: "15 min",
    });
    await step.sleep("cooldown", "2 s");
    return { request: event.payload, approval };
  },
);

export const workflows = { approval: ApprovalWorkflow } as const;
```

## Server setup

1. Build a fragment server using `workflowsFragmentDefinition` and `workflowsRoutesFactory`.
2. Create a runner with `createWorkflowsRunner` and attach it to config.
3. Wire a durable hooks dispatcher so queued work runs without new requests.
4. Mount routes, typically `/api/workflows`.

## Database migrations

- `npx fragno-cli db generate lib/workflows-fragment.ts --format drizzle -o db/workflows.schema.ts`
- `npx fragno-cli db migrate lib/workflows-fragment.ts`

## HTTP routes

- `GET /workflows`
- `POST /workflows/:workflowName/instances`
- `POST /workflows/:workflowName/instances/:instanceId/events`
- `GET /workflows/:workflowName/instances/:instanceId/history`
- `POST /_runner/tick`

## Runner and dispatcher

- Node: use the in-process dispatcher for local dev.
- Cloudflare: use the Durable Object dispatcher so alarms drive the runner.
- External scheduler: keep `enableRunnerTick: true` and call `/_runner/tick`.

## CLI

Install and point at the base URL:

- `npm install -g @fragno-dev/fragno-wf`
- `fragno-wf workflows list -b https://host.example.com/api/workflows`

## Security notes

- Protect `/_runner/tick` and management routes with auth.
- Limit who can send events to workflows.

## Common pitfalls

- Runner not ticking because dispatcher is not wired.
- `enableRunnerTick` disabled while using external scheduler.
- Missing migrations leads to runtime errors.

## Next steps

- Use the test harness for deterministic tests.
- Build a UI on top of the HTTP routes.
