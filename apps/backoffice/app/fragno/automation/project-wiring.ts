import type {
  AutomationForwardAccept,
  AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";

import type { AutomationHookUnitOfWork } from "./internal-hooks";

/**
 * A project tells its owner how it is wired whenever that changes, so the owner's universe draws
 * every project from the owner's own state instead of opening each project's replica. The owner
 * keeps each project's latest wiring as an event state of this type, keyed by project. Only
 * Backoffice writes these states: no event of the type may be stored, so none can be kept as one.
 */
export const PROJECT_WIRING_STATE = {
  source: "automations",
  eventType: "project.wiring",
  keyPath: "$.projectId",
} as const;

/** Whether an event has the type of project wiring states, which no event may have. */
export function isProjectWiringStateType(event: { source: string; eventType: string }) {
  return (
    event.source === PROJECT_WIRING_STATE.source &&
    event.eventType === PROJECT_WIRING_STATE.eventType
  );
}

/** What a project's planet is drawn from: what it routes, takes in, defines, and connects to. */
export type ProjectWiring = {
  projectId: string;
  routes: AutomationRouteDefinition[];
  forwardAccepts: AutomationForwardAccept[];
  eventSources: { id: string; label: string; description: string }[];
  eventDefinitions: { source: string; eventType: string; label: string }[];
  connections: Pick<IntegrationConnectionRecord, "connectionId" | "service" | "displayName">[];
};

/** Has a project's owner told how the project is wired once this change commits. */
export function rewireProject(
  uow: Pick<AutomationHookUnitOfWork, "triggerHook">,
  ownerScope: BackofficeContextScope,
) {
  if (ownerScope.kind === "project") {
    uow.triggerHook("internalPublishProjectWiring", {});
  }
}

/** How a project is wired, as read at `occurredAt` by the hook `sequence` orders among its own. */
export type ProjectWiringTelling = { wiring: ProjectWiring; occurredAt: Date; sequence: string };
