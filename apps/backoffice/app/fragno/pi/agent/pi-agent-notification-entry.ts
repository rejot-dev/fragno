import {
  PI_NOTIFICATION_ENTRY_KIND,
  renderPiNotification,
  type PiAgentNotification,
} from "@fragno-dev/backoffice-api/v0/pi-conversation/notification-entry";

import { PI_INTERNAL_REQUEST_ID_PREFIX } from "./pi-agent-contract";

/**
 * A notification's request ID in its agent's queue, so redelivering one event through one route,
 * or to the agent directly, is recognized. Its entry is written as `<requestId>:event`.
 */
export function piNotificationRequestId({ routeId, event }: PiAgentNotification) {
  return routeId === null
    ? `${PI_INTERNAL_REQUEST_ID_PREFIX.reply}${event.id}`
    : `${PI_INTERNAL_REQUEST_ID_PREFIX.route}${routeId}:${event.id}`;
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
