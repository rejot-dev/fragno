import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  automationEventSourceInputSchema,
  buildAutomationEventSourceId,
  type AutomationEventSourceInput,
} from "./event-sources";
import { automationFragmentSchema } from "./schema";

type AutomationEventSourceServiceContext = DatabaseServiceContext<Record<string, never>>;

export function createAutomationEventSourceServices(
  defineService: <TService>(
    service: TService & ThisType<AutomationEventSourceServiceContext>,
  ) => TService,
) {
  return defineService({
    listEventSources() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_event_source", (b) =>
            b.whereIndex("primary").orderByIndex("idx_automation_event_source_source", "asc"),
          ),
        )
        .transformRetrieve(([sources]) => sources)
        .build();
    },

    getEventSource(input: { source: string }) {
      const id = buildAutomationEventSourceId(input.source);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_source", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .transformRetrieve(([source]) => source ?? null)
        .build();
    },

    ensureEventSource(input: AutomationEventSourceInput) {
      const source = automationEventSourceInputSchema.parse(input);
      const id = buildAutomationEventSourceId(source.source);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_source", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (existing) {
            uow.update("automation_event_source", existing.id, (b) =>
              b
                .set({
                  label: source.label,
                  description: source.description,
                  category: source.category,
                  updatedAt: b.now(),
                })
                .check(),
            );
          } else {
            const now = uow.now();
            uow.create("automation_event_source", {
              id,
              ...source,
              createdAt: now,
              updatedAt: now,
            });
          }

          return { id, ...source };
        })
        .build();
    },
  });
}
