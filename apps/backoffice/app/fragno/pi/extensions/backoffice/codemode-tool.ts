import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { formatCodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import { Type } from "typebox";

import { copyJson } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";

import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { AutomationWorkflowRuntimeRequestError } from "@/fragno/automation/workflow-route-runtime";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import { inlineWorkflowProgram } from "@/fragno/codemode/workflow-program";
import {
  requirePiStateBackend,
  type BackofficeAgentContext,
} from "@/fragno/pi/agent/backoffice-agent-context";
import type {
  InternalAutomationWorkflowRuntime,
  WorkflowCreateInstanceResult,
} from "@/fragno/runtime-tools/families/automations-workflow";
import { createViewedImages, type ImageViewer } from "@/fragno/runtime-tools/families/image-viewer";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import {
  runtimeToolFamilies,
  type CoreBackofficeToolContext,
} from "@/fragno/runtime-tools/tool-families";

import { codemodeCallsDetail } from "./codemode-call-details";
import { fitCodemodeOutput } from "./codemode-output";

export const codemodeParametersSchema = Type.Object({
  code: Type.String({
    minLength: 1,
    description:
      "One top-level codemode program: an async arrow function for immediate work or defineWorkflow(...) for durable work.",
  }),
  dependencies: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), {
      description:
        "npm package names mapped to versions or version ranges. Import packages by their normal unversioned names in code.",
    }),
  ),
});

/** The context with `viewer` in every scope it reaches, so a program can view another scope's images. */
function withImageViewer(
  context: CoreBackofficeToolContext,
  viewer: ImageViewer,
): CoreBackofficeToolContext {
  return {
    ...context,
    runtimes: { ...context.runtimes, imageViewer: viewer },
    createScopedContext: (scope) => withImageViewer(context.createScopedContext(scope), viewer),
  };
}

const hashToolCallId = (toolCallId: string) => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < toolCallId.length; index += 1) {
    const char = toolCallId.charCodeAt(index);
    first = Math.imul(first ^ char, 0x01000193);
    second = Math.imul(second ^ char, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const formatCodemodeText = (result: BackofficeCodemodeExecuteResult, jsonIndent: 0 | 2) => {
  const lines: string[] = [];
  const logs = result.logs ?? [];
  lines.push(...logs.map(formatCodemodeLogLine));

  if (result.error) {
    lines.push(result.error);
    if (result.errorDetails && (result.errorDetails.details || result.errorDetails.metadata)) {
      lines.push(
        `Diagnostics: ${JSON.stringify({
          details: result.errorDetails.details,
          metadata: result.errorDetails.metadata,
        })}`,
      );
    }
    return lines.join("\n");
  }

  if (result.result === undefined) {
    return lines.join("\n");
  }

  lines.push(
    typeof result.result === "string"
      ? result.result
      : (JSON.stringify(result.result, null, jsonIndent) ?? ""),
  );
  return lines.join("\n");
};

type WorkflowScheduleErrorDetails = {
  status: number | null;
  code: string;
  message: string;
  requiredPermission: BackofficePermissionRequirement | null;
};

function serializeWorkflowScheduleError(cause: unknown): WorkflowScheduleErrorDetails {
  if (AutomationWorkflowRuntimeRequestError.is(cause)) {
    return {
      status: cause.status,
      code: cause.code,
      message: cause.message,
      requiredPermission: cause.requiredPermission,
    };
  }

  return {
    status: null,
    code: "WORKFLOW_SCHEDULING_FAILED",
    message: cause instanceof Error ? cause.message : String(cause),
    requiredPermission: null,
  };
}

export function createCodemodeTool(agent: BackofficeAgentContext) {
  return defineTool({
    name: "codemode",
    description:
      "Execute one top-level codemode program against the current Backoffice context. Output over 50 KB or 2000 lines shows its beginning and end; the full output is saved to the file the notice names.",
    parameters: codemodeParametersSchema,
    // Codemode can execute arbitrary mutations. An interrupted call must not silently repeat them.
    replay: "unsafe",
    async execute(params, api, durableContext) {
      const turn = await agent.activeTurn(api.conversationId, durableContext);
      await turn.authorize();
      const { code, dependencies } = params;
      if (durableContext.abortSignal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      const taskId = String(api.taskId);
      const runtimeToolContext = turn.toolContext(
        `${agent.agentName}:${taskId}`,
        api.callId,
        durableContext,
      );
      const workflowRuntime = runtimeToolContext.workflow?.runtime;
      const workflowScheduler =
        workflowRuntime && "createInternalInstance" in workflowRuntime
          ? (workflowRuntime as Pick<InternalAutomationWorkflowRuntime, "createInternalInstance">)
          : undefined;
      const viewedImages = createViewedImages();
      const toolContext = withImageViewer(
        createBackofficeToolContext({
          ...runtimeToolContext,
          workflow: workflowRuntime ? { runtime: workflowRuntime } : null,
        }),
        viewedImages.viewer,
      );

      if (turn.codemode === null) {
        throw new Error("Pi codemode is unavailable because the Worker Loader is not configured.");
      }
      const startedAt = Date.now();
      const result = await runBackofficeCodemode({
        codemode: turn.codemode,
        code,
        dependencies,
        families: runtimeToolFamilies,
        toolContext,
        // The harness paces these commits, so a burst of calls costs a few writes. A call that
        // settles after the run ended finds the invocation over, which rejects the update.
        onToolCalls: (calls) => {
          api
            .details({ calls: codemodeCallsDetail(calls, startedAt) }, durableContext)
            .catch(() => {});
        },
      });

      // Scheduling failures are failed tool results, but still carry the authored workflow for the viewer.
      let scheduleError: WorkflowScheduleErrorDetails | undefined;
      // The scheduled run's handle, surfaced to the client so the workflow viewer
      // can subscribe to its live progress (history/status + step emissions).
      let runHandle: WorkflowCreateInstanceResult | undefined;
      if (result.workflowDefinition) {
        if (!workflowScheduler) {
          scheduleError = {
            status: null,
            code: "WORKFLOW_SCHEDULER_UNAVAILABLE",
            message: "codemode workflow definition cannot be scheduled in this runtime.",
            requiredPermission: null,
          };
        } else {
          try {
            const instanceId = hashToolCallId(`${agent.agentName}--${taskId}`);
            const prepared = prepareCodemodeWorkflowInstance({
              program: inlineWorkflowProgram({
                filename: `/pi/${agent.agentName}/${taskId}.workflow.js`,
                code,
                modules: result.modules,
              }),
              dependencies,
              instanceId,
            });
            if (prepared.remoteWorkflowName !== result.workflowDefinition.name) {
              throw new Error(
                `Codemode program '${prepared.program.filename}' declares workflow '${prepared.remoteWorkflowName}', expected '${result.workflowDefinition.name}'.`,
              );
            }
            const workflowInput = createCodemodeWorkflowInstanceInput({
              prepared,
              trigger: { type: "manual", payload: {} },
              execution: turn.execution,
              replyTo: { kind: "agent", scope: agent.scope, agentName: agent.agentName },
            });
            const created = await workflowScheduler.createInternalInstance(workflowInput);
            runHandle = { instanceId: created.instanceId };
            result.result = runHandle;
          } catch (error) {
            scheduleError = serializeWorkflowScheduleError(error);
          }
        }
      }

      // The renderer would only show the user an invalid interface; the agent must see why.
      const generatedUi = parseBackofficeUiResult(result.result);
      const generatedUiError =
        generatedUi.kind === "invalid" ? `Generated UI is invalid: ${generatedUi.message}` : null;

      const renderText = (jsonIndent: 0 | 2) =>
        [
          formatCodemodeText(result, jsonIndent),
          ...(scheduleError ? [`Workflow could not be scheduled: ${scheduleError.message}`] : []),
          ...(generatedUiError ? [generatedUiError] : []),
        ].join("\n\n");
      const output = await fitCodemodeOutput({
        text: renderText(0),
        fullText: () => renderText(2),
        path: `/workspace/.pi/${agent.agentName}/outputs/${taskId}.txt`,
        state: requirePiStateBackend(runtimeToolContext),
      });
      // Overflowing logs and results stay in the saved file rather than in the session history; the
      // session view still renders generated interfaces from the result.
      const overflowed = output.fullOutputPath !== null;

      const { toolCalls, ...execution } = result;
      // Execution failures are tool results: throwing here would discard their diagnostics and run ID.
      return {
        // Images a program viewed before it failed still reach the model.
        output: [{ type: "text", text: output.text }, ...viewedImages.images],
        isError: Boolean(result.error || scheduleError || generatedUiError),
        details: copyJson(
          {
            ...execution,
            calls: codemodeCallsDetail(toolCalls, startedAt),
            // Session history keeps display text; structured lines stay on the codemode run.
            logs: overflowed ? undefined : result.logs?.map(formatCodemodeLogLine),
            result: overflowed && generatedUi.kind === "ordinary" ? undefined : result.result,
            code,
            fullOutputPath: output.fullOutputPath,
            // The live run handle so the client can
            // subscribe to realtime progress. Absent when scheduling failed.
            ...(runHandle ? { run: runHandle } : {}),
            ...(scheduleError ? { scheduleError } : {}),
          },
          { omitUndefinedProperties: true },
        ),
      };
    },
  });
}
