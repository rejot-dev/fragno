import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";

import type {
  PiConversationMessage,
  PiDraftAgentMessage,
  ToolResultMessage,
} from "./assistant-runtime";
import { getCodemodeResultDetails, isCodemodeTool } from "./codemode-result";
import { generatedUiWorkspaceId, type SessionWorkspaceItem } from "./workspace-model";

export function projectSessionWorkspaceItems({
  draftAgentMessage,
  messages,
}: {
  draftAgentMessage: PiDraftAgentMessage | null;
  messages: readonly PiConversationMessage[];
}): SessionWorkspaceItem[] {
  const items: SessionWorkspaceItem[] = [];
  const projectedItemIds = new Set<string>();

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
      label: `Interface ${items.length + 1}`,
      view: {
        type: "generated-ui",
        result: parsedResult.value,
        rawValue: details.result,
      },
    });
  };

  for (const message of messages) {
    if (message.role === "toolResult") {
      appendGeneratedUi(message);
    }
  }
  for (const draftTool of Object.values(draftAgentMessage?.tools ?? {})) {
    if (isCodemodeTool(draftTool.name) && draftTool.resultMessage) {
      appendGeneratedUi(draftTool.resultMessage);
    }
  }

  return items;
}
