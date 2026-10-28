import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

/**
 * A modal panel that slides up from the bottom of a phone's screen, within reach of a thumb, such
 * as a menu of what does not fit in the bottom navigation. Like Dialog, the consumer owns whether
 * it is open; Escape, the backdrop, and the close button ask it to close.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
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
          className="fixed inset-0 z-50 bg-[rgba(15,23,42,0.28)] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <BaseDialog.Popup
          data-backoffice-root
          className="bo-popover-surface fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-[12px] bg-[var(--bo-panel)] pb-[env(safe-area-inset-bottom)] text-[var(--bo-fg)] transition-transform duration-200 ease-out outline-none data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[color:var(--bo-border)] py-2 pr-2 pl-4">
            <BaseDialog.Title className="text-sm font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close
              render={
                <IconButton label="Close">
                  <Icon name="x" className="size-4" />
                </IconButton>
              }
            />
          </div>
          <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** A labelled group of a sheet's content. */
export function SheetSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2 not-first:mt-5">
      <h3 className="text-xs font-semibold text-[var(--bo-muted-2)]">{label}</h3>
      {children}
    </section>
  );
}
