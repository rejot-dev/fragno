/** What orders an event against another: when it occurred, its sequence, when it was stored, its ID. */
type OrderedEvent = {
  eventId: string;
  occurredAt: Date;
  sequence: string | null;
  storedAt: Date;
};

function isSurrogate(codeUnit: number) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

/**
 * Compares text by code point, which is how SQLite orders it: by UTF-8 byte. UTF-16 code units,
 * which `<` compares, follow code points except that surrogates, which encode the code points above
 * U+FFFF, sort below U+E000 to U+FFFF.
 */
function compareText(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit !== rightUnit) {
      return isSurrogate(leftUnit) === isSurrogate(rightUnit)
        ? leftUnit - rightUnit
        : isSurrogate(leftUnit)
          ? 1
          : -1;
    }
  }
  return left.length - right.length;
}

/**
 * The one order of events that states keep and their readers merge: providers deliver late, so the
 * time an event occurred decides. Within a millisecond, the sequence its source gave it decides,
 * as events can be stored in another order than they were recorded; an event without one comes
 * first, as SQLite sorts null. Then the time it was stored, then its ID, so no two events tie.
 * `EVENT_ORDER_SQL` states it again, and text compares as SQLite compares it.
 */
export function compareEventOrder(left: OrderedEvent, right: OrderedEvent) {
  return (
    left.occurredAt.getTime() - right.occurredAt.getTime() ||
    (left.sequence === right.sequence
      ? 0
      : left.sequence === null
        ? -1
        : right.sequence === null
          ? 1
          : compareText(left.sequence, right.sequence)) ||
    left.storedAt.getTime() - right.storedAt.getTime() ||
    compareText(left.eventId, right.eventId)
  );
}

/** `compareEventOrder` over `automation_event_state` columns, latest first. */
export const EVENT_ORDER_SQL = `"occurredAt" DESC, "sequence" DESC, "storedAt" DESC, "eventId" DESC`;
