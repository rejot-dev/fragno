import { OverflowTabRow, type OverflowTabRowItem } from "./overflow-tab-row";

export default { title: "Navigation/Overflow tab row" };

const items: OverflowTabRowItem[] = [
  { id: "overview", label: "Overview", to: "/overview", active: true },
  { id: "runs", label: "Runs", to: "/runs" },
  { id: "source", label: "Source", to: "/source" },
  { id: "settings", label: "Settings", to: "/settings" },
  { id: "audit", label: "Audit log", to: "/audit", disabled: true },
  { id: "secrets", label: "Secrets", to: "/secrets" },
  { id: "webhooks", label: "Webhooks", to: "/webhooks" },
];

export function Boxed() {
  return (
    <OverflowTabRow items={items} ariaLabel="Automation sections" variant="boxed" trailing={null} />
  );
}

export function Underline() {
  return (
    <OverflowTabRow
      items={items}
      ariaLabel="Automation sections"
      variant="underline"
      trailing={null}
    />
  );
}

export function Browser() {
  return (
    <OverflowTabRow
      items={items}
      ariaLabel="Automation sections"
      variant="browser"
      trailing={null}
    />
  );
}

// Narrow container so the overflow menu takes over the trailing tabs.
export function Overflowing() {
  return (
    <div className="max-w-xs">
      <OverflowTabRow items={items} ariaLabel="Automation sections" trailing={null} />
    </div>
  );
}
