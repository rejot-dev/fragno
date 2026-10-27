import { IconButton } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import { SideDrawerHeader } from "@fragno-private/design-system/side-drawer";
import type { ReactNode } from "react";

/** The agent drawer's toolbar: `options`, then the button that closes the drawer. */
export function AgentDrawerHeader({
  options,
  onClose,
}: {
  options: ReactNode;
  onClose: () => void;
}) {
  return (
    <SideDrawerHeader>
      <div className="flex min-w-0 flex-1 items-center gap-1">{options}</div>
      <IconButton label="Close agent drawer" onClick={onClose}>
        <Icon name="x" className="size-4" />
      </IconButton>
    </SideDrawerHeader>
  );
}
