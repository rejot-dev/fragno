import { PanelsTopLeft, Workflow, type LucideIcon } from "lucide-react";

import { useSessionWorkspaceNavigation } from "./workspace-context";

export type ToolWorkspaceSelectorOption = {
  id: string;
  kind: "generated-ui" | "workflow-graph";
  label: string;
};

const workspaceIcons: Record<ToolWorkspaceSelectorOption["kind"], LucideIcon> = {
  "generated-ui": PanelsTopLeft,
  "workflow-graph": Workflow,
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
      {options.map((option) => {
        const selected = navigation.isItemSelected(option.id);
        const Icon = workspaceIcons[option.kind];
        const actionLabel = `${selected ? "Hide" : "Show"} ${option.label} in side panel`;

        return (
          <button
            key={option.id}
            type="button"
            aria-label={actionLabel}
            aria-pressed={selected}
            title={actionLabel}
            onClick={() => {
              navigation.toggleItem(option.id);
            }}
            className={`bo-control-surface relative inline-flex size-11 shrink-0 items-center justify-center bg-[var(--bo-panel)] transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] ${selected ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] ring-1 ring-[color:var(--bo-accent)] ring-inset" : "text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]"}`}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span
              aria-hidden="true"
              className={`absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--bo-accent)] transition-[opacity,scale] duration-150 ${selected ? "scale-100 opacity-100" : "scale-[0.25] opacity-0"}`}
            />
          </button>
        );
      })}
    </div>
  );
}
