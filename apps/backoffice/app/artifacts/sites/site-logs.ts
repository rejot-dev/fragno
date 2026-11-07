import type { ArtifactSiteLogEntry } from "@fragno-dev/backoffice-api/v0/artifacts";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

/** What is kept of a site's requests, so its logs stay small however much its Worker prints. */
export const SITE_LOG_LIMITS = {
  /** Requests kept per site; older ones are dropped as new ones arrive. */
  entriesPerSite: 200,
  /** How long a request is kept. */
  keptMs: 24 * 60 * 60 * 1000,
  /** Log lines kept per request. */
  logsPerEntry: 50,
  /** Characters kept of a log line or an exception's message. */
  messageChars: 2000,
  stackChars: 4000,
};

/**
 * What the host tells a site's tail about the Worker it watches. A Worker loaded for one request an
 * agent sends carries that request's `probe`, so its record reaches the agent even when quiet.
 */
export type SiteTailProps = { scope: BackofficeContextScope; sitePath: string; probe?: string };

/** The parts of a Workers trace item, which a tail receives for each request, that logs keep. */
export type SiteTraceItem = {
  eventTimestamp: number | null;
  event: unknown;
  logs: readonly { level: string; message: unknown }[];
  exceptions: readonly { name: string; message: string; stack?: string }[];
  outcome: string;
  cpuTime?: number;
  wallTime?: number;
};

/** Where a site's tail keeps what it received, and hands a probe's record to the agent waiting. */
export type SiteLogsSink = {
  append(
    scope: BackofficeContextScope,
    sitePath: string,
    entries: ArtifactSiteLogEntry[],
    probe: SiteProbeReport | null,
  ): Promise<void>;
};

/** The record of the request an agent sent, whether or not the logs keep it. */
export type SiteProbeReport = { id: string; entry: ArtifactSiteLogEntry };

/**
 * Keeps the requests among `traces` that logged, threw, exceeded a limit, or answered 5xx; requests
 * that went well and printed nothing are not kept. A probe's request reaches the agent who sent it
 * either way.
 */
export async function recordSiteTraces(
  traces: readonly SiteTraceItem[],
  props: SiteTailProps,
  sink: SiteLogsSink,
): Promise<void> {
  const reported = traces.map(siteLogEntry);
  const entries = reported.filter(
    (entry) =>
      entry.outcome !== "ok" ||
      entry.logs.length > 0 ||
      entry.exceptions.length > 0 ||
      (entry.status !== null && entry.status >= 500),
  );
  // A probe's Worker is loaded for its one request.
  const [probed] = reported;
  const probe = props.probe && probed ? { id: props.probe, entry: probed } : null;
  if (entries.length > 0 || probe) {
    await sink.append(props.scope, props.sitePath, entries, probe);
  }
}

/** Whether a request failed: it threw, exceeded a limit, answered 5xx, or logged an error. */
export function isSiteLogError(entry: ArtifactSiteLogEntry): boolean {
  return (
    entry.outcome !== "ok" ||
    entry.exceptions.length > 0 ||
    (entry.status !== null && entry.status >= 500) ||
    entry.logs.some(({ level }) => level === "error")
  );
}

function siteLogEntry(trace: SiteTraceItem): ArtifactSiteLogEntry {
  const event = fetchEvent(trace.event);
  let path: string | null = null;
  if (event?.url) {
    const url = new URL(event.url);
    path = `${url.pathname}${url.search}`;
  }
  return {
    at: new Date(trace.eventTimestamp ?? Date.now()).toISOString(),
    method: event?.method ?? null,
    path,
    status: event?.status ?? null,
    outcome: trace.outcome,
    cpuMs: trace.cpuTime ?? null,
    wallMs: trace.wallTime ?? null,
    logs: trace.logs.slice(0, SITE_LOG_LIMITS.logsPerEntry).map(({ level, message }) => ({
      level,
      message: clip(logMessage(message), SITE_LOG_LIMITS.messageChars),
    })),
    exceptions: trace.exceptions.map(({ name, message, stack }) => ({
      name,
      message: clip(message, SITE_LOG_LIMITS.messageChars),
      stack: stack ? clip(stack, SITE_LOG_LIMITS.stackChars) : null,
    })),
  };
}

/** The request and response of a fetch event, which other events lack. */
function fetchEvent(event: unknown): { method?: string; url?: string; status?: number } | null {
  if (typeof event !== "object" || event === null || !("request" in event)) {
    return null;
  }
  const { request, response } = event as {
    request?: { method?: unknown; url?: unknown };
    response?: { status?: unknown } | null;
  };
  return {
    method: typeof request?.method === "string" ? request.method : undefined,
    url: typeof request?.url === "string" ? request.url : undefined,
    status: typeof response?.status === "number" ? response.status : undefined,
  };
}

/** A console call's arguments, as one line: strings as they are, other values as JSON. */
function logMessage(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];
  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      try {
        return JSON.stringify(part) ?? String(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}
