import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import {
  TabPinMenu,
  TabPinMenuCode,
  type TabPinMenuItems,
} from "@fragno-private/design-system/tab-pin-menu";
import { useEffect, useMemo } from "react";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

import type { PageSources } from "../pages/load.server";
import { pageName, pagePath } from "../pages/path";
import { dashboardActivityPath, dashboardMapPath, dashboardPath } from "./path";
import { usePinnedPages } from "./pinned-pages";

/** Pages go by their file's name, as in Files; a page's title heads the page itself. */
export type DashboardTab =
  | { kind: "overview" }
  | { kind: "activity" }
  | { kind: "map" }
  | { kind: "page"; name: string };

export function DashboardTabs({
  selectedScope,
  active,
  pageSources,
}: {
  selectedScope: BackofficeScopeSelection;
  active: DashboardTab;
  /** Streams in after the tabs render; only the pages menu waits for it. */
  pageSources: Promise<PageSources>;
}) {
  const scope = backofficeRouteScopeFromResolvedScope(selectedScope);
  const pinned = usePinnedPages(backofficeRouteScopePath(scope));
  const { unpinMissing } = pinned;
  const openName = active.kind === "page" ? active.name : null;
  // An open page that is not pinned is a tab only while it is open.
  const pageTabs =
    openName !== null && !pinned.names.includes(openName)
      ? [...pinned.names, openName]
      : pinned.names;

  // A renamed or deleted page leaves a pin nothing lists, so nothing could unpin it. Only a listing
  // that succeeded says a page is gone.
  useEffect(() => {
    let current = true;
    void pageSources.then((sources) => {
      if (current && sources.kind === "listed") {
        unpinMissing(sources.sourcePaths.map(pageName));
      }
    });
    return () => {
      current = false;
    };
  }, [pageSources, unpinMissing]);

  const menuItems = useMemo(
    () =>
      pageSources.then(
        (sources): TabPinMenuItems =>
          sources.kind === "failed"
            ? sources
            : {
                kind: "listed",
                items: sources.sourcePaths.map((sourcePath) => {
                  const name = pageName(sourcePath);
                  const folder = pageFolder(name);
                  return {
                    id: name,
                    label: pageLabel(name),
                    detail: folder === "" ? null : folder,
                    to: pagePath(selectedScope, name),
                  };
                }),
              },
      ),
    [pageSources, selectedScope],
  );

  return (
    <BackofficeTabHeader
      items={[
        {
          id: "overview",
          label: "Overview",
          to: dashboardPath(scope),
          groupId: "dashboard",
          active: active.kind === "overview",
        },
        {
          id: "activity",
          label: "Activity",
          to: dashboardActivityPath(scope, { trace: null, filter: "all" }),
          groupId: "dashboard",
          active: active.kind === "activity",
        },
        {
          id: "map",
          label: "Map",
          to: dashboardMapPath(scope),
          groupId: "dashboard",
          active: active.kind === "map",
        },
        ...pageTabs.map((name) => ({
          id: `page:${name}`,
          label: pageLabel(name),
          to: pagePath(selectedScope, name),
          groupId: "pages",
          active: name === openName,
        })),
      ]}
      ariaLabel="Dashboard"
      trailing={
        <TabPinMenu
          title="Pages"
          ariaLabel="Pages"
          loading="Loading pages…"
          icon="file-text"
          items={menuItems}
          activeId={openName}
          pinnedIds={pinned.names}
          onPinnedChange={(item, pin) => {
            if (pin) {
              pinned.pin(item.id);
            } else {
              pinned.unpin(item.id);
            }
          }}
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
      }
      options={null}
    />
  );
}

/** A page's file name, capitalized like the tabs beside it: `reports/operations` is `Operations`. */
function pageLabel(name: string): string {
  const fileName = name.slice(pageFolder(name).length);
  return fileName.charAt(0).toUpperCase() + fileName.slice(1);
}

/** The folders a page sits in, such as `reports/` for `reports/operations`. */
function pageFolder(name: string): string {
  return name.slice(0, name.lastIndexOf("/") + 1);
}
