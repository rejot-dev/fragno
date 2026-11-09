import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../cn";
import { IconButton } from "../controls/button";
import { Icon } from "../icon";

/**
 * A modal panel that slides in from an edge of a phone's screen, toward the control that opened
 * it: up from the bottom for a menu of what does not fit in the bottom navigation, down from the
 * top for a header control's choices. Like Dialog, the consumer owns whether it is open; Escape,
 * the backdrop, and the close button ask it to close.
 */
export function Sheet({
  side,
  open,
  onOpenChange,
  title,
  children,
}: {
  side: "top" | "bottom";
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
          className={cn(
            "bo-popover-surface fixed inset-x-0 z-50 flex max-h-[85dvh] flex-col bg-[var(--bo-panel)] text-[var(--bo-fg)] transition-transform duration-200 ease-out outline-none motion-reduce:transition-none",
            side === "top"
              ? "top-0 rounded-b-[12px] pt-[env(safe-area-inset-top)] data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full"
              : "bottom-0 rounded-t-[12px] pb-[env(safe-area-inset-bottom)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
          )}
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

const OPTION_CLASS_NAME =
  "flex min-h-12 items-center gap-3 rounded-[6px] px-3 py-2 text-left outline-none transition-[background-color] duration-150 ease-out";

/**
 * A destination to choose in a sheet, such as a workspace to switch to. The current option is shown
 * selected and cannot be chosen again. Following it changes the location, which the consumer closes
 * the sheet on.
 */
export function SheetOption({
  to,
  label,
  description,
  current,
}: {
  to: string;
  label: string;
  description: string | null;
  current: boolean;
}) {
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-[var(--bo-fg)]">{label}</span>
        {description === null ? null : (
          <span className="truncate text-xs text-[var(--bo-muted-2)]">{description}</span>
        )}
      </span>
      {/* Reserved on every option so labels line up whether or not the check is shown. */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {current ? <Icon name="check" className="size-4 text-[var(--bo-accent-text)]" /> : null}
      </span>
    </>
  );
  return current ? (
    <span
      aria-current="true"
      className={cn(
        OPTION_CLASS_NAME,
        "bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)]",
      )}
    >
      {content}
    </span>
  ) : (
    <Link
      to={to}
      preventScrollReset
      className={cn(
        OPTION_CLASS_NAME,
        "cursor-pointer hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:bg-[var(--bo-panel-2)]",
      )}
    >
      {content}
    </Link>
  );
}
