import { automationEventListInputSchema } from "@fragno-dev/backoffice-api/v0/events";

import { decodeCursor, type Cursor, type DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type AutomationEventServiceContext = DatabaseServiceContext<Record<string, never>>;

const EVENTS_OF_TYPE_INDEX = "idx_automation_event_source_type_occurredAt";
const EVENTS_OF_TYPE_PAGE_SIZE = 100;
/** Cursors of `listEvents` name the index their page was read from. */
export const EVENTS_BY_TIME_INDEX = "idx_automation_event_occurredAt_id";

/** Our own cursors come back through callers, so one for another source or type is rejected. */
function decodeEventsOfTypeCursor(input: { source: string; eventType: string; cursor: string }) {
  const cursor = decodeCursor(input.cursor);
  if (
    cursor.indexName !== EVENTS_OF_TYPE_INDEX ||
    cursor.orderDirection !== "desc" ||
    cursor.indexValues.source !== input.source ||
    cursor.indexValues.eventType !== input.eventType
  ) {
    throw new Error("Cursor is not valid for these automation events.");
  }
  return cursor;
}

export const createAutomationEventServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationEventServiceContext>,
  ) => TService,
) =>
  defineService({
    getEvent(input: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .transformRetrieve(([event]) => event ?? null)
        .build();
    },
    /** One source's events of one type, newest first. */
    listEventsOfType(input: { source: string; eventType: string; cursor: string | null }) {
      const cursor =
        input.cursor === null ? null : decodeEventsOfTypeCursor({ ...input, cursor: input.cursor });
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_event", (b) => {
            const query = b
              .whereIndex(EVENTS_OF_TYPE_INDEX, (eb) =>
                eb.and(eb("source", "=", input.source), eb("eventType", "=", input.eventType)),
              )
              .orderByIndex(EVENTS_OF_TYPE_INDEX, "desc")
              .pageSize(EVENTS_OF_TYPE_PAGE_SIZE);
            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([page]) => ({
          events: page.items,
          cursor: page.hasNextPage && page.cursor ? page.cursor.encode() : null,
        }))
        .build();
    },
    listEvents(input: { limit?: number; cursor?: Cursor } = {}) {
      const { limit = 100 } = automationEventListInputSchema.parse({ limit: input.limit });
      const cursor = input.cursor;
      const effectiveLimit = cursor?.pageSize ?? limit;

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_event", (b) => {
            const query = b
              .whereIndex(EVENTS_BY_TIME_INDEX)
              .orderByIndex(EVENTS_BY_TIME_INDEX, "desc")
              .pageSize(effectiveLimit)
              // Each event's matched routes come with it, so one read lists both.
              .joinMany("routes", "automation_route_dispatch", (route) =>
                route.onIndex("idx_automation_route_dispatch_eventId", (eb) =>
                  eb("eventId", "=", eb.parent("id")),
                ),
              );

            return cursor ? query.after(cursor) : query;
          }),
        )
        .transformRetrieve(([entries]) => ({
          events: entries.items,
          cursor: entries.cursor,
          hasNextPage: entries.hasNextPage,
        }))
        .build();
    },
  });
