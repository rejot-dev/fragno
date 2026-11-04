import { ResultContent } from "@fragno-private/backoffice-chat/tools/result-content";
import type { SessionWorkspaceItem } from "@fragno-private/backoffice-chat/workspace/workspace-model";
import {
  ChatWorkspacePanel,
  ChatWorkspaceScroll,
} from "@fragno-private/design-system/agents/chat-workspace-panel";

export function SessionWorkspacePanel({
  item,
  onClose,
}: {
  item: SessionWorkspaceItem;
  onClose: () => void;
}) {
  return (
    <ChatWorkspacePanel label={item.label} onClose={onClose}>
      <ChatWorkspaceScroll>
        <ResultContent
          parsedValue={{ kind: "valid", value: item.view.result }}
          showRawValue={false}
          value={item.view.rawValue}
        >
          {null}
        </ResultContent>
      </ChatWorkspaceScroll>
    </ChatWorkspacePanel>
  );
}
