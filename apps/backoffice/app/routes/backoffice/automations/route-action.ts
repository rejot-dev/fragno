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
        runsAs: "Runs as",
        authority: "Authority mode",
        permissions: "Permissions",
        permissionBasis: "Permission basis",
        target: "Target",
        event: "Event",
        eventId: "Event ID",
      }
    : {
        workflow: "workflow",
        script: "script",
        instanceId: "instance",
        runsAs: "runs as",
        authority: "authority mode",
        permissions: "permissions",
        permissionBasis: "permission basis",
        target: "target",
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
    case "start_workflow": {
      const authority = action.authority;
      const runsAs = {
        "organization-automation": "Organization-owned automation",
        "linked-user": "Backoffice user linked to the incoming sender",
        "delegated-user": "Backoffice user carried by the incoming event",
      }[authority.kind];
      const permissions =
        authority.grants === "inherit"
          ? "User's current permissions — no additional route restriction"
          : authority.grants.length === 0
            ? "None — no protected operations granted"
            : authority.grants.map((grant) => `${grant.namespace}.${grant.permission}`).join("\n");
      return [
        { label: labels.runsAs, value: runsAs },
        { label: labels.authority, value: authority.kind },
        ...(authority.kind !== "organization-automation" && authority.grants !== "inherit"
          ? [
              {
                label: labels.permissionBasis,
                value:
                  "These grants restrict the user's current permissions; they do not add permissions.",
              },
            ]
          : []),
        { label: labels.permissions, value: permissions },
        {
          label: labels.workflow,
          value: automationRouteWorkflowName(route) ?? "Unknown saved workflow",
        },
        { label: labels.script, value: action.workflowScriptPath, to: scriptLink ?? undefined },
        { label: labels.instanceId, value: action.instanceIdTemplate },
      ];
    }
    case "send_workflow_event":
      return [
        {
          label: labels.target,
          value:
            action.target.kind === "instance_id"
              ? action.target.template
              : `Store · ${action.target.keyTemplate}`,
        },
        { label: labels.event, value: action.eventType },
      ];
    case "forward_event": {
      const eventId = action.idTemplate ?? missingForwardEventId;
      return eventId ? [{ label: labels.eventId, value: eventId }] : [];
    }
    case "reclassify_event":
      return [
        { label: "Output source", value: action.source },
        { label: "Output event", value: action.eventType },
        ...Object.entries(action.payload.fields).map(([field, path]) => ({
          label: `Payload · ${field}`,
          value: path,
        })),
      ];
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
    case "reclassify_event":
      return "Reclassify event";
  }

  throw new Error("Unsupported automation route action kind.");
};
