import {
  MobileNavigationItem,
  SidebarNavigationItem,
  type NavigationItem,
} from "./navigation-item";

export default { title: "Navigation/Navigation item" };

const inactive: NavigationItem = {
  label: "Automations",
  to: "/automations",
  icon: "share-2",
  active: false,
};
const active: NavigationItem = { ...inactive, active: true };

export function Sidebar() {
  return (
    <div className="flex w-72 flex-col gap-2.5 bg-[var(--bo-sidebar-bg)] p-4">
      <SidebarNavigationItem item={active} collapsed={false} />
      <SidebarNavigationItem item={inactive} collapsed={false} />
    </div>
  );
}

export function SidebarCollapsed() {
  return (
    <div className="flex w-16 flex-col gap-2.5 bg-[var(--bo-sidebar-bg)] px-2 py-4">
      <SidebarNavigationItem item={active} collapsed />
      <SidebarNavigationItem item={inactive} collapsed />
    </div>
  );
}

export function Mobile() {
  return (
    <div className="grid w-72 grid-cols-2 bg-[var(--bo-header-bg)]">
      <MobileNavigationItem item={active} />
      <MobileNavigationItem item={inactive} />
    </div>
  );
}
