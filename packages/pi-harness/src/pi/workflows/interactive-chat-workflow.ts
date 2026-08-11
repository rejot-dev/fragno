import type { WorkflowDuration, WorkflowEvent } from "@fragno-dev/workflows/workflow";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import {
  AgentHarness,
  AgentHarnessError,
  CompactionError,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { schedulePiOperationCompletedHook } from "../harness/pi-operation-completed";
import { agentMessageSchema, piSessionCommandPayloadSchema } from "../route-schemas";
import type { PiSessionCommandStartEmission } from "../session-command-protocol";
import {
  PI_SESSION_COMMAND_STEP_PREFIX,
  type PiCompactCommandOutcome,
  type PiSessionMetadata,
} from "../types";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  hasSummarizableCompactionHistory,
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

const logInteractiveChatAssistantError = (
  assistant: AssistantMessage,
  context: {
    workflowName: string;
    sessionId: string;
    commandId: string;
    commandKind: "prompt" | "skill" | "promptFromTemplate";
  },
): void => {
  if (assistant.stopReason !== "error") {
    return;
  }

  console.error("Pi interactive chat model operation failed.", {
    ...context,
    provider: assistant.provider,
    model: assistant.model,
    ...(assistant.errorMessage !== undefined ? { errorMessage: assistant.errorMessage } : {}),
  });
};

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

        // Controls can only target the live harness registered for an active invocation. The
        // durable wait has already consumed idle controls, so they do not start a new step.
        switch (command.kind) {
          case "abort":
          case "steer":
          case "followUp":
            continue;
          case "prompt":
          case "skill":
          case "promptFromTemplate":
          case "compact":
            break;
        }

        const invocation = {
          stepName: `${PI_SESSION_COMMAND_STEP_PREFIX}${command.commandId}`,
          operationId: `${workflowName}:${event.instanceId}:command:${command.commandId}`,
        };
        const committedResult = await step.do(invocation.stepName, async (tx) => {
          // Current-attempt emissions contain session entries that may have been written before a
          // worker restart. Restoration either replays a completed result or rolls an interrupted
          // prompt back to its original parent before retrying it.
          const { session, storage, options } = restoreWorkflowBackedSession({
            operationId: invocation.operationId,
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
              // Durable commands stay unconsumed so the outer loop executes them as the next step.
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
                  case "compact":
                    break;
                }
              });
            },
            checkpointTerminalAssistantError: true,
            runDurableStep: async () => {
              tx.emit({
                kind: "pi-session-command-start",
                command: { commandId: command.commandId, kind: command.kind },
              } satisfies PiSessionCommandStartEmission);

              const logAssistantError = (
                commandKind: "prompt" | "skill" | "promptFromTemplate",
                assistant: AssistantMessage,
              ) => {
                logInteractiveChatAssistantError(assistant, {
                  workflowName,
                  sessionId: event.instanceId,
                  commandId: command.commandId,
                  commandKind,
                });
              };

              switch (command.kind) {
                case "prompt": {
                  const assistant = await harness.prompt(
                    command.input.text,
                    command.input.images ? { images: command.input.images } : undefined,
                  );
                  logAssistantError("prompt", assistant);
                  return assistant;
                }
                case "skill": {
                  const assistant = await harness.skill(
                    command.input.name,
                    command.input.additionalInstructions,
                  );
                  logAssistantError("skill", assistant);
                  return assistant;
                }
                case "promptFromTemplate": {
                  const assistant = await harness.promptFromTemplate(
                    command.input.name,
                    command.input.args,
                  );
                  logAssistantError("promptFromTemplate", assistant);
                  return assistant;
                }
                case "compact": {
                  const preparationResult = prepareCompaction(
                    await session.getBranch(),
                    DEFAULT_COMPACTION_SETTINGS,
                  );
                  if (!preparationResult.ok) {
                    if (preparationResult.error.code === "invalid_session") {
                      throw new NonRetryableError(
                        `PI_COMPACTION_INVALID_SESSION: ${preparationResult.error.message}`,
                      );
                    }
                    throw preparationResult.error;
                  }
                  if (
                    !preparationResult.value ||
                    !hasSummarizableCompactionHistory(preparationResult.value)
                  ) {
                    return {
                      kind: "compact",
                      commandId: command.commandId,
                      status: "rejected",
                      code: "nothing_to_compact",
                      message: "Nothing to compact.",
                    } satisfies PiCompactCommandOutcome;
                  }

                  try {
                    await harness.compact(command.input.customInstructions);
                    return {
                      kind: "compact",
                      commandId: command.commandId,
                      status: "succeeded",
                    } satisfies PiCompactCommandOutcome;
                  } catch (error) {
                    if (!(error instanceof AgentHarnessError) || error.code !== "compaction") {
                      throw error;
                    }
                    if (!(error.cause instanceof CompactionError)) {
                      throw error;
                    }

                    switch (error.cause.code) {
                      case "aborted":
                      case "summarization_failed":
                        return {
                          kind: "compact",
                          commandId: command.commandId,
                          status: "rejected",
                          code: "compaction_failed",
                          message: error.cause.message,
                        } satisfies PiCompactCommandOutcome;
                      case "invalid_session":
                        throw new NonRetryableError(
                          `PI_COMPACTION_INVALID_SESSION: ${error.cause.message}`,
                        );
                      case "unknown":
                        throw error;
                    }
                  }
                }
              }

              throw new Error("Unsupported durable Pi session command.");
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
                stepName: invocation.stepName,
                operationId: invocation.operationId,
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
