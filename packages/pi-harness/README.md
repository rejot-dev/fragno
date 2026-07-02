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
  resolveHarness: async (params) => ({
    harnessName: params.harnessName ?? "default",
    systemPrompt: await loadSystemPrompt(params),
    resources: await loadResources(params),
  }),
});
```

`resolveHarness` runs in the first workflow step and should only return serializable per-session
overrides. Keep runtime capabilities like `env`, `streamFn`, and tool `execute` functions in
`harnesses`.

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
