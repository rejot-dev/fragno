import type { WorkflowDuration, WorkflowEvent } from "@fragno-dev/workflows/workflow";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { AgentHarness, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";

import { schedulePiOperationCompletedHook } from "../harness/pi-operation-completed";
import { agentMessageSchema, piSessionCommandPayloadSchema } from "../route-schemas";
import type { PiSessionMetadata } from "../types";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type WorkflowAgentHarnessOptions,
} from "./workflow-agent-harness";

const WAIT_FOR_COMMAND_TIMEOUT = "7 days" as const;
export const INTERACTIVE_CHAT_WORKFLOW_NAME = "interactive-chat-workflow";

export type InteractiveChatWorkflowParams = {
  /** Application-owned session metadata supplied by the session creation route. */
  metadata?: PiSessionMetadata;
  /** Opaque workflow-owned value forwarded to operation completion hooks. */
  actor?: unknown;
  initialMessages?: AgentMessage[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
};

export const interactiveChatWorkflowParamsSchema: z.ZodType<InteractiveChatWorkflowParams> =
  z.object({
    metadata: z.record(z.string(), z.unknown()).optional(),
    actor: z.unknown().optional(),
    initialMessages: z.array(agentMessageSchema).optional(),
    systemPrompt: z.string().optional(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  });

export type CreateInteractiveChatWorkflowOptions = {
  name?: string;
  commandTimeout?: WorkflowDuration;
  options:
    | WorkflowAgentHarnessOptions
    | ((
        event: WorkflowEvent<InteractiveChatWorkflowParams>,
      ) => WorkflowAgentHarnessOptions | Promise<WorkflowAgentHarnessOptions>);
};

/**
 * Creates an interactive command loop backed entirely by workflow history.
 *
 * Each prompt is a separate `step.do`, while `sessionState` carries the reduced Pi session between
 * those steps. Workflow replay rebuilds the same state by replaying completed step results in order.
 */
export const createInteractiveChatWorkflow = (config: CreateInteractiveChatWorkflowOptions) => {
  const workflowName = config.name ?? INTERACTIVE_CHAT_WORKFLOW_NAME;
  const commandTimeout = config.commandTimeout ?? WAIT_FOR_COMMAND_TIMEOUT;

  return defineWorkflow(
    {
      name: workflowName,
      schema: interactiveChatWorkflowParamsSchema,
    },
    async (event, step) => {
      const params = interactiveChatWorkflowParamsSchema.parse(event.payload ?? {});
      const initialEvent: WorkflowEvent<InteractiveChatWorkflowParams> = {
        ...event,
        payload: params,
      };
      // AgentHarness options are runtime dependencies, so resolve them outside durable model steps
      // and reconstruct them whenever the workflow replays.
      const harnessOptions =
        typeof config.options === "function" ? await config.options(initialEvent) : config.options;
      let sessionState = createPiHarnessSessionState({
        metadata: {
          id: event.instanceId,
          createdAt: event.timestamp.toISOString(),
        },
        initialMessages: params.initialMessages,
      });
      while (true) {
        const commandEvent = await step.waitForEvent("wait-command", {
          type: "command",
          timeout: commandTimeout,
        });
        const command = piSessionCommandPayloadSchema.parse(commandEvent.payload);

        // Controls can only target the live harness registered inside an active operation. The
        // durable wait has already consumed idle controls, so they do not start a new operation.
        switch (command.kind) {
          case "abort":
          case "steer":
          case "followUp":
            continue;
          case "prompt":
          case "skill":
          case "promptFromTemplate":
            break;
        }

        const operation = {
          stepName: `command:${command.commandId}`,
          operationId: `${workflowName}:${event.instanceId}:command:${command.commandId}`,
        };
        const committedResult = await step.do(operation.stepName, async (tx) => {
          // Current-attempt emissions contain session entries that may have been written before a
          // worker restart. Restoration either replays a completed result or rolls an interrupted
          // prompt back to its original parent before retrying it.
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: operation.operationId,
            state: sessionState,
            previousEmissions: await tx.previousEmissions(),
            models: harnessOptions.models,
          });
          const harness = new AgentHarness({
            ...harnessOptions,
            ...options,
          });

          return await withWorkflowAgentHarness({
            session,
            storage,
            harness,
            tx,
            observeLiveEvents: (onLiveEvent) => {
              // Operation commands stay unconsumed so the outer loop executes them as the next
              // durable step.
              onLiveEvent("command", async (event) => {
                const controlCommand = piSessionCommandPayloadSchema.parse(event.payload);

                switch (controlCommand.kind) {
                  case "abort":
                    await harness.abort();
                    event.consume();
                    break;
                  case "steer":
                  case "followUp": {
                    const { text, images } = controlCommand.input;
                    const promptOptions = images ? { images } : undefined;
                    if (controlCommand.kind === "steer") {
                      await harness.steer(text, promptOptions);
                    } else {
                      await harness.followUp(text, promptOptions);
                    }
                    event.consume();
                    break;
                  }
                  case "prompt":
                  case "skill":
                  case "promptFromTemplate":
                    break;
                }
              });
            },
            runDurableStep: async () => {
              switch (command.kind) {
                case "prompt":
                  return await harness.prompt(
                    command.input.text,
                    command.input.images ? { images: command.input.images } : undefined,
                  );
                case "skill":
                  return await harness.skill(
                    command.input.name,
                    command.input.additionalInstructions,
                  );
                case "promptFromTemplate":
                  return await harness.promptFromTemplate(command.input.name, command.input.args);
              }

              throw new Error("Unsupported Pi session operation command.");
            },
            // Accounting is registered before the adapter accepts or rejects the terminal
            // assistant, so failed model calls are still recorded by the terminal-error
            // transaction path.
            onTerminalOutcome: ({ operationEntries }) => {
              schedulePiOperationCompletedHook({
                tx,
                actor: params.actor ?? null,
                workflowName,
                sessionId: sessionState.metadata.id,
                metadata: params.metadata ?? null,
                stepName: operation.stepName,
                operationId: operation.operationId,
                operation: command.kind,
                operationEntries,
              });
            },
          });
        });
        // Only reduce after the durable step completes; interrupted attempts reconstruct their
        // uncommitted entries from step emissions instead.
        sessionState = applyWorkflowAgentHarnessStepResult(sessionState, committedResult);
      }
    },
  );
};
