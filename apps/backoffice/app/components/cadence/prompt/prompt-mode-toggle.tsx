/*
 * The Compose / Dev segmented toggle. Shown in both modes so the switch is
 * always reachable; typing a leading `/` in compose is the keyboard shortcut for
 * the same thing.
 */

import { Sparkles, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";

import { usePrompt } from "./prompt-context";

export function PromptModeToggle() {
  const { mode, enterDev, exitDev } = usePrompt();

  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] p-0.5">
      <ToggleButton active={mode === "compose"} onClick={exitDev}>
        <Sparkles className="h-3.5 w-3.5" />
        Compose
      </ToggleButton>
      <ToggleButton
        active={mode === "dev"}
        onClick={() => {
          enterDev();
        }}
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        Dev
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
        active
          ? "bg-[var(--cad-panel)] text-[var(--cad-fg)] shadow-[var(--cad-shadow)]"
          : "text-[var(--cad-muted-2)] hover:text-[var(--cad-fg)]",
      )}
    >
      {children}
    </button>
  );
}
