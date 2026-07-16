import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";

import type { AutomationEvent } from "./contracts";
import type { AutomationRouteDefinition } from "./routing";
import { automationFragmentSchema } from "./schema";

export type AutomationEventIngestionPayload = {
  event: AutomationEvent;
  route?: AutomationRouteDefinition;
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
  internalIngestEvent: (payload: AutomationEventIngestionPayload) => Promise<void> | void;
  internalDispatchRouteSchedule: (
    payload: AutomationRouteScheduleDispatchPayload,
  ) => Promise<void> | void;
};

export type AutomationHookServiceContext = DatabaseServiceContext<AutomationInternalHooks>;

export type AutomationHookUnitOfWork = TypedUnitOfWork<
  typeof automationFragmentSchema,
  [],
  unknown,
  AutomationInternalHooks
>;
