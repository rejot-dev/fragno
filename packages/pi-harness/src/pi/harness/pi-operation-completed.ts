import type { WorkflowStepTx } from "@fragno-dev/workflows/workflow";

import type { HandlerTxContext } from "@fragno-dev/db";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { piSchema } from "../../schema";
import type { PiHarnessHooksMap } from "../definition";
import type { PiOperationCompletedHookPayload } from "../types";

const assistantMessagesFromEntries = (entries: readonly SessionTreeEntry[]): AssistantMessage[] =>
  entries.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
  );

const modelCallsFromEntries = (
  entries: readonly SessionTreeEntry[],
): PiOperationCompletedHookPayload["modelCalls"] =>
  assistantMessagesFromEntries(entries).map((message) => ({
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
    stopReason: message.stopReason,
    timestamp: message.timestamp,
  }));

const aggregateModelCallUsage = (
  modelCalls: PiOperationCompletedHookPayload["modelCalls"],
): AssistantMessage["usage"] =>
  modelCalls.reduce<AssistantMessage["usage"]>(
    (total, modelCall) => ({
      input: total.input + modelCall.usage.input,
      output: total.output + modelCall.usage.output,
      cacheRead: total.cacheRead + modelCall.usage.cacheRead,
      cacheWrite: total.cacheWrite + modelCall.usage.cacheWrite,
      totalTokens: total.totalTokens + modelCall.usage.totalTokens,
      cost: {
        input: total.cost.input + modelCall.usage.cost.input,
        output: total.cost.output + modelCall.usage.cost.output,
        cacheRead: total.cost.cacheRead + modelCall.usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + modelCall.usage.cost.cacheWrite,
        total: total.cost.total + modelCall.usage.cost.total,
      },
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  );

export type CreatePiOperationCompletedPayloadOptions = Pick<
  PiOperationCompletedHookPayload,
  "actor" | "workflowName" | "sessionId" | "metadata" | "stepName" | "operationId" | "operation"
> & {
  operationEntries: readonly SessionTreeEntry[];
};

export const createPiOperationCompletedPayload = (
  options: CreatePiOperationCompletedPayloadOptions,
): PiOperationCompletedHookPayload | undefined => {
  const modelCalls = modelCallsFromEntries(options.operationEntries);
  if (modelCalls.length === 0) {
    return undefined;
  }

  return {
    actor: options.actor,
    workflowName: options.workflowName,
    sessionId: options.sessionId,
    metadata: options.metadata,
    stepName: options.stepName,
    operationId: options.operationId,
    operation: options.operation,
    modelCalls,
    usage: aggregateModelCallUsage(modelCalls),
  };
};

export type SchedulePiOperationCompletedHookOptions = CreatePiOperationCompletedPayloadOptions & {
  tx: Pick<WorkflowStepTx<PiHarnessHooksMap>, "mutate" | "onTerminalError">;
};

export const schedulePiOperationCompletedHook = (
  options: SchedulePiOperationCompletedHookOptions,
): void => {
  const payload = createPiOperationCompletedPayload(options);
  if (!payload) {
    return;
  }

  const triggerHook = ({ forSchema }: HandlerTxContext<PiHarnessHooksMap>) => {
    forSchema(piSchema).triggerHook("onOperationCompleted", payload);
  };

  // Workflow callbacks may run more than once before their step commits. Register both outcomes on
  // every call so the hook follows whichever transaction path eventually becomes durable.
  options.tx.mutate(triggerHook);
  options.tx.onTerminalError.mutate(triggerHook);
};
