# @fragno-dev/pi-harness

A Fragno fragment that provides Pi session/commands routes, workflow-backed AgentHarness helpers,
and client integrations.

## Usage

Import the logical surface you need directly:

```ts
import { piHarnessDefinition } from "@fragno-dev/pi-harness/definition";
import { createPiHarness } from "@fragno-dev/pi-harness/factory";
import { createAgentLoop } from "@fragno-dev/pi-harness/harness/commands";
import { definePiTool } from "@fragno-dev/pi-harness/tools";
import type { PiFragmentConfig } from "@fragno-dev/pi-harness/types";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
```

There is intentionally no package-root barrel export.

Interactive chat workflows split static runtime capabilities from durable per-session resolution:

```ts
createInteractiveChatWorkflow({
  harnesses: {
    default: {
      env,
      model,
      tools: [searchTool],
      streamFn,
    },
  },
  resolveHarness: async (params, { sessionId }) => ({
    harnessName: params.harnessName ?? "default",
    systemPrompt: await loadSystemPrompt(params),
    resources: await loadResources(params),
    tools: await loadSessionTools(sessionId),
  }),
});
```

`resolveHarness` runs outside durable workflow steps and receives `{ workflowName, sessionId }`, so
it may return non-serializable runtime overrides such as session-scoped tool `execute` functions.
Keep static defaults like `env`, `model`, and `streamFn` in `harnesses` when possible.

Tools are registered up front on the agent loop. Use `activeToolNames` as a per-step policy when a
turn should expose only a subset of the registered tools:

```ts
const loop = createAgentLoop(step, {
  env,
  model,
  workflowName,
  sessionId,
  agentName: "default",
  tools: [searchTool, writeTool],
});

await loop.waitForCommandAndRunStep({
  activeToolNames: ["search"],
});
```

## Operation completion hook

Interactive workflow input may include an opaque, JSON-serializable `actor`. It remains part of the
durable workflow parameters and the interactive workflow forwards it to each agent-loop operation.
Pi Harness does not interpret its shape.

```ts
const config = {
  workflows: [interactiveChatWorkflow],
  onOperationCompleted: async ({ actor, sessionId, operation, modelCalls, usage }, context) => {
    await recordUsage({
      idempotencyKey: context.idempotencyKey,
      actor,
      sessionId,
      operation,
      modelCalls,
      usage,
    });
  },
} satisfies PiFragmentConfig;
```

The callback runs through the Pi fragment's durable-hook namespace. Node integrations must include
both the workflows and Pi fragments in the same durable-hooks processor:

```ts
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

const dispatcher = createDurableHooksProcessor([workflowsFragment, piFragment]);
dispatcher.startPolling();
```

`onOperationCompleted` is a durable hook triggered when a harness operation reaches a committed
terminal outcome. One operation can span multiple Pi turns and model calls when the agent uses
tools, so the payload includes both the individual calls and their aggregate usage. Failed and
aborted provider responses are included because they can still report billable usage.

Usage reporting currently covers operations that expose assistant messages. Compact operations and
tree navigation with summarization are not reported because Pi does not expose their internal model
calls as first-class harness events yet.

Workflow steps use optimistic concurrency control. In the rare case that the same step executes more
than once, only the execution whose transaction commits triggers the hook. Provider usage from
losing executions is therefore not reported. This is an intentional limitation for consumers
implementing allowances or usage limits.
