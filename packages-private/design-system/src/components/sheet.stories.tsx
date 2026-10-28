import { useState } from "react";

import { Button } from "./button";
import { SidebarNavigationItem, type NavigationItem } from "./navigation-item";
import { Sheet, SheetSection } from "./sheet";

export default { title: "Overlays/Sheet" };

const sections: NavigationItem[] = [
  { label: "Automations", to: "/automations", icon: "share-2", active: true },
  { label: "Sessions", to: "/sessions", icon: "message-square", active: false },
  { label: "Files", to: "/files", icon: "folder", active: false },
  { label: "Settings", to: "/settings", icon: "settings", active: false },
];

export function Menu() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open menu
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title="Menu">
        <SheetSection label="Sections">
          <nav aria-label="All sections" className="grid grid-cols-2 gap-2">
            {sections.map((item) => (
              <SidebarNavigationItem key={item.to} item={item} collapsed={false} />
            ))}
          </nav>
        </SheetSection>
      </Sheet>
    </>
  );
}
