import type { Cursor, DatabaseServiceContext } from "@fragno-dev/db";

import {
  automationEventListInputSchema,
  normalizeAutomationEventRecord,
  type AutomationEventRecord,
} from "./events";
import { automationFragmentSchema } from "./schema";

type AutomationEventServiceContext = DatabaseServiceContext<Record<string, never>>;

const normalizeAutomationEventRecords = (entries: unknown[]): AutomationEventRecord[] =>
  entries.map((entry) => normalizeAutomationEventRecord(entry));

export const createAutomationEventServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationEventServiceContext>,
  ) => TService,
) =>
  defineService({
    listEvents(input: { limit?: number; cursor?: Cursor } = {}) {
      const { limit = 100 } = automationEventListInputSchema.parse({ limit: input.limit });
      const cursor = input.cursor;
      const effectiveLimit = cursor?.pageSize ?? limit;

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_event", (b) => {
            const query = b
              .whereIndex("idx_automation_event_occurredAt_id")
              .orderByIndex("idx_automation_event_occurredAt_id", "desc")
              .pageSize(effectiveLimit);

            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([entries]) => ({
          events: normalizeAutomationEventRecords(entries.items),
          cursor: entries.cursor,
          hasNextPage: entries.hasNextPage,
        }))
        .build();
    },
  });
