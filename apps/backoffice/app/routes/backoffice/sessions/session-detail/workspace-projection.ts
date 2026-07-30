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
import { generatedUiTabId, type SessionWorkspaceTab, workflowGraphTabId } from "./workspace-model";

export function projectSessionWorkspaceTabs({
  draftAgentMessage,
  messages,
}: {
  draftAgentMessage: DraftAgentMessage | null;
  messages: readonly AgentMessage[];
}): SessionWorkspaceTab[] {
  const tabs: SessionWorkspaceTab[] = [];
  const projectedTabIds = new Set<string>();
  const draftTools = Object.values(draftAgentMessage?.tools ?? {});
  const draftToolsByCallId = new Map(draftTools.map((tool) => [tool.id, tool]));

  const appendWorkflowGraph = ({
    args,
    argsText,
    complete,
    toolCallId,
  }: {
    args: unknown;
    argsText?: string;
    complete: boolean;
    toolCallId: string;
  }) => {
    const id = workflowGraphTabId(toolCallId);
    if (projectedTabIds.has(id)) {
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

    projectedTabIds.add(id);
    tabs.push({
      id,
      toolCallId,
      label: projection.title,
      view: { type: "workflow-graph", projection },
    });
  };

  const appendGeneratedUi = (resultMessage: ToolResultMessage) => {
    if (resultMessage.toolName !== "execCodeMode" || resultMessage.isError) {
      return;
    }

    const id = generatedUiTabId(resultMessage.toolCallId);
    if (projectedTabIds.has(id)) {
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

    projectedTabIds.add(id);
    tabs.push({
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
        appendWorkflowGraph({
          args: draftTool?.args ?? block.arguments,
          argsText: draftTool?.argsText,
          complete: draftTool ? draftTool.status === "done" : true,
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
    appendWorkflowGraph({
      args: draftTool.args,
      argsText: draftTool.argsText,
      complete: draftTool.status === "done",
      toolCallId: draftTool.id,
    });
    const resultMessage = completedDraftToolResult(draftTool);
    if (resultMessage) {
      appendGeneratedUi(resultMessage);
    }
  }

  let interfaceIndex = 0;
  return tabs.map((tab) => {
    if (tab.view.type !== "generated-ui") {
      return tab;
    }
    interfaceIndex += 1;
    return { ...tab, label: `Interface ${interfaceIndex}` };
  });
}

function completedDraftToolResult(draftTool: DraftTool): ToolResultMessage | null {
  return draftTool.resultMessage ? (draftTool.resultMessage as ToolResultMessage) : null;
}
