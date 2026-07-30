import { Switch } from "@base-ui/react/switch";
import { useState } from "react";

import { tapScale } from "./ui";

export function SessionDisplayOptions({
  exportFilename,
  exportHref,
  showThinking,
  showToolCalls,
  showUsage,
  onShowThinkingChange,
  onShowToolCallsChange,
  onShowUsageChange,
}: {
  exportFilename: string;
  exportHref: string;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  onShowThinkingChange: (value: boolean) => void;
  onShowToolCallsChange: (value: boolean) => void;
  onShowUsageChange: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current);
        }}
        className={`inline-flex min-h-10 items-center px-3 text-xs font-medium text-[var(--bo-muted)] transition-[color,scale] duration-150 ease-out hover:text-[var(--bo-fg)] ${tapScale}`}
      >
        View
      </button>

      {expanded ? (
        <div className="bo-popover-surface absolute top-12 right-0 z-30 w-64 border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2">
          <ToggleSwitch
            label="Tool calls"
            checked={showToolCalls}
            onCheckedChange={onShowToolCallsChange}
          />
          <ToggleSwitch
            label="Reasoning"
            checked={showThinking}
            onCheckedChange={onShowThinkingChange}
          />
          <ToggleSwitch label="Usage" checked={showUsage} onCheckedChange={onShowUsageChange} />
          <a
            href={exportHref}
            download={exportFilename}
            className={`mt-1 flex min-h-10 items-center px-3 text-xs font-medium text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] ${tapScale}`}
          >
            Download JSONL
          </a>
        </div>
      ) : null}
    </div>
  );
}

function ToggleSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-3 px-3 text-xs text-[var(--bo-muted)] transition-[background-color,color] duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]">
      <span>{label}</span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="group inline-flex h-6 w-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-1 transition-[background-color,border-color] duration-150 data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-accent-bg)]"
      >
        <Switch.Thumb className="size-4 bg-[var(--bo-fg)] transition-transform duration-150 group-data-[checked]:translate-x-4" />
      </Switch.Root>
    </label>
  );
}
