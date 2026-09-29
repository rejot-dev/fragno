import { useState } from "react";

import { MobileNavigation, SidebarNavigation } from "./navigation";
import type { NavigationItem } from "./navigation-item";

export default { title: "Navigation/Main navigation" };

const items: NavigationItem[] = [
  { label: "Automations", to: "/automations", icon: "share-2", active: true },
  { label: "Sessions", to: "/sessions", icon: "message-square", active: false },
  { label: "Files", to: "/files", icon: "folder", active: false },
  { label: "Marketplace", to: "/marketplace", icon: "shopping-bag", active: false },
];

// The sidebar only shows from 960px wide, matching the Backoffice shell breakpoint.
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex h-[32rem] border border-[color:var(--bo-border)]">
      <SidebarNavigation
        items={items}
        ariaLabel="Backoffice"
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
      <div className="flex-1 p-6 text-sm text-[var(--bo-muted)]">Page content</div>
    </div>
  );
}

export function SidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="flex h-[32rem] border border-[color:var(--bo-border)]">
      <SidebarNavigation
        items={items}
        ariaLabel="Backoffice"
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
      <div className="flex-1 p-6 text-sm text-[var(--bo-muted)]">Page content</div>
    </div>
  );
}

export function Mobile() {
  return (
    <div className="max-w-md border border-[color:var(--bo-border)] bg-[var(--bo-header-bg)]">
      <MobileNavigation items={items} ariaLabel="Backoffice" />
    </div>
  );
}
