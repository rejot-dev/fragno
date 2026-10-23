import { useState } from "react";

import { Button } from "./button";
import { BackofficeTabHeader } from "./tab-header";
import {
  TabPinMenu,
  TabPinMenuCode,
  type TabPinMenuItem,
  type TabPinMenuItems,
} from "./tab-pin-menu";

export default { title: "Navigation/Tab header" };

export function SingleTab() {
  return (
    <BackofficeTabHeader
      items={[{ id: "sandboxes", label: "Sandboxes", to: "/sandboxes", active: true }]}
      ariaLabel="Computer kinds"
      trailing={null}
      options={null}
    />
  );
}

export function WithOptions() {
  return (
    <BackofficeTabHeader
      items={[
        { id: "all", label: "All agents", to: "/agents", groupId: "overview", active: true },
        { id: "assistant", label: "Assistant", to: "/agents/assistant", groupId: "agents" },
        { id: "reviewer", label: "Reviewer", to: "/agents/reviewer", groupId: "agents" },
      ]}
      ariaLabel="Agents"
      trailing={null}
      options={<Button variant="secondary">New agent</Button>}
    />
  );
}

export function WithPinMenu() {
  const [pinned, setPinned] = useState<readonly TabPinMenuItem[]>([listedItems[0]]);
  return (
    <BackofficeTabHeader
      items={[
        { id: "overview", label: "Overview", to: "/dashboard", groupId: "dashboard", active: true },
        { id: "events", label: "Events", to: "/dashboard/events", groupId: "dashboard" },
        ...pinned.map((item) => ({
          id: `page:${item.id}`,
          label: item.label,
          to: item.to,
          groupId: "pages",
        })),
      ]}
      ariaLabel="Dashboard"
      trailing={
        <PagesMenu
          items={listedPages}
          activeId={null}
          pinnedIds={pinned.map((item) => item.id)}
          onPinnedChange={(item, pin) => {
            setPinned((current) =>
              pin ? [...current, item] : current.filter((candidate) => candidate.id !== item.id),
            );
          }}
        />
      }
      options={null}
    />
  );
}

export function WithEmptyPinMenu() {
  return <PinMenuOnly items={noPages} />;
}

export function WithLoadingPinMenu() {
  return <PinMenuOnly items={pendingPages} />;
}

export function WithFailedPinMenu() {
  return <PinMenuOnly items={unlistedPages} />;
}

const listedItems: readonly TabPinMenuItem[] = [
  { id: "home", label: "home", detail: null, to: "/pages/home" },
  { id: "reports/operations", label: "operations", detail: "reports/", to: "/pages/ops" },
];

// Each story keeps its promise across renders, as a loader's data does.
const listedPages = Promise.resolve<TabPinMenuItems>({ kind: "listed", items: listedItems });
const noPages = Promise.resolve<TabPinMenuItems>({ kind: "listed", items: [] });
const pendingPages = new Promise<TabPinMenuItems>(() => {});
const unlistedPages = Promise.resolve<TabPinMenuItems>({
  kind: "failed",
  message: "Pages could not be listed: timeout.",
});

function PinMenuOnly({ items }: { items: Promise<TabPinMenuItems> }) {
  return (
    <BackofficeTabHeader
      items={[{ id: "overview", label: "Overview", to: "/dashboard", active: true }]}
      ariaLabel="Dashboard"
      trailing={
        <PagesMenu items={items} activeId={null} pinnedIds={[]} onPinnedChange={() => {}} />
      }
      options={null}
    />
  );
}

function PagesMenu({
  items,
  activeId,
  pinnedIds,
  onPinnedChange,
}: {
  items: Promise<TabPinMenuItems>;
  activeId: string | null;
  pinnedIds: readonly string[];
  onPinnedChange: (item: TabPinMenuItem, pinned: boolean) => void;
}) {
  return (
    <TabPinMenu
      title="Pages"
      ariaLabel="Pages"
      loading="Loading pages…"
      icon="file-text"
      items={items}
      activeId={activeId}
      pinnedIds={pinnedIds}
      onPinnedChange={onPinnedChange}
      empty={{
        title: "No pages yet",
        description: (
          <>
            Save a <TabPinMenuCode>.page.js</TabPinMenuCode> file in{" "}
            <TabPinMenuCode>/workspace</TabPinMenuCode> to open it here.
          </>
        ),
      }}
    />
  );
}
