import { integrationConnectionIdSchema } from "@fragno-dev/backoffice-api/v0/integrations";
import { useMemo } from "react";
import { isRouteErrorResponse, useOutletContext } from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import {
  isBackofficeForbiddenError,
  isBackofficeUnavailableError,
} from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  integrationConnectionStateChanges,
  integrationEventsQuery,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { AutomationDetailRows } from "../automations/detail-rows";
import { formatTimestamp } from "../automations/formatting";
import type { Route } from "./+types/connection-detail";
import { ApiConnectionDetails } from "./api-connection-details";
import {
  DetailSection,
  IntegrationConnectionStateLight,
  describeIntegrationConnectionKind,
  integrationAuthMethodLabels,
} from "./connection-display";
import { ConnectorConnectionDetails } from "./connector-connection-details";
import type { IntegrationsLayoutContext } from "./layout-context";
import { McpConnectionDetails } from "./mcp-connection-details";
import { NativeConnectionDetails } from "./native-connection-details";
import { WebhookConnectionDetails } from "./webhook-connection-details";

export async function loader({ context, params }: Route.LoaderArgs) {
  const connectionId = integrationConnectionIdSchema.safeParse(params.connectionId);
  if (!connectionId.success) {
    throw new Response("Not Found", { status: 404 });
  }
  const { execution } = requireRouteScope(context);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  try {
    return await createIntegrationsRuntime({
      runtime,
      kernel,
      execution,
      nowEpochMs: Date.now,
    }).describe({ connectionId: connectionId.data });
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      throw new Response(error.message, { status: 403 });
    }
    if (
      isBackofficeUnavailableError(error) ||
      (error instanceof BackofficeOperationError && error.kind === "not_found")
    ) {
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} · ${typeof error.data === "string" ? error.data : error.statusText}`
    : error instanceof Error
      ? error.message
      : "The connection could not be read.";
  return (
    <p className="bo-panel-surface bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-failed)]">
      {message}
    </p>
  );
}

export default function BackofficeIntegrationConnectionDetail({
  loaderData: { connection, details },
}: Route.ComponentProps) {
  const { selectedScope, collections } = useOutletContext<IntegrationsLayoutContext>();
  const eventsQuery = useLiveQuery({
    query: (query) => integrationEventsQuery(query, collections),
  });
  const history = useMemo(
    () =>
      integrationConnectionStateChanges(eventsQuery.data ?? []).filter(
        (change) => change.connectionId === connection.connectionId,
      ),
    [eventsQuery.data, connection.connectionId],
  );
  const current = history[0];

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="bo-panel-surface flex items-start justify-between gap-3 bg-[var(--bo-panel)] p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            {current ? describeIntegrationConnectionKind(current) : connection.integrationId}
          </p>
          <h2 className="truncate text-xl font-semibold text-[var(--bo-fg)]">{connection.name}</h2>
          <p className="font-mono text-[11px] break-all text-[var(--bo-muted)]">
            {connection.connectionId}
          </p>
        </div>
        {current ? <IntegrationConnectionStateLight state={current.state} /> : null}
      </header>

      {/* What the source reports gets the room; inspection and history are short lists beside it. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="bo-panel-surface flex min-w-0 flex-col gap-4 bg-[var(--bo-panel)] p-4">
          <ConnectionSourceDetails
            details={details}
            selectedScope={selectedScope}
            collections={collections}
            service={connection.integrationId}
          />
        </div>
        <div className="bo-panel-surface flex min-w-0 flex-col gap-4 bg-[var(--bo-panel)] p-4">
          <DetailSection title="Inspection">
            <AutomationDetailRows
              layout="inspector"
              rows={[
                {
                  label: "Configuration",
                  value:
                    connection.configuration.status === "missing"
                      ? `missing: ${connection.configuration.missingFields.join(", ")}`
                      : "configured",
                },
                {
                  label: "Auth method",
                  value: connection.authMethod
                    ? integrationAuthMethodLabels[connection.authMethod]
                    : "—",
                },
                { label: "Authorization", value: connection.authorization.status },
                ...connection.checks.map((check) => ({
                  label: check.label,
                  value:
                    check.status === "not-checked"
                      ? `not checked: ${check.reason}`
                      : `${check.status} at ${formatTimestamp(check.checkedAt)}: ${check.message}`,
                })),
              ]}
            />
            {connection.nextSteps.length > 0 ? (
              <ul className="list-disc space-y-1 px-8 py-3 text-xs text-[var(--bo-muted)]">
                {connection.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            ) : null}
          </DetailSection>

          <DetailSection title="State history">
            {history.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
                No state change has been reported for this address.
              </p>
            ) : (
              <ol className="divide-y divide-[color:var(--bo-border)]">
                {history.map((change) => (
                  <li
                    key={change.eventId}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <IntegrationConnectionStateLight state={change.state} />
                    <span className="text-xs text-[var(--bo-muted)]">
                      {formatTimestamp(change.occurredAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </DetailSection>
        </div>
      </div>
    </article>
  );
}

function ConnectionSourceDetails({
  details,
  selectedScope,
  collections,
  service,
}: {
  details: Route.ComponentProps["loaderData"]["details"];
  selectedScope: IntegrationsLayoutContext["selectedScope"];
  collections: IntegrationsLayoutContext["collections"];
  service: string;
}) {
  switch (details.kind) {
    case "api":
      return <ApiConnectionDetails details={details} />;
    case "webhook":
      return <WebhookConnectionDetails details={details} collections={collections} />;
    case "mcp":
      return <McpConnectionDetails details={details} />;
    case "connector":
      return <ConnectorConnectionDetails details={details} />;
    case "native":
      return <NativeConnectionDetails selectedScope={selectedScope} service={service} />;
  }
  throw new Error("Integration connection details are unsupported.", {
    cause: details satisfies never,
  });
}
