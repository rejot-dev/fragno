import type { WorkflowDuration, WorkflowStep } from "@fragno-dev/workflows/workflow";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { PiHarnessHooksMap } from "../definition";
import { createAgentLoop, type AgentLoopOptions } from "../harness/commands";

const WAIT_FOR_COMMAND_TIMEOUT = "1 hour" as const;
export const INTERACTIVE_CHAT_WORKFLOW_NAME = "interactive-chat-workflow";
const DEFAULT_HARNESS_NAME = "default";

export type InteractiveChatWorkflowParams = {
  harnessName?: string;
  /** Opaque workflow-owned value forwarded to operation completion hooks. */
  actor?: unknown;
  model?: Model<Api>;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  initialMessages?: AgentMessage[];
};

type InteractiveChatHarnessOptions<TTools extends readonly AgentTool[]> = Omit<
  AgentLoopOptions<TTools>,
  "workflowName" | "sessionId" | "agentName" | "initialMessages" | "commandTimeout"
>;

export type InteractiveChatHarnesses<TTools extends readonly AgentTool[] = readonly AgentTool[]> =
  Record<string, InteractiveChatHarnessOptions<TTools>>;

export type InteractiveChatResolvedHarness<
  TTools extends readonly AgentTool[] = readonly AgentTool[],
> = Partial<InteractiveChatHarnessOptions<TTools>> & {
  harnessName?: string;
};

export type InteractiveChatResolveHarnessContext = {
  workflowName: string;
  sessionId: string;
};

type MaybePromise<T> = T | Promise<T>;

export type CreateInteractiveChatWorkflowOptions<
  TTools extends readonly AgentTool[] = readonly AgentTool[],
> = {
  name?: string;
  commandTimeout?: WorkflowDuration;
  harnesses?: InteractiveChatHarnesses<TTools>;
  resolveHarness?: (
    params: InteractiveChatWorkflowParams,
    context: InteractiveChatResolveHarnessContext,
  ) => MaybePromise<InteractiveChatResolvedHarness<TTools> | undefined>;
};

const textContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});

const imageContentSchema = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

const thinkingContentSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});

const toolCallSchema = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
});

const usageSchema = z.looseObject({
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
});

const agentMessageShapeSchema = z.discriminatedUnion("role", [
  z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([textContentSchema, imageContentSchema]))]),
    timestamp: z.number(),
  }),
  z.looseObject({
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
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([textContentSchema, imageContentSchema])),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

const agentMessageSchema = agentMessageShapeSchema as z.ZodType<AgentMessage>;

const modelSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  api: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  contextWindow: z.number(),
  maxTokens: z.number(),
}) as z.ZodType<Model<Api>>;

const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

export const interactiveChatWorkflowParamsSchema: z.ZodType<InteractiveChatWorkflowParams> =
  z.object({
    harnessName: z.string().optional(),
    actor: z.unknown().optional(),
    model: modelSchema.optional(),
    systemPrompt: z.string().optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    initialMessages: z.array(agentMessageSchema).optional(),
  });

export const createInteractiveChatWorkflow = <
  TTools extends readonly AgentTool[] = readonly AgentTool[],
>(
  options: CreateInteractiveChatWorkflowOptions<TTools> = {},
) => {
  const workflowName = options.name ?? INTERACTIVE_CHAT_WORKFLOW_NAME;
  const commandTimeout = options.commandTimeout ?? WAIT_FOR_COMMAND_TIMEOUT;

  return defineWorkflow(
    {
      name: workflowName,
      schema: interactiveChatWorkflowParamsSchema,
    },
    async (event, step: WorkflowStep<PiHarnessHooksMap>) => {
      const params = interactiveChatWorkflowParamsSchema.parse(event.payload ?? {});
      const requestedHarnessName = params.harnessName ?? DEFAULT_HARNESS_NAME;
      const harnesses = options.harnesses ?? {};
      const resolvedHarness = await options.resolveHarness?.(params, {
        workflowName,
        sessionId: event.instanceId,
      });
      const harnessName = resolvedHarness?.harnessName ?? requestedHarnessName;
      const harnessOptions = harnesses[harnessName];

      if (!harnessOptions && !resolvedHarness) {
        throw new Error(`Harness ${harnessName} not found.`);
      }

      const model = resolvedHarness?.model ?? params.model ?? harnessOptions?.model;
      if (!model) {
        throw new Error("INTERACTIVE_CHAT_MODEL_REQUIRED");
      }

      const resources = resolvedHarness?.resources
        ? { ...harnessOptions?.resources, ...resolvedHarness.resources }
        : harnessOptions?.resources;
      const streamOptions = resolvedHarness?.streamOptions
        ? { ...harnessOptions?.streamOptions, ...resolvedHarness.streamOptions }
        : harnessOptions?.streamOptions;

      const commandLoop = createAgentLoop(step, {
        ...harnessOptions,
        ...resolvedHarness,
        workflowName,
        sessionId: event.instanceId,
        agentName: harnessName,
        actor: params.actor,
        model,
        systemPrompt:
          resolvedHarness?.systemPrompt ?? params.systemPrompt ?? harnessOptions?.systemPrompt,
        thinkingLevel:
          resolvedHarness?.thinkingLevel ?? params.thinkingLevel ?? harnessOptions?.thinkingLevel,
        resources,
        streamOptions,
        initialMessages: params.initialMessages,
        commandTimeout,
      });

      while (true) {
        await commandLoop.waitForCommandAndRunStep();
      }
    },
  );
};
