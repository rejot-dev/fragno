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
