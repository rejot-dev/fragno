import type { IconName } from "@fragno-private/design-system/icon";
import { PanelToggleButton } from "@fragno-private/design-system/panel-toggle-button";

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
}: {
  options: readonly ToolWorkspaceSelectorOption[];
  toolLabel: string;
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
        <PanelToggleButton
          key={option.id}
          icon={workspaceIcons[option.kind]}
          label={option.label}
          pressed={navigation.isItemSelected(option.id)}
          onClick={() => {
            navigation.toggleItem(option.id);
          }}
        />
      ))}
    </div>
  );
}
