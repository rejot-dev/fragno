import { ChatArtifactToggle } from "@fragno-private/design-system/chat-activity";
import type { IconName } from "@fragno-private/design-system/icon";

import { useSessionWorkspaceNavigation } from "./workspace-context";

export type ToolWorkspaceSelectorOption = {
  id: string;
  kind: "generated-ui" | "workflow-graph";
  label: string;
};

const workspaceIcons: Record<ToolWorkspaceSelectorOption["kind"], IconName> = {
  "generated-ui": "layout",
  "workflow-graph": "share-2",
};

export function ToolWorkspaceSelector({
  options,
  toolLabel,
  labelled,
}: {
  options: readonly ToolWorkspaceSelectorOption[];
  toolLabel: string;
  /** Whether each toggle names its view, as the turn's header does; steps show icons only. */
  labelled: boolean;
}) {
  const navigation = useSessionWorkspaceNavigation();
  if (!navigation || options.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={`Side panel views for ${toolLabel}`}
      className="flex shrink-0 items-center gap-1"
    >
      {options.map((option) => (
        <ChatArtifactToggle
          key={option.id}
          icon={workspaceIcons[option.kind]}
          label={option.label}
          labelled={labelled}
          pressed={navigation.isItemSelected(option.id)}
          onClick={() => {
            navigation.toggleItem(option.id);
          }}
        />
      ))}
    </div>
  );
}
