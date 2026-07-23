import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { jsonSchemaToTypeScript } from "@/lib/zod/zod-formatter";

import type { AutomationLayoutContext } from "./layout-context";

const formatPayloadType = (schema: unknown) =>
  jsonSchemaToTypeScript(schema as Parameters<typeof jsonSchemaToTypeScript>[0]);

const formatJsonSchema = (schema: unknown) => {
  if (schema === null || schema === undefined) {
    return "null";
  }

  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
};

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

const searchableText = (event: {
  source: string;
  eventType: string;
  label: string;
  description?: string;
  capabilityId: string;
}) =>
  [event.source, event.eventType, event.label, event.description ?? "", event.capabilityId]
    .join("\n")
    .toLowerCase();

export default function BackofficeAutomationEventsCatalog() {
  const { collections } = useOutletContext<AutomationLayoutContext>();
  const staticEvents = useMemo(
    () =>
      listAutomationEventDescriptors().sort(
        (left, right) =>
          left.source.localeCompare(right.source) || left.eventType.localeCompare(right.eventType),
      ),
    [],
  );
  const eventDefinitionsQuery = useLiveQuery(
    (query) =>
      query
        .from({ definition: collections.eventDefinitions })
        .orderBy(({ definition }) => definition.source, "asc")
        .orderBy(({ definition }) => definition.eventType, "asc")
        .select(({ definition }) => ({
          id: definition.id,
          source: definition.source,
          eventType: definition.eventType,
          label: definition.label,
          description: definition.description,
          payloadSchema: definition.payloadSchema,
          actorSchema: definition.actorSchema,
          subjectSchema: definition.subjectSchema,
          example: definition.example,
          enabled: definition.enabled,
        })),
    [collections.eventDefinitions],
  );
  const eventDefinitions = (eventDefinitionsQuery.data ?? []).map((definition) => ({
    ...definition,
    capabilityId: "dynamic",
  }));
  const eventDefinitionsError = eventDefinitionsQuery.isError
    ? collections.eventDefinitions.utils.getLastError()
    : null;
  const eventDefinitionsErrorMessage = eventDefinitionsError
    ? eventDefinitionsError instanceof Error
      ? eventDefinitionsError.message
      : "Automation event definition synchronization failed."
    : null;
  const [payloadFormat, setPayloadFormat] = useState<"typescript" | "jsonschema">("typescript");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(25);
  const events = useMemo(
    () =>
      [
        ...staticEvents,
        ...eventDefinitions.map((event) => ({
          ...event,
          description: event.description ?? undefined,
          payloadSchema: event.payloadSchema ?? undefined,
          actorSchema: event.actorSchema ?? undefined,
          subjectSchema: event.subjectSchema ?? undefined,
          example: event.example ?? undefined,
        })),
      ].sort(
        (left, right) =>
          left.source.localeCompare(right.source) || left.eventType.localeCompare(right.eventType),
      ),
    [eventDefinitions, staticEvents],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredEvents = useMemo(
    () =>
      normalizedSearch
        ? events.filter((event) => searchableText(event).includes(normalizedSearch))
        : events,
    [events, normalizedSearch],
  );
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const pageStartIndex = (clampedPage - 1) * pageSize;
  const pageEvents = filteredEvents.slice(pageStartIndex, pageStartIndex + pageSize);
  const pageRangeStart = filteredEvents.length === 0 ? 0 : pageStartIndex + 1;
  const pageRangeEnd = Math.min(filteredEvents.length, pageStartIndex + pageSize);

  useEffect(() => {
    setPage(1);
  }, [normalizedSearch, pageSize]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  return (
    <section className="w-full max-w-7xl space-y-3">
      {eventDefinitionsQuery.isLoading && eventDefinitions.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-sm text-[var(--bo-muted)]">
          Loading dynamic event definitions…
        </div>
      ) : null}
      {eventDefinitionsErrorMessage ? (
        <div className="border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          Could not synchronize dynamic event definitions: {eventDefinitionsErrorMessage}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex min-w-72 flex-1 flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Search catalog
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
            placeholder="source, event type, label, capability…"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] transition-colors outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
          />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Per page
            </span>
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(
                  Number(event.currentTarget.value) as (typeof PAGE_SIZE_OPTIONS)[number],
                );
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
            <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Payload format
            </span>
            <div
              role="radiogroup"
              aria-label="Payload format"
              className="flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
            >
              {(
                [
                  { value: "typescript", label: "TypeScript" },
                  { value: "jsonschema", label: "JSON Schema" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={payloadFormat === option.value}
                  onClick={() => {
                    setPayloadFormat(option.value);
                  }}
                  className={
                    payloadFormat === option.value
                      ? "bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                      : "px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:text-[var(--bo-fg)]"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
        <p>
          Showing {pageRangeStart}–{pageRangeEnd} of {filteredEvents.length} event
          {filteredEvents.length === 1 ? "" : "s"}
          {filteredEvents.length === events.length ? "" : ` filtered from ${events.length}`}
        </p>
        {normalizedSearch ? (
          <button
            type="button"
            onClick={() => {
              setSearch("");
            }}
            className="text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors hover:text-[var(--bo-fg)]"
          >
            Clear search
          </button>
        ) : null}
      </div>

      <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
        <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
          <thead className="bg-[var(--bo-panel-2)] text-left">
            <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              <th scope="col" className="px-3 py-2">
                Capability
              </th>
              <th scope="col" className="px-3 py-2">
                Event
              </th>
              <th scope="col" className="px-3 py-2">
                Payload
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
            {pageEvents.map((event) => (
              <tr key={`${event.source}:${event.eventType}`} className="text-[var(--bo-muted)]">
                <td className="px-3 py-3 align-top">
                  <span className="font-mono text-xs text-[var(--bo-fg)]">
                    {event.capabilityId}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="min-w-64">
                    <p className="font-mono text-[10px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      {event.source}
                    </p>
                    <p className="mt-1 font-mono text-xs text-[var(--bo-fg)]">{event.eventType}</p>
                    <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">{event.label}</p>
                    {event.description ? (
                      <p className="mt-1 max-w-md text-xs text-[var(--bo-muted-2)]">
                        {event.description}
                      </p>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <pre className="backoffice-scroll max-h-80 max-w-2xl overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                    <code>
                      {payloadFormat === "typescript"
                        ? formatPayloadType(event.payloadSchema)
                        : formatJsonSchema(event.payloadSchema)}
                    </code>
                  </pre>
                </td>
              </tr>
            ))}
            {pageEvents.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-10 text-center text-sm text-[var(--bo-muted)]">
                  No catalog events match your search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2">
        <p className="text-xs text-[var(--bo-muted)]">
          Page {clampedPage} of {pageCount}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={clampedPage <= 1}
            onClick={() => {
              setPage((current) => Math.max(1, current - 1));
            }}
            className="border border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={clampedPage >= pageCount}
            onClick={() => {
              setPage((current) => Math.min(pageCount, current + 1));
            }}
            className="border border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
