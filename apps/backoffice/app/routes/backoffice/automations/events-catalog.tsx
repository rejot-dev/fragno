import { useState } from "react";
import { useLoaderData } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { jsonSchemaToTypeScript } from "@/lib/zod/zod-formatter";

import type { Route } from "./+types/events-catalog";
import { automationScopeFromRouteParams } from "./scope";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  return {
    events: listAutomationEventDescriptors().sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.eventType.localeCompare(right.eventType),
    ),
  };
}

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

export default function BackofficeAutomationEventsCatalog() {
  const { events } = useLoaderData<typeof loader>();
  const [payloadFormat, setPayloadFormat] = useState<"typescript" | "jsonschema">("typescript");

  return (
    <section className="space-y-3">
      <div className="flex justify-end">
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
              onClick={() => setPayloadFormat(option.value)}
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
            {events.map((event) => (
              <tr key={`${event.source}:${event.eventType}`} className="text-[var(--bo-muted)]">
                <td className="px-3 py-3 align-top">
                  <span className="font-mono text-xs text-[var(--bo-fg)]">
                    {event.capabilityId}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="min-w-64">
                    <p className="font-mono text-xs text-[var(--bo-fg)]">{event.eventType}</p>
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
          </tbody>
        </table>
      </div>
    </section>
  );
}
