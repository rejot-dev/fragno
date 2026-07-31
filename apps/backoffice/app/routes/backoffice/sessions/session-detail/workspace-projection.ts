import type {
  DraftAgentMessage,
  DraftTool,
} from "@fragno-dev/pi-harness/workflow-session-projection";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import { normalizePiContent, type ToolResultMessage } from "./assistant-runtime";
import { getExecCodeModeResultDetails } from "./exec-code-mode";
import { getCodeArgumentSource } from "./tool-arguments";
import { projectWorkflowGraph } from "./workflow-graph-projection";
import {
  generatedUiWorkspaceId,
  type SessionWorkspaceItem,
  workflowGraphWorkspaceId,
} from "./workspace-model";

export function projectSessionWorkspaceItems({
  draftAgentMessage,
  messages,
}: {
  draftAgentMessage: DraftAgentMessage | null;
  messages: readonly AgentMessage[];
}): SessionWorkspaceItem[] {
  const items: SessionWorkspaceItem[] = [];
  const projectedItemIds = new Set<string>();
  const draftTools = Object.values(draftAgentMessage?.tools ?? {});
  const draftToolsByCallId = new Map(draftTools.map((tool) => [tool.id, tool]));
  const completedResultsByCallId = new Map(
    messages.flatMap(
      (message): Array<[string, ToolResultMessage]> =>
        message.role === "toolResult" && message.toolName === "execCodeMode"
          ? [[message.toolCallId, message]]
          : [],
    ),
  );

  const appendWorkflowGraph = ({
    args,
    argsText,
    complete,
    run,
    toolCallId,
  }: {
    args: unknown;
    argsText?: string;
    complete: boolean;
    run: ReturnType<typeof getExecCodeModeResultDetails>["run"];
    toolCallId: string;
  }) => {
    const id = workflowGraphWorkspaceId(toolCallId);
    if (projectedItemIds.has(id)) {
      return;
    }

    const source = getCodeArgumentSource({ rawText: argsText, value: args });
    if (!source) {
      return;
    }

    const projection = projectWorkflowGraph({ complete, source, toolCallId });
    if (!projection) {
      return;
    }

    projectedItemIds.add(id);
    items.push({
      id,
      toolCallId,
      label: projection.title,
      view: { type: "workflow-graph", projection, run },
    });
  };

  const appendGeneratedUi = (resultMessage: ToolResultMessage) => {
    if (resultMessage.toolName !== "execCodeMode" || resultMessage.isError) {
      return;
    }

    const id = generatedUiWorkspaceId(resultMessage.toolCallId);
    if (projectedItemIds.has(id)) {
      return;
    }

    const details = getExecCodeModeResultDetails(resultMessage.details);
    if (!details.hasResult) {
      return;
    }

    const parsedResult = parseBackofficeUiResult(details.result);
    if (parsedResult.kind !== "valid") {
      return;
    }

    projectedItemIds.add(id);
    items.push({
      id,
      toolCallId: resultMessage.toolCallId,
      label: "Interface",
      view: {
        type: "generated-ui",
        result: parsedResult.value,
        rawValue: details.result,
      },
    });
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of normalizePiContent(message.content)) {
        if (block.type !== "toolCall" || block.name !== "execCodeMode") {
          continue;
        }
        const draftTool = draftToolsByCallId.get(block.id);
        const latestResult =
          (draftTool ? completedDraftToolResult(draftTool) : null) ??
          completedResultsByCallId.get(block.id);
        appendWorkflowGraph({
          args: draftTool?.args ?? block.arguments,
          argsText: draftTool?.argsText,
          complete: draftTool ? draftTool.status === "done" : true,
          run: getExecCodeModeResultDetails(latestResult?.details).run,
          toolCallId: block.id,
        });
      }
      continue;
    }

    if (message.role === "toolResult") {
      appendGeneratedUi(message);
    }
  }

  for (const draftTool of draftTools) {
    if (draftTool.name !== "execCodeMode") {
      continue;
    }
    const resultMessage = completedDraftToolResult(draftTool);
    appendWorkflowGraph({
      args: draftTool.args,
      argsText: draftTool.argsText,
      complete: draftTool.status === "done",
      run: getExecCodeModeResultDetails(resultMessage?.details).run,
      toolCallId: draftTool.id,
    });
    if (resultMessage) {
      appendGeneratedUi(resultMessage);
    }
  }

  let interfaceIndex = 0;
  return items.map((item) => {
    if (item.view.type !== "generated-ui") {
      return item;
    }
    interfaceIndex += 1;
    return { ...item, label: `Interface ${interfaceIndex}` };
  });
}

function completedDraftToolResult(draftTool: DraftTool): ToolResultMessage | null {
  return draftTool.resultMessage ? (draftTool.resultMessage as ToolResultMessage) : null;
}
