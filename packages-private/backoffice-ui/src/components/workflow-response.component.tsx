import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";
import { HostWidgetUnavailable } from "./host-widget-unavailable";

export const WorkflowResponse: ComponentFn<typeof backofficeUiCatalog, "WorkflowResponse"> = ({
  props,
}) => {
  const { widgets } = useBackofficeUiRenderContext();
  return widgets === null ? (
    <HostWidgetUnavailable widget="A run's response form" />
  ) : (
    widgets.workflowResponse(props)
  );
};
