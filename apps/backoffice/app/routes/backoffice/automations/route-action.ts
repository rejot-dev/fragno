import type { AutomationRouteDefinition } from "@/fragno/automation/routing";

import { automationRouteWorkflowName } from "./route-workflow";

export type AutomationRouteDetailRow = { label: string; value: string; to?: string };

type AutomationRouteDetailLabelSet = "route" | "inspector";

const actionDetailLabels = (labelSet: AutomationRouteDetailLabelSet) =>
  labelSet === "inspector"
    ? {
        workflow: "Workflow",
        script: "Script",
        instanceId: "Instance ID",
        savedWorkflow: "Saved workflow",
        hostWorkflow: "Host workflow",
        event: "Event",
        eventId: "Event ID",
      }
    : {
        workflow: "workflow",
        script: "script",
        instanceId: "instance",
        savedWorkflow: "saved workflow",
        hostWorkflow: "host workflow",
        event: "event",
        eventId: "event id",
      };

export const automationRouteActionDetailRows = (
  route: AutomationRouteDefinition,
  {
    scriptLink,
    labelSet,
    missingForwardEventId,
  }: {
    scriptLink: string | null;
    labelSet: AutomationRouteDetailLabelSet;
    missingForwardEventId?: string;
  },
): AutomationRouteDetailRow[] => {
  const action = route.action;
  const labels = actionDetailLabels(labelSet);

  switch (action.kind) {
    case "start_workflow":
      return [
        {
          label: labels.workflow,
          value: automationRouteWorkflowName(route) ?? "Unknown saved workflow",
        },
        { label: labels.script, value: action.workflowScriptPath, to: scriptLink ?? undefined },
        { label: labels.instanceId, value: action.instanceIdTemplate },
      ];
    case "send_workflow_event":
      return [
        { label: labels.savedWorkflow, value: action.remoteWorkflowName },
        { label: labels.hostWorkflow, value: action.workflowName },
        { label: labels.event, value: action.eventType },
      ];
    case "forward_event": {
      const eventId = action.idTemplate ?? missingForwardEventId;
      return eventId ? [{ label: labels.eventId, value: eventId }] : [];
    }
  }

  throw new Error("Unsupported automation route action kind.");
};

export const automationRouteActionLabel = (route: AutomationRouteDefinition) => {
  switch (route.action.kind) {
    case "start_workflow":
      return "Start workflow";
    case "send_workflow_event":
      return "Send workflow event";
    case "forward_event":
      return "Forward event";
  }

  throw new Error("Unsupported automation route action kind.");
};
