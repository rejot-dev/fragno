import { z } from "zod";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { piSchema } from "../../schema";
import { definePiWorkflow } from "../dsl";
import type { PiPromptInput, PiSessionCommandPayload } from "../types";
import type { PiAgentRunMode } from "../workflow/agent-runner";
import type { PiAgentStepResult } from "../workflow/pi-agent-step";

const WAIT_FOR_COMMAND_TIMEOUT = "1 hour" as const;

type TurnStatus = "idle" | "waiting-to-continue";

type InteractiveChatWorkflowParams = {
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    textSignature: z.string().optional(),
  })
  .passthrough();

const imageContentSchema = z
  .object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
  })
  .passthrough();

const thinkingContentSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    thinkingSignature: z.string().optional(),
    redacted: z.boolean().optional(),
  })
  .passthrough();

const toolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    thoughtSignature: z.string().optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    cost: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      total: z.number(),
    }),
  })
  .passthrough();

const agentMessageShapeSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(z.union([textContentSchema, imageContentSchema]))]),
      timestamp: z.number(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(z.union([textContentSchema, thinkingContentSchema, toolCallSchema])),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      responseModel: z.string().optional(),
      responseId: z.string().optional(),
      diagnostics: z.array(z.unknown()).optional(),
      usage: usageSchema,
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
      errorMessage: z.string().optional(),
      timestamp: z.number(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("toolResult"),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(z.union([textContentSchema, imageContentSchema])),
      details: z.unknown().optional(),
      isError: z.boolean(),
      timestamp: z.number(),
    })
    .passthrough(),
]);

const agentMessageSchema = z.custom<AgentMessage>(
  (value) => agentMessageShapeSchema.safeParse(value).success,
);

export const interactiveChatWorkflowParamsSchema: z.ZodType<InteractiveChatWorkflowParams> =
  z.object({
    agentName: z.string(),
    systemPrompt: z.string().optional(),
    initialMessages: z.array(agentMessageSchema).optional(),
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

type CommandStepResult = PiAgentStepResult | { type: "noop" } | { type: "complete" };

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

export const interactiveChatWorkflow = definePiWorkflow(
  {
    name: "interactive-chat-workflow",
    schema: interactiveChatWorkflowParamsSchema,
  },
  async (ctx) => {
    const params = interactiveChatWorkflowParamsSchema.parse(ctx.params ?? {});
    let commandIndex = 0;
    let turn = 0;
    let status: TurnStatus = "idle";
    let messages = Array.isArray(params.initialMessages) ? params.initialMessages : [];

    while (true) {
      const receivedCommand = commandPayloadSchema.parse(
        await ctx.waitForEvent(waitStepName(commandIndex), {
          timeout: WAIT_FOR_COMMAND_TIMEOUT,
        }),
      );

      const command =
        receivedCommand.kind === "steer"
          ? ({ ...receivedCommand, kind: "followUp" } as const)
          : receivedCommand;
      const stepName = commandStepName(commandIndex, command.kind);
      commandIndex += 1;

      const commandRunsAgent =
        canRunCommand(command, status) && command.kind !== "complete" && command.kind !== "abort";

      let result: CommandStepResult;
      if (commandRunsAgent) {
        result = await ctx.agent(params.agentName).run(stepName, {
          mode: toRunMode(command),
          input: toPromptInput(command),
          messages,
          systemPrompt: params.systemPrompt,
          turnId: `${ctx.sessionId}:${turn}`,
        });
      } else {
        result = await ctx.step.do(
          stepName,
          {
            retries: { limit: 1, delay: "0 ms", backoff: "constant" },
          },
          (tx) => {
            tx.mutate(({ forSchema }) => {
              const uow = forSchema(piSchema);
              uow.update("session", ctx.sessionId, (builder) =>
                builder.set({
                  status: command.kind === "complete" ? "complete" : "active",
                  updatedAt: uow.now(),
                }),
              );
            });

            if (command.kind === "complete") {
              return { type: "complete" };
            }

            return { type: "noop" };
          },
        );
      }

      if (result.type === "complete") {
        return { messages };
      }

      if (result.type !== "agent-run") {
        continue;
      }

      messages = [...messages, ...result.messages];
      status = result.stopReason === "error" ? "waiting-to-continue" : "idle";
      if (status === "idle") {
        turn += 1;
      }
    }
  },
);
