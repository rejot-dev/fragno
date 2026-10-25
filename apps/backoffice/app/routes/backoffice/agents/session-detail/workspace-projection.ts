import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";

import {
  normalizePiContent,
  type PiConversationMessage,
  type PiDraftAgentMessage,
  type PiDraftTool,
  type ToolResultMessage,
} from "./assistant-runtime";
import { getCodemodeResultDetails, isCodemodeTool } from "./codemode-result";
import { getCodeArgumentSource } from "./tool-arguments";
import { projectWorkflowGraph } from "./workflow-graph-projection";
import {
  generatedUiWorkspaceId,
  type SessionWorkspaceItem,
  workflowGraphWorkspaceId,
} from "./workspace-model";

export function getSessionWorkflowRunIds({
  draftAgentMessage,
  messages,
}: {
  draftAgentMessage: PiDraftAgentMessage | null;
  messages: readonly PiConversationMessage[];
}): string[] {
  const runIds = new Set<string>();
  const addRun = (resultMessage: ToolResultMessage | null) => {
    const run = getCodemodeResultDetails(resultMessage?.details).run;
    if (run) {
      runIds.add(run.instanceId);
    }
  };

  for (const message of messages) {
    if (message.role === "toolResult" && isCodemodeTool(message.toolName)) {
      addRun(message);
    }
  }
  for (const draftTool of Object.values(draftAgentMessage?.tools ?? {})) {
    if (isCodemodeTool(draftTool.name)) {
      addRun(completedDraftToolResult(draftTool));
    }
  }

  return [...runIds];
}

export function projectSessionWorkspaceItems({
  draftAgentMessage,
  messages,
  startedWorkflowRunIds,
}: {
  draftAgentMessage: PiDraftAgentMessage | null;
  messages: readonly PiConversationMessage[];
  startedWorkflowRunIds: ReadonlySet<string>;
}): SessionWorkspaceItem[] {
  const items: SessionWorkspaceItem[] = [];
  const projectedItemIds = new Set<string>();
  const draftTools = Object.values(draftAgentMessage?.tools ?? {});
  const draftToolsByCallId = new Map(draftTools.map((tool) => [tool.id, tool]));
  const completedResultsByCallId = new Map(
    messages.flatMap(
      (message): Array<[string, ToolResultMessage]> =>
        message.role === "toolResult" && isCodemodeTool(message.toolName)
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
    run: ReturnType<typeof getCodemodeResultDetails>["run"];
    toolCallId: string;
  }) => {
    const id = workflowGraphWorkspaceId(toolCallId);
    if (projectedItemIds.has(id) || !run || !startedWorkflowRunIds.has(run.instanceId)) {
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
    if (!isCodemodeTool(resultMessage.toolName) || resultMessage.isError) {
      return;
    }

    const id = generatedUiWorkspaceId(resultMessage.toolCallId);
    if (projectedItemIds.has(id)) {
      return;
    }

    const details = getCodemodeResultDetails(resultMessage.details);
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
        if (block.type !== "toolCall" || !isCodemodeTool(block.name)) {
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
          run: getCodemodeResultDetails(latestResult?.details).run,
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
    if (!isCodemodeTool(draftTool.name)) {
      continue;
    }
    const resultMessage = completedDraftToolResult(draftTool);
    appendWorkflowGraph({
      args: draftTool.args,
      argsText: draftTool.argsText,
      complete: draftTool.status === "done",
      run: getCodemodeResultDetails(resultMessage?.details).run,
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

function completedDraftToolResult(draftTool: PiDraftTool): ToolResultMessage | null {
  return draftTool.resultMessage ? draftTool.resultMessage : null;
}
