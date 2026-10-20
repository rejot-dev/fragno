import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";

import { Button } from "./button";

/** A text button that opens a small panel of settings, such as what a view shows. */
export function OptionsPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="ghost" />}>{label}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Popover.Popup
            data-backoffice-root
            className="bo-popover-surface w-64 origin-top-right border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A download offered at the end of an options panel. */
export function OptionsPopoverDownload({
  href,
  filename,
  children,
}: {
  href: string;
  filename: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      download={filename}
      className="mt-1 flex min-h-10 items-center px-3 text-xs font-medium text-[var(--bo-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
    >
      {children}
    </a>
  );
}
