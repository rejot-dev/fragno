import { schedulePiOperationCompletedHook } from "@fragno-dev/pi-harness/harness/pi-operation-completed";
import {
  applyWorkflowAgentHarnessStepResult,
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type WorkflowAgentHarnessOptions,
} from "@fragno-dev/pi-harness/workflows/workflow-agent-harness";
import {
  isRemoteWorkflowSuspension,
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowStepHost,
} from "@fragno-dev/workflows/remote-workflow";
import type { TSchema } from "typebox";
import { z } from "zod";

import { AgentHarness, type AgentTool, type SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type {
  CodemodeWorkflowAgent,
  CodemodeWorkflowAgentToolDefinition,
  CodemodeWorkflowAgentToolExecutor,
  CodemodeWorkflowAgentToolResult,
} from "@/fragno/codemode/workflow-agent-rpc";
import type { JsonValue } from "@/lib/zod/json-value";

const workflowAgentToolDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

const workflowAgentPromptInputSchema = z.object({
  text: z.string().min(1),
  images: z
    .array(
      z.object({
        type: z.literal("image"),
        data: z.string().min(1),
        mimeType: z.string().min(1),
      }),
    )
    .optional(),
  tools: z.array(workflowAgentToolDefinitionSchema).max(32).optional(),
});

export type CreateCodemodeWorkflowAgentOptions = {
  workflowName: string;
  workflowInstanceId: string;
  createdAt: Date;
  actor: unknown;
  metadata: Record<string, unknown> | null;
  remote: RemoteWorkflowStepHost;
  resolveHarnessOptions: () => Promise<WorkflowAgentHarnessOptions>;
};

const assistantText = (message: AssistantMessage): string => {
  let text = "";
  for (const content of message.content) {
    if (content.type === "text") {
      text += content.text;
    }
  }
  return text.trim();
};

const toolResultsFromTranscript = (
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): CodemodeWorkflowAgentToolResult[] => {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionTreeEntry[] = [];
  let entry = leafId ? entriesById.get(leafId) : undefined;
  while (entry) {
    branch.unshift(entry);
    entry = entry.parentId ? entriesById.get(entry.parentId) : undefined;
  }

  const argumentsByToolCallId = new Map<string, unknown>();
  const results: CodemodeWorkflowAgentToolResult[] = [];
  for (const branchEntry of branch) {
    if (branchEntry.type !== "message") {
      continue;
    }
    if (branchEntry.message.role === "assistant") {
      for (const content of branchEntry.message.content) {
        if (content.type === "toolCall") {
          argumentsByToolCallId.set(content.id, content.arguments);
        }
      }
      continue;
    }
    if (branchEntry.message.role !== "toolResult") {
      continue;
    }

    const details = branchEntry.message.details as { result?: unknown } | undefined;
    results.push({
      toolCallId: branchEntry.message.toolCallId,
      toolName: branchEntry.message.toolName,
      arguments: argumentsByToolCallId.get(branchEntry.message.toolCallId),
      result: details?.result,
    });
  }
  return results;
};

export const serializeCodemodeWorkflowAgentToolResult = (result: unknown): string => {
  if (typeof result === "string") {
    return result;
  }
  try {
    const serialized = JSON.stringify(result);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to the JavaScript string representation for non-JSON values.
  }
  return String(result);
};

type CodemodeWorkflowAgentToolResultProjection = {
  text: string;
  persistedResult: JsonValue;
};

/** Projects one workflow tool result into transcript text and durable session/emission JSON. */
export const projectCodemodeWorkflowAgentToolResult = (
  result: unknown,
): CodemodeWorkflowAgentToolResultProjection => {
  if (typeof result === "string") {
    return { text: result, persistedResult: result };
  }

  try {
    const serialized = JSON.stringify(result);
    if (serialized !== undefined) {
      return {
        text: serialized,
        persistedResult: JSON.parse(serialized) as JsonValue,
      };
    }
  } catch {
    // Fall through to the transcript serializer for values JSON cannot represent.
  }

  const text = serializeCodemodeWorkflowAgentToolResult(result);
  return { text, persistedResult: text };
};

const assertUniqueToolNames = (tools: readonly CodemodeWorkflowAgentToolDefinition[]) => {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Workflow agent tool '${tool.name}' is defined more than once.`);
    }
    names.add(tool.name);
  }
};

const createWorkflowAgentTools = ({
  definitions,
  executor,
}: {
  definitions: readonly CodemodeWorkflowAgentToolDefinition[];
  executor: CodemodeWorkflowAgentToolExecutor;
}): AgentTool[] =>
  definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters as TSchema,
    execute: async (toolCallId, input) => {
      const toolResult = await executor.execute(definition.id, toolCallId, input);
      const projection = projectCodemodeWorkflowAgentToolResult(toolResult);
      return {
        content: [{ type: "text" as const, text: projection.text }],
        details: { result: projection.persistedResult },
      };
    },
  }));

export const createCodemodeWorkflowAgent = ({
  workflowName,
  workflowInstanceId,
  createdAt,
  actor,
  metadata,
  remote,
  resolveHarnessOptions,
}: CreateCodemodeWorkflowAgentOptions): CodemodeWorkflowAgent => {
  let sessionState = createPiHarnessSessionState({
    metadata: {
      id: workflowInstanceId,
      createdAt: createdAt.toISOString(),
    },
  });
  let activePromptName: string | null = null;

  return {
    prompt: async (parentScope, rawName, rawInput, toolExecutor) => {
      const name = z.string().trim().min(1).parse(rawName);
      const input = workflowAgentPromptInputSchema.parse(rawInput);
      const toolDefinitions = input.tools ?? [];
      assertUniqueToolNames(toolDefinitions);
      if (toolDefinitions.length > 0 && !toolExecutor) {
        throw new Error("WORKFLOW_AGENT_TOOL_EXECUTOR_REQUIRED");
      }
      if (activePromptName !== null) {
        throw new Error(
          `WORKFLOW_AGENT_CONCURRENT_PROMPT: Await '${activePromptName}' before starting '${name}'.`,
        );
      }

      activePromptName = name;
      try {
        const committedResult = await remote.do(
          parentScope,
          `pi prompt: ${name}`,
          undefined,
          async (tx, scope) => {
            const harnessOptions = await resolveHarnessOptions();
            const operationId = `${workflowInstanceId}:${scope.stepKey}`;
            const restored = restoreWorkflowBackedSession({
              operationId,
              state: sessionState,
              previousEmissions: await tx.previousEmissions(),
              models: harnessOptions.models,
            });
            const tools = toolExecutor
              ? createWorkflowAgentTools({
                  definitions: toolDefinitions,
                  executor: toolExecutor,
                })
              : [];
            const harness = new AgentHarness({ ...harnessOptions, ...restored.options, tools });

            return await withWorkflowAgentHarness({
              restored,
              harness,
              tx,
              runDurableStep: async () => ({
                assistant: await harness.prompt(
                  input.text,
                  input.images ? { images: input.images } : undefined,
                ),
              }),
              onTerminalOutcome: ({ operationEntries }) => {
                schedulePiOperationCompletedHook({
                  tx,
                  actor,
                  workflowName,
                  sessionId: workflowInstanceId,
                  metadata,
                  stepName: name,
                  operationId,
                  operation: "prompt",
                  operationEntries,
                });
              },
            });
          },
        );

        if (isRemoteWorkflowSuspension(committedResult)) {
          throw new RemoteWorkflowSuspendedError(committedResult.reason);
        }

        sessionState = applyWorkflowAgentHarnessStepResult(sessionState, committedResult);
        const toolResults = toolResultsFromTranscript(
          committedResult.appendedEntries,
          committedResult.leafId,
        );

        if (committedResult.outcome === "aborted") {
          return {
            text: "",
            stopReason: "aborted",
            leafId: committedResult.leafId,
            toolResults,
          };
        }

        return {
          text: assistantText(committedResult.value.assistant),
          stopReason: committedResult.value.assistant.stopReason,
          leafId: committedResult.leafId,
          toolResults,
        };
      } finally {
        activePromptName = null;
      }
    },
  };
};
