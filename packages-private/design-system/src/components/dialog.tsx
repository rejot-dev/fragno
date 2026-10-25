import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

/**
 * A modal panel over the page, for a task that would otherwise sit open under what the page shows,
 * such as a form adding a record. The page owns whether it is open, so it can close it once the
 * task succeeds; Escape, the backdrop, and the close button ask it to close.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string | null;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          data-backoffice-root
          className="fixed inset-0 z-50 bg-[rgba(15,23,42,0.28)] transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <BaseDialog.Popup
          data-backoffice-root
          className="bo-popover-surface fixed top-[10vh] left-1/2 z-50 max-h-[80vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto bg-[var(--bo-panel)] p-6 text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <BaseDialog.Title className="text-lg font-semibold text-balance">
                {title}
              </BaseDialog.Title>
              {description === null ? null : (
                <BaseDialog.Description className="text-sm text-pretty text-[var(--bo-muted)]">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close
              render={
                <IconButton label="Close" className="-mt-1 -mr-2">
                  <Icon name="x" className="size-4" />
                </IconButton>
              }
            />
          </div>
          <div className="mt-5">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
