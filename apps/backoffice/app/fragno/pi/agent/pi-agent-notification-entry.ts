import { PI_INTERNAL_REQUEST_ID_PREFIX, type PiAgentNotification } from "./pi-agent-contract";
import { escapeAttribute, unescapeAttribute } from "./xml-attribute";

/**
 * The transcript entry an event notification writes. The chat renders it as an event card; users
 * submit only inputs, which Pi writes as `pi.user`, so no one can type one. Typing a request, by
 * contrast, only restyles the typist's own message.
 */
export const PI_NOTIFICATION_ENTRY_KIND = "backoffice.notification";

/** One notification entry, by the route that delivered it, if any, and the event it carries. */
export type PiNotificationReference = { routeId: string | null; eventId: string };

/**
 * A notification's request ID in its agent's queue, so redelivering one event through one route,
 * or to the agent directly, is recognized. Its entry is written as `<requestId>:event`.
 */
export function piNotificationRequestId({ routeId, event }: PiAgentNotification) {
  return routeId === null
    ? `${PI_INTERNAL_REQUEST_ID_PREFIX.reply}${event.id}`
    : `${PI_INTERNAL_REQUEST_ID_PREFIX.route}${routeId}:${event.id}`;
}

const REQUEST_PATTERN =
  /^<backoffice-notifications-request>\n((?:<notification (?:route="[^"]*" )?event="[^"]*"\/>\n)+)<\/backoffice-notifications-request>$/u;
const REQUEST_ITEM_PATTERN = /<notification (?:route="([^"]*)" )?event="([^"]*)"\/>/gu;

/**
 * The input of a turn that handles notifications, submitted below their entries. It names each
 * by the `route` and `id` of its `<backoffice-event>`, since one event can reach an agent through
 * two routes. An event addressed to the agent has no route.
 */
export function renderPiNotificationRequest(notifications: readonly PiNotificationReference[]) {
  const items = notifications.map(
    ({ routeId, eventId }) =>
      `<notification ${routeId === null ? "" : `route="${escapeAttribute(routeId)}" `}event="${escapeAttribute(eventId)}"/>\n`,
  );
  return `<backoffice-notifications-request>\n${items.join("")}</backoffice-notifications-request>`;
}

/** The notifications a request asks for, or null when the text is not exactly one request. */
export function parsePiNotificationRequest(text: string): PiNotificationReference[] | null {
  const items = REQUEST_PATTERN.exec(text)?.[1];
  if (items === undefined) {
    return null;
  }
  return [...items.matchAll(REQUEST_ITEM_PATTERN)].map(([, routeId, eventId]) => ({
    routeId: routeId === undefined ? null : unescapeAttribute(routeId),
    eventId: unescapeAttribute(eventId),
  }));
}

/**
 * A notification that joins a running turn, as the input Pi places: the event as the model reads
 * it, shown as its card. No request follows it; the turn it joins handles it.
 */
export function piNotificationInput(notification: PiAgentNotification) {
  return {
    requestId: piNotificationRequestId(notification),
    content: renderPiNotification(notification),
    entry: { kind: PI_NOTIFICATION_ENTRY_KIND, data: notification },
  };
}

/**
 * The text the model reads for a notification. Payloads can carry text from outside Backoffice,
 * so `<` is escaped inside the JSON and the data can never close the element.
 */
export function renderPiNotification({ routeId, event }: PiAgentNotification) {
  const attributes = [
    ["id", event.id],
    ["source", event.source],
    ["type", event.eventType],
    ...(routeId === null ? [] : [["route", routeId]]),
    ["occurred-at", event.occurredAt],
  ]
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(" ");
  const data = JSON.stringify({ subject: event.subject, payload: event.payload }).replaceAll(
    "<",
    "\\u003c",
  );
  return `<backoffice-event ${attributes}>\n${data}\n</backoffice-event>`;
}
