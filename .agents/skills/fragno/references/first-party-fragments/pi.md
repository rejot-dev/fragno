# Pi Harness (`@fragno-dev/pi-harness`)

## Summary

Pi Harness is a Fragno fragment for workflow-backed Pi `AgentHarness` sessions. It provides durable
session and command routes, replay-safe workflow integration, session projections, and typed client
integrations.

The package supersedes `@fragno-dev/pi-fragment`. Some exported identifiers still contain
`PiFragment` for compatibility; the package, fragment definition, and database namespace are
`pi-harness`.

## Use when

- You are embedding Pi agents in a product.
- Agent sessions must survive retries, restarts, and long-running workflow execution.
- Tool execution must be reconstructed safely during workflow replay.
- A frontend needs typed session, session-detail, and command clients.

## Integration boundary

Pi Harness owns session projection and command transport. The application owns:

- the workflow registry;
- model and provider configuration;
- tool definitions and tool authorization;
- the workflow runner or durable-hooks dispatcher;
- authentication and authorization around mounted routes.

Use the `fragno-workflows` skill for workflow definitions, replay-safe steps, dispatchers, events,
emissions, and workflow tests.

## Prerequisites

- `@fragno-dev/workflows` and `@fragno-dev/db`;
- a supported Fragno database adapter and applied migrations;
- model/provider configuration for `AgentHarness`;
- a workflow runner or durable-hooks dispatcher that advances workflow instances.

## Install

```bash
npm install @fragno-dev/pi-harness @fragno-dev/workflows @fragno-dev/db
```

## Server setup

Create an interactive workflow, register it with both the Workflows fragment and Pi Harness, then
mount both fragments:

```ts
import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const interactiveChat = createInteractiveChatWorkflow({
  options: {
    model,
    models,
    systemPrompt: "You are a helpful support agent.",
    tools: [searchTool],
  },
});

const piConfig = { workflows: [interactiveChat] };
const workflows = createPiWorkflows(piConfig);

const workflowsFragment = createWorkflowsFragment(
  { workflows, runtime: defaultFragnoRuntime },
  { databaseAdapter, mountRoute: "/api/workflows" },
);

export const piHarness = createPiHarness(
  piConfig,
  { databaseAdapter, mountRoute: "/api/pi" },
  { workflows: workflowsFragment.services },
);
```

For application-dependent tools, system prompts, or resources, pass a function as the workflow's
`options` value. It runs before each operation and may return runtime-only values such as tool
`execute` functions; durable workflow state must remain serializable.

Custom workflows can use the lower-level helpers from
`@fragno-dev/pi-harness/workflows/workflow-agent-harness`. Restore the session from workflow
history, run one harness operation inside a durable step, and apply the committed step result before
starting the next operation.

## Routes

After mounting the fragment, the route surface is:

- `POST /workflows/:workflowName/sessions`
- `GET /workflows/:workflowName/sessions`
- `GET /workflows/:workflowName/sessions/:sessionId`
- `GET /workflows/:workflowName/sessions/:sessionId/export/pi-jsonl`
- `GET /workflows/:workflowName/sessions/:sessionId/wait-for-agent-end`
- `POST /workflows/:workflowName/sessions/:sessionId/command`

Session creation accepts a workflow name, optional name and metadata, and workflow input. Commands
include prompts, skills, prompt templates, compaction, steering, follow-ups, and aborts. Command
submission is asynchronous; observe the session detail or wait-for-agent-end route for progress.

## Client setup

Use the framework-specific client entrypoint. The client export names retain the existing
`PiFragment` terminology:

```ts
import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";

export const pi = createPiFragmentClient({ baseUrl: "/api/pi" });

const sessions = pi.useSessions();
const session = pi.useSessionDetail();
const createSession = pi.useCreateSession();
const sendCommand = pi.useCommandSession();
```

The client also has Solid, Svelte, Vue, and vanilla entrypoints. Read
`packages/pi-harness/src/client/clients.ts` when the generated hook or mutator shape matters.

## Operation completion hooks

`PiFragmentConfig.onOperationCompleted` is a durable hook for committed terminal outcomes. Its
payload includes the session operation and model usage. Make the handler idempotent using the hook
context's idempotency key. Register both the Workflows and Pi Harness fragments with the same Node
durable-hooks processor when using durable hooks.

## Database and operations

Generate migrations from the application module that wires Workflows and Pi Harness, then apply the
result with the application's normal migration workflow. Pi Harness stores session metadata in the
`pi-harness` schema namespace; workflow state and history come from the Workflows fragment.

The mounted routes still require application authentication and authorization. Route protection is
not provided by the fragment.

## Common pitfalls

- Registering a workflow with Pi Harness but not with the Workflows fragment.
- Mounting Pi Harness without wiring `workflowsFragment.services`.
- Running without a workflow runner or durable-hooks dispatcher.
- Putting non-serializable model/tool runtime values into workflow parameters or step results.
- Treating command submission as synchronous.
- Using the deleted `@fragno-dev/pi-fragment` package or its old package paths.

## Local references

- `packages/pi-harness/README.md`
- `packages/pi-harness/src/pi/factory.ts`
- `packages/pi-harness/src/routes.ts`
- `apps/docs/app/routes/pi.tsx`
- `apps/docs/content/docs/pi/custom-workflows.mdx`
