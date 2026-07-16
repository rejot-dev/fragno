import type { AutomationRouteDefinition, AutomationRouteTrigger } from "./routing";

type AutomationRouteRow = {
  id: { externalId: string };
  name: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationRouteTrigger;
  action: AutomationRouteDefinition["action"];
  description: string | null;
};

type AutomationRouteScheduleStateRow = {
  id: { externalId: string };
  nextOccurrenceAt: Date | null;
};

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
    action: row.action,
    description: row.description,
    nextOccurrenceAt: scheduleState?.nextOccurrenceAt?.toISOString() ?? null,
  };
};
