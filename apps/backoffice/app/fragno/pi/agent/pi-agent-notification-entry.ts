import type { PiAgentNotification } from "./pi-agent-contract";

/**
 * The transcript entry an event notification writes. The chat renders it as an event card; users
 * submit only inputs, which Pi writes as `pi.user`, so no one can type one. Typing a request, by
 * contrast, only restyles the typist's own message.
 */
export const PI_NOTIFICATION_ENTRY_KIND = "backoffice.notification";

/** One notification entry, by the route that delivered it and the event it carries. */
export type PiNotificationReference = { routeId: string; eventId: string };

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unescapeAttribute(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

const REQUEST_PATTERN =
  /^<backoffice-notifications-request>\n((?:<notification route="[^"]*" event="[^"]*"\/>\n)+)<\/backoffice-notifications-request>$/u;
const REQUEST_ITEM_PATTERN = /<notification route="([^"]*)" event="([^"]*)"\/>/gu;

/**
 * The follow-up input that asks the agent to handle notifications. It names each one by the
 * `route` and `id` of its `<backoffice-event>`, since one event can reach an agent through two
 * routes.
 */
export function renderPiNotificationRequest(notifications: readonly PiNotificationReference[]) {
  const items = notifications.map(
    ({ routeId, eventId }) =>
      `<notification route="${escapeAttribute(routeId)}" event="${escapeAttribute(eventId)}"/>\n`,
  );
  return `<backoffice-notifications-request>\n${items.join("")}</backoffice-notifications-request>`;
}

/** The notifications a follow-up asks for, or null when the text is not exactly one request. */
export function parsePiNotificationRequest(text: string): PiNotificationReference[] | null {
  const items = REQUEST_PATTERN.exec(text)?.[1];
  if (items === undefined) {
    return null;
  }
  return [...items.matchAll(REQUEST_ITEM_PATTERN)].map(([, routeId, eventId]) => ({
    routeId: unescapeAttribute(routeId),
    eventId: unescapeAttribute(eventId),
  }));
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
    ["route", routeId],
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
