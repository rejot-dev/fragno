import { WorkflowsLogger } from "@fragno-dev/workflows/debug-log";
import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import { PiLogger } from "../../debug-log";
import { piSchema } from "../../schema";
import type {
  PiFragmentConfig,
  PiPromptInput,
  PiSessionCommandPayload,
  PiToolRegistry,
  PiAgentRegistry,
  PiSessionEventStreamItem,
} from "../types";
import {
  runAgentTurn,
  type AgentLoopParams,
  type PiAgentRunMode,
  type PiAgentRunResult,
} from "./agent-runner";

export const PI_WORKFLOW_NAME = "agent-loop-workflow";

export type PiAgentRunOptions = {
  mode: PiAgentRunMode;
  promptInput?: PiPromptInput;
  params: AgentLoopParams;
  agent: PiAgentRegistry[string];
  tools: PiToolRegistry;
  messages: AgentMessage[];
  turnId: string;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onController?: (controller: {
    abort(): void;
    steer(input: PiPromptInput): void;
    followUp(input: PiPromptInput): void;
  }) => void;
  onControllerClear?: () => void;
};

export type PiAgentRunner = (options: PiAgentRunOptions) => Promise<PiAgentRunResult>;

type WorkflowsOptions = {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  logging?: PiFragmentConfig["logging"];
  agentRunner?: PiAgentRunner;
};

const WAIT_FOR_COMMAND_TIMEOUT = "1 hour" as const;

type TurnStatus = "idle" | "waiting-to-continue";

const getMessageText = (message: AgentMessage | undefined): string | undefined => {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .flatMap((part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }
      return [];
    })
    .join("");
};

const describeAgentEvent = (event: AgentEvent) => {
  const maybeMessage = "message" in event ? event.message : undefined;
  const text = getMessageText(maybeMessage as AgentMessage | undefined);
  return {
    type: event.type,
    messageRole: maybeMessage?.role,
    textLength: text?.length,
    textPreview: text ? text.slice(0, 120) : undefined,
    toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
    toolName: "toolName" in event ? event.toolName : undefined,
  };
};

export type PiOutMessage = PiSessionEventStreamItem;
export type PiInMessage =
  | { kind: "abort"; commandId: string; reason?: string }
  | { kind: "steer"; commandId: string; input: PiPromptInput };

const agentLoopParamsSchema: z.ZodType<AgentLoopParams> = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  initialMessages: z.array(z.custom<AgentMessage>()).optional(),
});

const promptInputSchema = z.object({
  text: z.string(),
  images: z
    .array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }))
    .optional(),
});

const commandPayloadSchema: z.ZodType<PiSessionCommandPayload> = z.discriminatedUnion("kind", [
  z.object({ commandId: z.string(), kind: z.literal("prompt"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("continue") }),
  z.object({ commandId: z.string(), kind: z.literal("abort"), reason: z.string().optional() }),
  z.object({ commandId: z.string(), kind: z.literal("steer"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("followUp"), input: promptInputSchema }),
  z.object({ commandId: z.string(), kind: z.literal("complete"), reason: z.string().optional() }),
]);

type AgentRunStepResult = {
  type: "agent-run";
  outcome: PiAgentRunResult["outcome"];
  messages: AgentMessage[];
  events: AgentEvent[];
  errorMessage: string | null;
};

type CommandStepResult = AgentRunStepResult | { type: "noop" } | { type: "complete" };

export const isEphemeralAgentEvent = (event: AgentEvent) =>
  event.type === "message_update" || event.type === "tool_execution_update";

const waitStepName = (commandIndex: number) => `wait-command-${commandIndex}`;
const commandStepName = (commandIndex: number, kind: PiSessionCommandPayload["kind"]) =>
  `command-${commandIndex}-${kind}`;

const canRunCommand = (command: PiSessionCommandPayload, status: TurnStatus) => {
  switch (command.kind) {
    case "prompt":
    case "followUp":
    case "complete":
      return status === "idle";
    case "continue":
    case "abort":
      return status === "waiting-to-continue";
    case "steer":
      return false;
  }
};

const toRunMode = (command: PiSessionCommandPayload): PiAgentRunMode =>
  command.kind === "continue" ? "continue" : "prompt";

const toPromptInput = (command: PiSessionCommandPayload): PiPromptInput | undefined =>
  command.kind === "prompt" || command.kind === "followUp" ? command.input : undefined;

const createPiAgentLoopWorkflow = (options: WorkflowsOptions) =>
  defineWorkflow<
    typeof PI_WORKFLOW_NAME,
    typeof agentLoopParamsSchema,
    { messages: AgentMessage[] }
  >(
    {
      name: PI_WORKFLOW_NAME,
      schema: agentLoopParamsSchema,
    },
    async (event: WorkflowEvent<AgentLoopParams>, step: WorkflowStep) => {
      const params = agentLoopParamsSchema.parse(event.payload ?? {});
      const agentDefinition = options.agents[params.agentName];
      if (!agentDefinition) {
        throw new NonRetryableError(`Agent ${params.agentName} not found.`);
      }

      let commandIndex = 0;
      let turn = 0;
      let status: TurnStatus = "idle";
      let messages = Array.isArray(params.initialMessages) ? params.initialMessages : [];

      while (true) {
        const commandEvent = await step.waitForEvent(waitStepName(commandIndex), {
          type: "command",
          timeout: WAIT_FOR_COMMAND_TIMEOUT,
        });
        const receivedCommand = commandPayloadSchema.parse(commandEvent.payload ?? {});
        const command =
          receivedCommand.kind === "steer"
            ? ({ ...receivedCommand, kind: "followUp" } as const)
            : receivedCommand;
        const stepName = commandStepName(commandIndex, command.kind);
        commandIndex += 1;

        const result = await step.do(
          stepName,
          {
            retries: { limit: 1, delay: "0 ms", backoff: "constant" },
          },
          async (tx): Promise<CommandStepResult> => {
            tx.mutate(({ forSchema }) => {
              const uow = forSchema(piSchema);
              uow.update("session", event.instanceId, (builder) =>
                builder.set({
                  status: command.kind === "complete" ? "complete" : "active",
                  updatedAt: uow.now(),
                }),
              );
            });

            if (!canRunCommand(command, status)) {
              return { type: "noop" };
            }

            if (command.kind === "complete") {
              return { type: "complete" };
            }

            if (command.kind === "abort") {
              return { type: "noop" };
            }

            const mode = toRunMode(command);
            const runAgent = options.agentRunner ?? runAgentTurn;
            const messagesBeforeStep = messages.length;
            const result = await runAgent({
              mode,
              promptInput: toPromptInput(command),
              params,
              agent: agentDefinition,
              tools: options.tools,
              messages,
              turnId: `${event.instanceId}:${turn}`,
              onController: (controller) => {
                tx.onEvent("command", (event) => {
                  const message = commandPayloadSchema.parse(event.payload ?? {});
                  if (message.kind === "abort") {
                    controller.abort();
                    event.consume();
                  }
                  if (message.kind === "steer") {
                    controller.steer(message.input);
                    event.consume();
                  }
                });
              },
              onEvent: async (agentEvent) => {
                PiLogger.debug("agent event observed before workflow tx.emit", {
                  sessionId: params.sessionId,
                  turn,
                  ...describeAgentEvent(agentEvent),
                });
                tx.emit(agentEvent);
              },
            });

            tx.mutate(({ forSchema }) => {
              // This overwrites the earlier tx.mutate call
              const uow = forSchema(piSchema);
              uow.update("session", event.instanceId, (builder) =>
                builder.set({ status: "waiting", updatedAt: uow.now() }),
              );
            });

            return {
              type: "agent-run",
              outcome: result.outcome,
              messages: result.messages.slice(messagesBeforeStep),
              events: result.events.filter((agentEvent) => !isEphemeralAgentEvent(agentEvent)),
              errorMessage: result.errorMessage,
            };
          },
        );

        if (result.type === "complete") {
          return { messages };
        }

        if (result.type !== "agent-run") {
          continue;
        }

        messages = [...messages, ...result.messages];
        status = result.outcome === "errored" ? "waiting-to-continue" : "idle";
        if (status === "idle") {
          turn += 1;
        }
      }
    },
  );

export type PiWorkflowsRegistry = {
  agentLoop: ReturnType<typeof createPiAgentLoopWorkflow>;
};

export const createPiWorkflows = (options: WorkflowsOptions) => {
  PiLogger.reset();
  if (options.logging) {
    PiLogger.configure(options.logging);
    WorkflowsLogger.configure(options.logging);
  }

  return {
    agentLoop: createPiAgentLoopWorkflow(options),
  } satisfies WorkflowsRegistry;
};
