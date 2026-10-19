import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";

import { dashboardEventsPath, dashboardPath } from "./path";

export function DashboardTabs({
  selectedScope,
  active,
}: {
  selectedScope: BackofficeScopeSelection;
  active: "overview" | "events";
}) {
  const scope = backofficeRouteScopeFromResolvedScope(selectedScope);
  return (
    <BackofficeTabHeader
      items={[
        {
          id: "overview",
          label: "Overview",
          to: dashboardPath(scope),
          active: active === "overview",
        },
        {
          id: "events",
          label: "Events",
          to: dashboardEventsPath(scope, null),
          active: active === "events",
        },
      ]}
      ariaLabel="Dashboard"
      options={null}
    />
  );
}
