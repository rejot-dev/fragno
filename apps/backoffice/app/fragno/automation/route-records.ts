import type {
  AutomationRouteAction,
  AutomationRouteDefinition,
  AutomationRouteTrigger,
  AutomationStartWorkflowAction,
} from "./routing";

/** The route shape persisted before route-scoped authority grants were introduced. */
type LegacyAutomationStartWorkflowAction = Omit<AutomationStartWorkflowAction, "authority"> & {
  authority: { kind: "organization-automation"; grants?: never };
};

type StoredAutomationRouteAction = AutomationRouteAction | LegacyAutomationStartWorkflowAction;

type AutomationRouteRow = {
  id: { externalId: string };
  name: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationRouteTrigger;
  action: StoredAutomationRouteAction;
  description: string | null;
  metadata: AutomationRouteDefinition["metadata"];
};

type AutomationRouteScheduleStateRow = {
  id: { externalId: string };
  nextOccurrenceAt: Date | null;
};

function isLegacyAutomationStartWorkflowAction(
  action: StoredAutomationRouteAction,
): action is LegacyAutomationStartWorkflowAction {
  return action.kind === "start_workflow" && !("grants" in action.authority);
}

function normalizeStoredAutomationRouteAction(
  action: StoredAutomationRouteAction,
): AutomationRouteAction {
  if (isLegacyAutomationStartWorkflowAction(action)) {
    // Empty grants keep historical routes readable while denying protected work until migration.
    return {
      ...action,
      authority: { ...action.authority, grants: [] },
    };
  }

  return action;
}

export const normalizeAutomationRoute = (
  row: AutomationRouteRow,
  scheduleState?: AutomationRouteScheduleStateRow | null,
): AutomationRouteDefinition => {
  if (row.trigger.kind === "schedule" && !scheduleState) {
    throw new Error(`Scheduled automation route ${row.id.externalId} has no scheduling state.`);
  }
  if (row.trigger.kind === "event" && scheduleState) {
    throw new Error(`Event automation route ${row.id.externalId} has unexpected scheduling state.`);
  }

  return {
    id: row.id.externalId,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    trigger: row.trigger,
    action: normalizeStoredAutomationRouteAction(row.action),
    description: row.description,
    metadata: row.metadata,
    nextOccurrenceAt: scheduleState?.nextOccurrenceAt?.toISOString() ?? null,
  };
};
