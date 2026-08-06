import { Outlet, useOutletContext } from "react-router";

import type { AutomationLayoutContext } from "./layout-context";

export default function BackofficeAutomationStoreLayout() {
  const context = useOutletContext<AutomationLayoutContext>();

  return <Outlet context={context} />;
}
