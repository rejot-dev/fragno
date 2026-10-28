import { useState } from "react";

import {
  BottomNavigation,
  MobileNavigation,
  SidebarNavigation,
  type NavigationSection,
} from "./navigation";
import {
  BottomNavigationButton,
  BottomNavigationItem,
  type NavigationItem,
} from "./navigation-item";

export default { title: "Navigation/Main navigation" };

const secondaryItems: NavigationItem[] = [
  { label: "Settings", to: "/settings", icon: "settings", active: false },
];

const items: NavigationItem[] = [
  { label: "Automations", to: "/automations", icon: "share-2", active: true },
  { label: "Sessions", to: "/sessions", icon: "message-square", active: false },
  { label: "Files", to: "/files", icon: "folder", active: false },
  { label: "Marketplace", to: "/marketplace", icon: "shopping-bag", active: false },
];

const sections = [
  { label: null, items },
  {
    label: "Acme Holding",
    items: [
      { label: "Journal", to: "/books", icon: "book-open", active: false },
      { label: "Accounts", to: "/books/accounts", icon: "list", active: false },
    ],
  },
] satisfies NavigationSection[];

// The sidebar only shows from 960px wide, matching the Backoffice shell breakpoint.
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex h-[32rem] border border-[color:var(--bo-border)]">
      <SidebarNavigation
        sections={sections}
        secondaryItems={secondaryItems}
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
        sections={sections}
        secondaryItems={secondaryItems}
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

// Fixed to the bottom of the viewport, as on a phone; the last slot opens the destinations that do
// not fit.
export function Bottom() {
  return (
    <BottomNavigation ariaLabel="Backoffice">
      {items.slice(0, 3).map((item) => (
        <BottomNavigationItem key={item.to} item={item} />
      ))}
      <BottomNavigationButton
        label="More"
        icon="more-horizontal"
        active={false}
        expanded={false}
        onClick={() => undefined}
      />
    </BottomNavigation>
  );
}
