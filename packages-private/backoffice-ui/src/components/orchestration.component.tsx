import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";
import { HostWidgetUnavailable } from "./host-widget-unavailable";

export const Orchestration: ComponentFn<typeof backofficeUiCatalog, "Orchestration"> = () => {
  const { widgets } = useBackofficeUiRenderContext();
  return widgets === null ? (
    <HostWidgetUnavailable widget="The orchestration graph" />
  ) : (
    widgets.orchestration()
  );
};
