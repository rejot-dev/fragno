import { automationEventListInputSchema } from "@fragno-dev/backoffice-api/v0/events";

import { decodeCursor, type Cursor, type DatabaseServiceContext } from "@fragno-dev/db";

import { automationFragmentSchema } from "./schema";

type AutomationEventServiceContext = DatabaseServiceContext<Record<string, never>>;

const EVENTS_OF_TYPE_INDEX = "idx_automation_event_source_type_occurredAt";
const EVENTS_OF_TYPE_PAGE_SIZE = 100;
/** Cursors of `listEvents` name the index their page was read from. */
export const EVENTS_BY_TIME_INDEX = "idx_automation_event_occurredAt_id";

/** More than a page of arrivals, and few enough rows to stay below Durable Object SQLite's limits. */
const EVENTS_DELETED_PER_PASS = 50;

/** Our own cursors come back through callers, so one for another source or type is rejected. */
function decodeEventsOfTypeCursor(input: {
  source: string;
  eventType: string;
  cursor: string;
  orderDirection: "asc" | "desc";
}) {
  const cursor = decodeCursor(input.cursor);
  if (
    cursor.indexName !== EVENTS_OF_TYPE_INDEX ||
    cursor.orderDirection !== input.orderDirection ||
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
        input.cursor === null
          ? null
          : decodeEventsOfTypeCursor({ ...input, cursor: input.cursor, orderDirection: "desc" });
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
    /**
     * Deletes one pass of a type's events, oldest first, together with their outbox history, so a
     * browser replaying the outbox never downloads them. Browsers already holding them drop them
     * through the truncate notice. Route dispatch records are kept: a route still retrying reads
     * the event from its hook and settles through its dispatch record.
     */
    deleteEventsOfType(input: EventDeletionPass) {
      const cursor =
        input.cursor === null
          ? null
          : decodeEventsOfTypeCursor({ ...input, cursor: input.cursor, orderDirection: "asc" });
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findWithCursor("automation_event", (b) => {
            const query = b
              .whereIndex(EVENTS_OF_TYPE_INDEX, (eb) =>
                eb.and(
                  eb("source", "=", input.source),
                  eb("eventType", "=", input.eventType),
                  eb("occurredAt", "<", input.occurredBefore),
                ),
              )
              .orderByIndex(EVENTS_OF_TYPE_INDEX, "asc")
              .pageSize(EVENTS_DELETED_PER_PASS)
              .withOutboxMutations();
            return cursor ? query.after(cursor) : query;
          }),
        )
        .mutate(({ uow, retrieveResult: [page] }) => {
          const deletable = page.items.filter((event) => isDeletableEvent(event, input));
          if (!input.dryRun && deletable.length > 0) {
            uow.deleteMany(
              "automation_event",
              deletable.map((event) => event.id),
              (b) => b.check().omitOutbox(),
            );
            uow.outbox.deleteMutations(
              deletable.flatMap((event) => event.$outboxMutations.map((mutation) => mutation.id)),
            );
            uow.outbox.notifyTruncate("automation_event", {
              match: { source: input.source, eventType: input.eventType },
              externalIds: deletable.map((event) => event.id.externalId),
            });
          }
          return {
            scanned: page.items.length,
            deleted: deletable.length,
            cursor: page.hasNextPage && page.cursor ? page.cursor.encode() : null,
          };
        })
        .build();
    },
  });

/** Narrows a deletion to events whose top-level payload field holds one of the values. */
export type EventPayloadFilter = { field: string; values: readonly string[] };

export type EventDeletionPass = {
  source: string;
  eventType: string;
  occurredBefore: Date;
  /**
   * Events stored since are kept. Their completed ingestion hook can still be stored, and a
   * redelivery would recreate the deleted event under the hook's ID, which it rejects.
   */
  storedBefore: Date;
  payloadFilter: EventPayloadFilter | null;
  /** From the previous pass; passes skip rows they keep, so only a cursor moves past them. */
  cursor: string | null;
  /** Counts what the pass would delete without deleting it. */
  dryRun: boolean;
};

function isDeletableEvent(
  event: { routesMatched: boolean; createdAt: Date; payload: Record<string, unknown> },
  { storedBefore, payloadFilter }: Pick<EventDeletionPass, "storedBefore" | "payloadFilter">,
) {
  // Deleting an event before its routes are matched would leave them unmatched for good.
  if (!event.routesMatched || event.createdAt >= storedBefore) {
    return false;
  }
  if (payloadFilter === null) {
    return true;
  }
  const value = event.payload[payloadFilter.field];
  return typeof value === "string" && payloadFilter.values.includes(value);
}
