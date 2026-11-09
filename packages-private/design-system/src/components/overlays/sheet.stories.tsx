import { useState } from "react";

import { Button } from "../controls/button";
import { SidebarNavigationItem, type NavigationItem } from "../navigation/navigation-item";
import { Sheet, SheetOption, SheetSection } from "./sheet";

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
      <Sheet side="bottom" open={open} onOpenChange={setOpen} title="Menu">
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

export function Choices() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Switch workspace
      </Button>
      <Sheet side="top" open={open} onOpenChange={setOpen} title="Switch workspace">
        <SheetSection label="Organizations">
          <SheetOption to="/acme" label="Acme" description={null} current />
          <SheetOption to="/globex" label="Globex" description={null} current={false} />
        </SheetSection>
        <SheetSection label="Personal">
          <SheetOption to="/me" label="ada@example.com" description={null} current={false} />
        </SheetSection>
      </Sheet>
    </>
  );
}
