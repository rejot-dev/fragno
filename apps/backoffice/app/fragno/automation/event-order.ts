/** What orders an event against another: when it occurred, when it was stored, and its ID. */
type OrderedEvent = { eventId: string; occurredAt: Date; storedAt: Date };

/**
 * The one order of events that states keep and their readers merge: providers deliver late, so the
 * time an event occurred decides, then the time it was stored, then its ID, so no two events tie.
 * IDs compare by code unit, as SQLite compares text; `EVENT_ORDER_SQL` states it again.
 */
export function compareEventOrder(left: OrderedEvent, right: OrderedEvent) {
  return (
    left.occurredAt.getTime() - right.occurredAt.getTime() ||
    left.storedAt.getTime() - right.storedAt.getTime() ||
    (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)
  );
}

/** `compareEventOrder` over `automation_event_state` columns, latest first. */
export const EVENT_ORDER_SQL = `"occurredAt" DESC, "storedAt" DESC, "eventId" DESC`;
