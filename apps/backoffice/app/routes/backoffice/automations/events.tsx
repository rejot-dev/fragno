import { Fragment, useState } from "react";
import { useOutletContext } from "react-router";

import { and, eq, lt, or, useLiveQuery } from "@tanstack/react-db";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { AutomationEventActor } from "@/fragno/automation/contracts";

import type { Route } from "./+types/events";
import { formatTimestamp } from "./formatting";
import type { AutomationLayoutContext } from "./shared";

const actorIdentity = (actor: AutomationEventActor) =>
  `${actor.scope}:${actor.source ?? ""}:${actor.type}:${actor.id}`;

const collectActors = (event: { actor: AutomationEventActor; actors: AutomationEventActor[] }) => {
  const actorsByIdentity = new Map<string, AutomationEventActor>();

  actorsByIdentity.set(actorIdentity(event.actor), event.actor);
  for (const actor of event.actors) {
    actorsByIdentity.set(actorIdentity(actor), actor);
  }

  return [...actorsByIdentity.values()];
};

const formatActor = (actor: AutomationEventActor | null) => {
  if (!actor) {
    return "—";
  }

  const source = actor.source ? `${actor.source}/` : "";
  return `${actor.scope}:${source}${actor.type}:${actor.id}`;
};

const formatScope = (scope: BackofficeContextScope | null) => {
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

  throw new Error("Unsupported automation event scope kind.");
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

const EVENTS_PAGE_SIZE = 10;

type AutomationEventCursor = {
  occurredAt: Date;
  id: string;
};

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Automation event synchronization failed.";

export default function BackofficeAutomationEvents() {
  const { collections } = useOutletContext<AutomationLayoutContext>();
  const [pageCursors, setPageCursors] = useState<AutomationEventCursor[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState(() => new Set<string>());
  const pageCursor = pageCursors.at(-1);
  const page = pageCursors.length + 1;
  const eventsQuery = useLiveQuery(
    (query) => {
      const events = query.from({ event: collections.events });
      const cursorPage = pageCursor
        ? events.where(({ event }) =>
            or(
              lt(event.occurredAt, pageCursor.occurredAt),
              and(eq(event.occurredAt, pageCursor.occurredAt), lt(event.id, pageCursor.id)),
            ),
          )
        : events;

      return cursorPage
        .orderBy(({ event }) => event.occurredAt, "desc")
        .orderBy(({ event }) => event.id, "desc")
        .limit(EVENTS_PAGE_SIZE + 1)
        .select(({ event }) => ({
          id: event.id,
          scope: event.scope,
          source: event.source,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          payload: event.payload,
          actor: event.actor,
          actors: event.actors,
          createdAt: event.createdAt,
        }));
    },
    [collections.events, pageCursor],
  );
  const pageRows = eventsQuery.data ?? [];
  const hasNextPage = pageRows.length > EVENTS_PAGE_SIZE;
  const nextPageBoundary = hasNextPage ? pageRows[EVENTS_PAGE_SIZE - 1] : undefined;
  const nextPageCursor = nextPageBoundary
    ? { occurredAt: nextPageBoundary.occurredAt, id: nextPageBoundary.id }
    : null;
  const events = pageRows.slice(0, EVENTS_PAGE_SIZE);
  const eventsError = eventsQuery.isError
    ? toErrorMessage(collections.events.utils.getLastError())
    : null;

  const togglePayload = (eventId: string) => {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  return (
    <section className="space-y-4">
      {eventsQuery.isLoading && events.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          Loading automation events…
        </div>
      ) : eventsError && events.length === 0 ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          Could not synchronize automation events: {eventsError}
        </div>
      ) : events.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          {pageCursors.length > 0
            ? "No automation events remain on this page."
            : "No automation events have been recorded for this scope yet."}
        </div>
      ) : (
        <div className="w-full max-w-7xl space-y-3">
          {eventsError ? (
            <div className="border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
              Could not synchronize all automation events: {eventsError}
            </div>
          ) : null}
          <div className="backoffice-scroll w-full [scrollbar-gutter:stable] overflow-x-auto border border-[color:var(--bo-border)]">
            <table className="w-full table-fixed divide-y divide-[color:var(--bo-border)] text-sm">
              <colgroup>
                <col className="w-12" />
                <col className="w-[34%]" />
                <col className="w-[30%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Payload</span>
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Event
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actor
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Scope
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Logged at
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {events.map((event) => {
                  const isExpanded = expandedEventIds.has(event.id);
                  const actors = collectActors(event);

                  return (
                    <Fragment key={event.id}>
                      <tr
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        aria-controls={`automation-event-payload-${event.id}`}
                        onClick={() => {
                          togglePayload(event.id);
                        }}
                        onKeyDown={(keyboardEvent) => {
                          if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                            keyboardEvent.preventDefault();
                            togglePayload(event.id);
                          }
                        }}
                        className="cursor-pointer text-[var(--bo-muted)] transition-colors hover:bg-[var(--bo-panel-2)] focus:bg-[var(--bo-panel-2)] focus:outline-none"
                      >
                        <td className="px-2 py-2 align-top">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-controls={`automation-event-payload-${event.id}`}
                            onClick={(mouseEvent) => {
                              mouseEvent.stopPropagation();
                              togglePayload(event.id);
                            }}
                            className="flex h-10 w-10 items-center justify-center text-[var(--bo-muted)] transition-transform hover:text-[var(--bo-fg)] active:scale-[0.96]"
                          >
                            <span className="sr-only">
                              {isExpanded ? "Hide payload" : "Show payload"}
                            </span>
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 16 16"
                              className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            >
                              <path fill="currentColor" d="M6 3.5 10.5 8 6 12.5z" />
                            </svg>
                          </button>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="min-w-56">
                            <p className="truncate font-mono text-xs text-[var(--bo-fg)]">
                              {event.source}.{event.eventType}
                            </p>
                            <p className="mt-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
                              {event.id}
                            </p>
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="space-y-1">
                            {actors.map((actor) => (
                              <p
                                key={actorIdentity(actor)}
                                className="truncate font-mono text-xs text-[var(--bo-fg)]"
                              >
                                {formatActor(actor)}
                              </p>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span className="block truncate font-mono text-xs text-[var(--bo-fg)]">
                            {formatScope(event.scope)}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-top tabular-nums">
                          {formatTimestamp(event.createdAt)}
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr id={`automation-event-payload-${event.id}`}>
                          <td colSpan={5} className="bg-[var(--bo-panel)] px-3 pb-4 pl-14">
                            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                              <p className="mb-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                                Payload
                              </p>
                              <pre className="backoffice-scroll max-h-96 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                                <code>{jsonPreview(event.payload)}</code>
                              </pre>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {events.length > 0 || pageCursors.length > 0 ? (
        <div className="flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 text-xs text-[var(--bo-muted-2)]">
          <span>
            {events.length} event{events.length === 1 ? "" : "s"} shown · Page {page}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageCursors.length === 0}
              onClick={() => {
                setPageCursors((current) => current.slice(0, -1));
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!nextPageCursor}
              onClick={() => {
                if (nextPageCursor) {
                  setPageCursors((current) => [...current, nextPageCursor]);
                }
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  throw error;
}
