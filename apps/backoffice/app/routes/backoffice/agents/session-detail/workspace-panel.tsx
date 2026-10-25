import {
  ChatWorkspacePanel,
  ChatWorkspaceScroll,
} from "@fragno-private/design-system/chat-workspace-panel";

import { ResultContent } from "./result-content";
import type { SessionWorkspaceItem } from "./workspace-model";

export function SessionWorkspacePanel({
  item,
  onClose,
}: {
  item: SessionWorkspaceItem;
  onClose: () => void;
}) {
  return (
    <ChatWorkspacePanel
      label={item.label}
      toolbarRef={() => undefined}
      onClose={onClose}
      actions={null}
    >
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
