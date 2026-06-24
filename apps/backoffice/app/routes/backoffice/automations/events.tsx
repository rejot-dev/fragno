import { Link, useLoaderData, useLocation, useOutletContext } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";

import type { Route } from "./+types/events";
import { fetchAutomationEvents, type AutomationEventHookRecord } from "./data.server";
import { automationScopeFromRouteParams, automationScopeTabPath } from "./scope";
import type { AutomationLayoutContext } from "./shared";
import { formatTimestamp } from "./shared";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const parsePageSize = (value: string | null) => {
  if (!value) {
    return DEFAULT_PAGE_SIZE;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const eventsResult = await fetchAutomationEvents(request, context, scope, { cursor, pageSize });

  return {
    ...eventsResult,
    currentCursor: cursor ?? null,
    pageSize,
  };
}

const formatActor = (actor: AutomationEventHookRecord["actor"]) => {
  if (!actor) {
    return "—";
  }

  const source = actor.source ? `${actor.source}/` : "";
  return `${actor.scope}:${source}${actor.type}:${actor.id}`;
};

const formatScope = (scope: AutomationEventHookRecord["scope"]) => {
  if (!scope) {
    return "—";
  }

  switch (scope.kind) {
    case "org":
      return `org:${scope.orgId}`;
    case "project":
      return `project:${scope.orgId}/${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
    case "system":
      return "system";
  }
};

const jsonPreview = (value: unknown) => {
  if (value === null || value === undefined) {
    return "null";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const statusBadgeClass = (status: string) => {
  if (status === "completed") {
    return "border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
  }
  if (status === "failed") {
    return "border-red-400/40 bg-red-500/8 text-red-700 dark:text-red-200";
  }
  if (status === "pending" || status === "queued") {
    return "border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  }
  return "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
};

export default function BackofficeAutomationEvents() {
  const {
    configured,
    hooksEnabled,
    events,
    cursor,
    hasNextPage,
    eventsError,
    currentCursor,
    pageSize,
  } = useLoaderData<typeof loader>();
  const { selectedScope } = useOutletContext<AutomationLayoutContext>();
  const location = useLocation();
  const basePath = automationScopeTabPath(selectedScope, "events");
  const currentParams = new URLSearchParams(location.search);

  const pageHref = (nextCursor: string | null) => {
    const params = new URLSearchParams(currentParams);
    if (nextCursor) {
      params.set("cursor", nextCursor);
    } else {
      params.delete("cursor");
    }
    if (pageSize !== DEFAULT_PAGE_SIZE) {
      params.set("pageSize", String(pageSize));
    } else {
      params.delete("pageSize");
    }
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <section className="space-y-4">
      {eventsError ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          Could not load automation events: {eventsError}
        </div>
      ) : !configured ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          Automations are not configured for this scope yet.
        </div>
      ) : !hooksEnabled ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          Durable hooks are disabled for automation events in this scope.
        </div>
      ) : events.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No recent automation events are queued right now.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
            <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-3 py-2">
                    Event
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actor
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Scope
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Occurred
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Queued
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Attempts
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Payload
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {events.map((event) => (
                  <tr key={event.hookId} className="text-[var(--bo-muted)]">
                    <td className="px-3 py-3 align-top">
                      <div className="min-w-56">
                        <p className="font-mono text-xs text-[var(--bo-fg)]">
                          {event.source}.{event.eventType}
                        </p>
                        <p className="mt-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
                          {event.id ?? event.hookId}
                        </p>
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span
                        className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${statusBadgeClass(event.hookStatus)}`}
                      >
                        {event.hookStatus}
                      </span>
                      {event.error ? (
                        <p className="mt-2 max-w-64 text-xs whitespace-pre-wrap text-red-700 dark:text-red-200">
                          {event.error}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">
                        {formatActor(event.actor)}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">
                        {formatScope(event.scope)}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">{formatTimestamp(event.occurredAt)}</td>
                    <td className="px-3 py-3 align-top">{formatTimestamp(event.createdAt)}</td>
                    <td className="px-3 py-3 align-top">
                      {event.attempts} / {event.maxAttempts}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <details className="max-w-md">
                        <summary className="cursor-pointer text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)]">
                          View
                        </summary>
                        <pre className="backoffice-scroll mt-2 max-h-80 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                          <code>{jsonPreview(event.payload)}</code>
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
            <span>
              {events.length} event{events.length === 1 ? "" : "s"} shown · Page size {pageSize}
            </span>
            <div className="flex items-center gap-2">
              {currentCursor ? (
                <Link
                  to={pageHref(null)}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Newest
                </Link>
              ) : null}
              {hasNextPage && cursor ? (
                <Link
                  to={pageHref(cursor)}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  Next page
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  throw error;
}
