/*
 * Shared chrome for an exec companion panel — the right side of the exec split.
 * A flush header (icon + title + a small badge), a Close button, and a padded
 * body. Both the {@link WorkflowPanel} and {@link CodemodeWorkflowPanel} render
 * through this so their header styling and spacing stay identical.
 */

import { X } from "lucide-react";
import type { ReactNode } from "react";

import { CadenceGhostButton } from "@/components/cadence/primitives";
import { cn } from "@/lib/utils";

export function CompanionPanel({
  icon,
  title,
  badge,
  onClose,
  flush = false,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  /** Small mono pill beside the title (e.g. the view mode or "codemode"). */
  badge: string;
  onClose: () => void;
  /**
   * Drop the body padding so the children fill the panel edge-to-edge — used by
   * the workflow workbench (in `flushHeader` mode) so it matches the workflows
   * page, where the toolbar is a flush header band and the panels are full-bleed.
   */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[color:var(--cad-line)] bg-[var(--cad-bg)]">
      <header className="box-content flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--cad-line)] px-4">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="cad-eyebrow truncate text-[var(--cad-muted)]">{title}</span>
          <span className="cad-mono shrink-0 rounded bg-[var(--cad-panel-2)] px-1.5 py-0.5 text-[9px] text-[var(--cad-muted-2)]">
            {badge}
          </span>
        </span>
        <CadenceGhostButton type="button" onClick={onClose} className="px-2.5 py-1.5 text-xs">
          <X className="h-3.5 w-3.5" />
          Close
        </CadenceGhostButton>
      </header>

      <div className={cn("flex min-h-0 flex-1 flex-col", flush || "p-4")}>{children}</div>
    </div>
  );
}
