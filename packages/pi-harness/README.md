# @fragno-dev/pi-harness

A Fragno fragment that provides Pi session/commands routes, workflow-backed AgentHarness helpers,
and client integrations.

## Usage

Import the logical surface you need directly:

```ts
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { piHarnessDefinition } from "@fragno-dev/pi-harness/definition";
import { createPiHarness } from "@fragno-dev/pi-harness/factory";
import { piSessionCommandPayloadSchema } from "@fragno-dev/pi-harness/route-schemas";
import { definePiTool } from "@fragno-dev/pi-harness/tools";
import type { PiFragmentConfig } from "@fragno-dev/pi-harness/types";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
} from "@fragno-dev/pi-harness/workflows/workflow-agent-harness";
```

There is intentionally no package-root barrel export.

Interactive chat workflows reconstruct normal `AgentHarness` options for every workflow replay:

```ts
createInteractiveChatWorkflow({
  options: async (event) => ({
    model,
    models,
    systemPrompt: await loadSystemPrompt(event.payload),
    resources: await loadResources(event.payload),
    tools: await loadSessionTools(event.instanceId),
  }),
});
```

The `options` callback runs outside durable workflow steps, so it may return non-serializable
runtime resources such as session-scoped tool `execute` functions. Session creation may include an
arbitrary `metadata` object; Pi Harness stores it with the session, forwards it as
`event.payload.metadata`, and includes it in operation accounting.

Custom workflows own their durable steps and use real Pi `Session` and `AgentHarness` objects. Fold
each completed step result into workflow-local state before starting the next operation:

```ts
const workflow = defineWorkflow(
  { name: "search-chat", schema: z.object({}) },
  async (event, step) => {
    let state = createPiHarnessSessionState({
      metadata: { id: event.instanceId, createdAt: event.timestamp.toISOString() },
    });

    while (true) {
      const commandEvent = await step.waitForEvent("wait-command", {
        type: "command",
        timeout: "7 days",
      });
      const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);
      if (command.kind !== "prompt") continue;

      const result = await step.do(`command:${command.commandId}`, async (tx) => {
        const {
          session,
          storage,
          options: restoredOptions,
        } = restoreWorkflowBackedSession({
          operationId: `${workflow.name}:${event.instanceId}:command:${command.commandId}`,
          state,
          previousEmissions: await tx.previousEmissions(),
          models,
        });
        const harness = new AgentHarness({
          session,
          models,
          model,
          tools: [searchTool, writeTool],
          activeToolNames: ["search"],
          ...restoredOptions,
        });

        return await withWorkflowAgentHarness({
          session,
          storage,
          harness,
          tx,
          runDurableStep: () => harness.prompt(command.input.text),
        });
      });

      state = applyWorkflowAgentHarnessStepResult(state, result);
    }
  },
);
```

`activeToolNames` is a per-harness-operation policy for exposing only a subset of registered tools.

## Harness event protocol

Pi Harness encodes every subscribed `AgentHarness` event with its compact, versioned event protocol.
Workflow projections, routes, and clients use the same protocol automatically. Protocol selection is
not configurable.

The frontend projection preserves event count, order, and event type while omitting provider-owned
assistant metadata and signatures. Import the projected event types separately when needed:

```ts
import type { PiHarnessFrontendEvent } from "@fragno-dev/pi-harness/harness/agent-harness-event-protocol";
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
