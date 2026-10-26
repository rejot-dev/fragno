import type {
  AutomationActors,
  AutomationRouteAction,
  AutomationRouteDefinition,
  AutomationSteward,
  AutomationRouteTrigger,
  AutomationStartWorkflowAction,
} from "@fragno-dev/backoffice-api/v0/automation";

import { knownBackofficePermissions } from "@/backoffice-runtime/stored-permissions";

/** The route shape persisted before route-scoped authority grants were introduced. */
type LegacyAutomationStartWorkflowAction = Omit<AutomationStartWorkflowAction, "authority"> & {
  authority: { kind: "organization-automation"; grants?: never };
};

type StoredAutomationRouteAction = AutomationRouteAction | LegacyAutomationStartWorkflowAction;

/**
 * Routes store their steward with their provenance. Before stewardship, Marketplace install scripts
 * labelled the routes they wrote with `managedBy`; those rows read as members' routes until their
 * package's next installation adopts them.
 */
export type StoredAutomationRouteMetadata =
  | {
      createdByActors: AutomationActors;
      updatedByActors: AutomationActors;
      steward: AutomationSteward;
    }
  | {
      createdByActors: AutomationActors;
      updatedByActors: AutomationActors;
      managedBy: { kind: "marketplace"; listingId: string } | null;
    };

type AutomationRouteRow = {
  id: { externalId: string };
  name: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationRouteTrigger;
  action: StoredAutomationRouteAction;
  description: string | null;
  metadata: StoredAutomationRouteMetadata | null;
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
  if (
    (action.kind !== "start_workflow" && action.kind !== "notify_agent") ||
    action.authority.grants === "inherit"
  ) {
    return action;
  }
  return {
    ...action,
    authority: { ...action.authority, grants: knownBackofficePermissions(action.authority.grants) },
  };
}

/** Routes without a recorded steward belong to members. */
export function automationRouteSteward(
  metadata: StoredAutomationRouteMetadata | null,
): AutomationSteward {
  return metadata && "steward" in metadata ? metadata.steward : { kind: "members" };
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
    steward: automationRouteSteward(row.metadata),
    metadata: row.metadata && {
      createdByActors: row.metadata.createdByActors,
      updatedByActors: row.metadata.updatedByActors,
    },
    nextOccurrenceAt: scheduleState?.nextOccurrenceAt?.toISOString() ?? null,
  } as AutomationRouteDefinition;
};

/** The listing whose pre-stewardship install script labelled this route, if one did. */
export function legacyMarketplaceRouteListingId(row: AutomationRouteRow): string | null {
  return row.metadata && "managedBy" in row.metadata
    ? (row.metadata.managedBy?.listingId ?? null)
    : null;
}
