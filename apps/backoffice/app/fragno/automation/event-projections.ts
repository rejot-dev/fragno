import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  PI_AGENT_AUTOMATION_EVENTS,
  PI_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import {
  recordedPiAgentDefinitionsOfStates,
  type PiAgentEventState,
} from "@/fragno/pi/agent/pi-agent-records";
import {
  integrationConnectionsOfStates,
  type IntegrationConnectionEventState,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  INTEGRATIONS_EVENT_SOURCE,
  integrationConnectionEvents,
} from "@/fragno/runtime-tools/families/integrations/integration-events";

import { STATE_INDEX } from "./event-state";
import { automationFragmentSchema } from "./schema";

type EventProjectionServiceContext = DatabaseServiceContext<Record<string, never>>;

const PI_AGENT_DEFINITION_EVENT_TYPES = [
  PI_AGENT_AUTOMATION_EVENTS.created.eventType,
  PI_AGENT_AUTOMATION_EVENTS.updated.eventType,
  PI_AGENT_AUTOMATION_EVENTS.deleted.eventType,
];

export const createEventProjectionServices = (
  defineService: <TService>(
    service: TService & ThisType<EventProjectionServiceContext>,
  ) => TService,
) =>
  defineService({
    /** Every agent a definition event recorded, from its events' states. A scope keeps few. */
    listRecordedPiAgentDefinitions() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_event_state", (b) =>
            b.whereIndex(STATE_INDEX, (eb) =>
              eb.and(
                eb("source", "=", PI_AUTOMATION_SOURCE),
                eb("eventType", "in", PI_AGENT_DEFINITION_EVENT_TYPES),
              ),
            ),
          ),
        )
        .transformRetrieve(([states]) =>
          recordedPiAgentDefinitionsOfStates(
            // Only agent events of these types, which name their agent, keep these.
            states as unknown as PiAgentEventState[],
          ),
        )
        .build();
    },
    /** Every connection, disconnected ones too, from its events' states. A scope keeps few. */
    listIntegrationConnections() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_event_state", (b) =>
            b.whereIndex(STATE_INDEX, (eb) =>
              eb.and(
                eb("source", "=", INTEGRATIONS_EVENT_SOURCE),
                eb(
                  "eventType",
                  "in",
                  integrationConnectionEvents.map(({ eventType }) => eventType),
                ),
              ),
            ),
          ),
        )
        .transformRetrieve(([states]) =>
          integrationConnectionsOfStates(
            // Only connection events of these types, which name their connection, keep these.
            states as unknown as IntegrationConnectionEventState[],
          ),
        )
        .build();
    },
  });
