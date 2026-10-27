import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

import type { HookFn, TypedUnitOfWork } from "@fragno-dev/db";

import type { AutomationEventIdentity } from "./contracts";
import { automationFragmentSchema } from "./schema";

export type AutomationEventIngestionPayload = {
  event: AutomationEvent;
  reclassificationChain: readonly AutomationEventIdentity[];
  route?: AutomationRouteDefinition;
};

/**
 * One matched route acting on one event. The route is snapshotted when the event matches it, so a
 * route changed or deleted while this hook waits to retry still acts as it was matched.
 */
export type AutomationRouteDispatchPayload = {
  event: AutomationEvent;
  route: AutomationRouteDefinition;
  reclassificationChain: readonly AutomationEventIdentity[];
};

export type AutomationRouteScheduleDispatchPayload =
  | {
      kind: "initialize";
      routeId: string;
    }
  | {
      kind: "dispatch";
      routeId: string;
      scheduledFor: string;
    }
  | {
      kind: "manual";
      eventId: string;
      route: AutomationRouteDefinition;
    };

/**
 * Shared by storage runtimes that emit fragment hooks. Keeping the complete hook contract here
 * prevents unrelated feature runtimes from importing one another when a new hook is added.
 */
export type AutomationInternalHooks = {
  internalIngestEvent: HookFn<AutomationEventIngestionPayload>;
  internalDispatchRoute: HookFn<AutomationRouteDispatchPayload>;
  internalDispatchRouteSchedule: HookFn<AutomationRouteScheduleDispatchPayload>;
};

export type AutomationHookUnitOfWork = TypedUnitOfWork<
  typeof automationFragmentSchema,
  [],
  unknown,
  AutomationInternalHooks
>;
