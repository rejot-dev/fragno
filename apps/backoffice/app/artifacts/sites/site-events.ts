/**
 * What a site's Worker may fire. Each viewer's limit is the `SITE_EVENTS` rate limit of the
 * wrangler configs, which deployed Workers count by.
 */
export const SITE_EVENT_LIMITS = {
  typeChars: 200,
  /** Bytes of the payload as JSON, in UTF-8. */
  payloadBytes: 64 * 1024,
  /** Events one viewer fires on a site per period; events that name no viewer share one count. */
  perViewer: 60,
  periodSeconds: 10,
} as const;

const SITE_EVENT_SOURCE_PREFIX = "site:";

/** The source of every event a site's Worker fires, such as `site:/workspace/tools/shop.site`. */
export function siteEventSource(sitePath: string): string {
  return `${SITE_EVENT_SOURCE_PREFIX}${sitePath}`;
}

/** Automations trust these sources, so only the site's Worker may fire them. */
export function isSiteEventSource(source: string): boolean {
  return source.startsWith(SITE_EVENT_SOURCE_PREFIX);
}

/**
 * An event a site's Worker fires: its type, its payload, and the viewer it concerns, whom the
 * event names as its subject. The viewer is the Worker's word; it grants the event nothing.
 */
export type SiteEvent = { type: string; payload: Record<string, unknown>; viewer: string | null };

/** An event the Worker of a request an agent sent fired, with its id when it was fired. */
export type SiteProbeEvent = SiteEvent & { eventId: string | null };

/**
 * What firing came to: the event's id, the event kept for the request an agent sent instead of
 * fired, or why it was not fired.
 */
export type SiteFireResult =
  | { status: "fired"; eventId: string }
  | { status: "recorded" }
  | { status: "error"; message: string };

/** The message of an event over its viewer's limit. */
export const SITE_EVENTS_LIMITED = `A viewer fires at most ${SITE_EVENT_LIMITS.perViewer} events every ${SITE_EVENT_LIMITS.periodSeconds} seconds on a site.`;

/**
 * The event as automations receive it, its payload as JSON reads it, or why a site cannot fire it.
 * The site's `env.DATA` checks it too; this is what holds.
 */
export function checkedSiteEvent(event: SiteEvent): { event: SiteEvent } | { problem: string } {
  const { type, payload, viewer } = event;
  if (typeof type !== "string" || type.trim() === "") {
    return { problem: 'An event\'s type is text, such as "order.placed".' };
  }
  if (type.length > SITE_EVENT_LIMITS.typeChars) {
    return { problem: `An event's type is at most ${SITE_EVENT_LIMITS.typeChars} characters.` };
  }
  if (viewer !== null && (typeof viewer !== "string" || viewer.trim() === "")) {
    return { problem: "An event's viewer is the viewer's id, or null." };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { problem: "An event's payload is an object." };
  }
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    return { problem: `An event's payload is JSON: ${String(error)}` };
  }
  if (new TextEncoder().encode(json).byteLength > SITE_EVENT_LIMITS.payloadBytes) {
    return {
      problem: `An event's payload is at most ${SITE_EVENT_LIMITS.payloadBytes / 1024} KB of JSON.`,
    };
  }
  return {
    event: { type: type.trim(), payload: JSON.parse(json) as Record<string, unknown>, viewer },
  };
}
