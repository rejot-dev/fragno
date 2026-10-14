import { ClientOnly } from "@fragno-private/design-system/client-only";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Outlet,
  redirect,
  useParams,
  useRevalidator,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
} from "@/fragno/automation/tanstack/browser-database";
import { INTEGRATIONS_EVENT_SOURCE } from "@/fragno/runtime-tools/families/integrations/integration-events";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject } from "../automations/data.server";
import { formatTimestamp } from "../automations/formatting";
import {
  automationRuntimeScopeFromRouteParams,
  resolveAutomationScopeSelection,
} from "../automations/scope";
import type { Route } from "./+types/scope-layout";
import {
  IntegrationConnectionStateLight,
  describeIntegrationConnectionKind,
  fallbackIntegrationConnectionName,
  integrationAuthMethodLabels,
} from "./connection-display";
import {
  currentIntegrationConnections,
  integrationConnectionStateChanges,
  type IntegrationConnectionStateChange,
} from "./connection-overview";
import { integrationConnectionPath } from "./connection-paths";
import {
  listIntegrationConnections,
  type ListedIntegrationConnections,
} from "./connections.server";
import type { IntegrationsLayoutContext } from "./layout-context";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const organizations = me.organizations.map((entry) => entry.organization);
  const parsedScope = automationRuntimeScopeFromRouteParams(params, organizations);
  const projectLookup =
    parsedScope.kind === "project"
      ? await lookupAutomationProject(context, parsedScope.orgId, parsedScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw new Response(projectLookup.message, { status: 502 });
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  return {
    selectedScope: resolveAutomationScopeSelection({
      params,
      organizations,
      project: projectLookup?.status === "found" ? projectLookup.project : null,
      user: me.user,
    }),
    listed: await listIntegrationConnections(request, context, params),
  };
}

/** Selecting a connection changes nothing listed; new connection events revalidate explicitly. */
export function shouldRevalidate({
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const sameScope =
    currentParams.scopeKind === nextParams.scopeKind &&
    currentParams.scopeId === nextParams.scopeId;
  return sameScope && formMethod === undefined ? false : defaultShouldRevalidate;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Integrations · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeIntegrationsScopeLayout({ loaderData }: Route.ComponentProps) {
  const { selectedScope, listed } = loaderData;
  const loading = (
    <BackofficeSystemState
      tone="loading"
      label="Synchronizing"
      title="Synchronizing connection events…"
    />
  );

  return (
    <div data-integrations-workspace className="flex flex-col gap-4">
      <h1 className="sr-only">Integrations in {selectedScope.label}</h1>
      <ClientOnly fallback={loading}>
        <Suspense fallback={loading}>
          <IntegrationsClient selectedScope={selectedScope} listed={listed} />
        </Suspense>
      </ClientOnly>
    </div>
  );
}

type WorkspaceProps = {
  selectedScope: BackofficeScopeSelection;
  listed: ListedIntegrationConnections;
};

function IntegrationsClient(props: WorkspaceProps) {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  if (automationCollectionSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Connection events could not be synchronized."
        description={automationCollectionSource.message}
      />
    );
  }
  const source = automationCollectionSource.source;
  return (
    <IntegrationsWorkspace
      key={describeAutomationCollectionSource(source).resourceKey}
      {...props}
      collections={use(getAutomationBrowserDatabase(source)).collections}
    />
  );
}

function IntegrationsWorkspace({
  selectedScope,
  listed,
  collections,
}: WorkspaceProps & Pick<IntegrationsLayoutContext, "collections">) {
  const { connectionId: selectedConnectionId } = useParams();
  const [showDisconnected, setShowDisconnected] = useState(false);
  const eventsQuery = useLiveQuery(
    (query) =>
      query
        .from({ event: collections.events })
        .where(({ event }) => eq(event.source, INTEGRATIONS_EVENT_SOURCE))
        .select(({ event }) => ({
          id: event.id,
          source: event.source,
          eventType: event.eventType,
          subject: event.subject,
          occurredAt: event.occurredAt,
        })),
    [collections.events],
  );
  const changes = useMemo(
    () => integrationConnectionStateChanges(eventsQuery.data ?? []),
    [eventsQuery.data],
  );
  useRevalidateOnNewChange(changes[0]?.eventId ?? null);
  const connections = currentIntegrationConnections(changes);
  const visibleConnections = showDisconnected
    ? connections
    : connections.filter(
        (connection) =>
          connection.state !== "disconnected" || connection.connectionId === selectedConnectionId,
      );
  const disconnectedCount = connections.length - visibleConnections.length;
  // Without connections there is nothing to filter or select, so only the table remains.
  const showPanel = connections.length > 0 || selectedConnectionId !== undefined;

  return (
    <div
      className={`grid items-start gap-4 ${showPanel ? "xl:grid-cols-[minmax(0,1fr)_30rem]" : ""}`}
    >
      <section className="bo-panel-surface bg-[var(--bo-panel)]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            {connections.length} {connections.length === 1 ? "connection" : "connections"}
          </p>
          {connections.length > 0 ? (
            <label className="flex items-center gap-2 text-xs text-[var(--bo-muted)]">
              <input
                type="checkbox"
                checked={showDisconnected}
                onChange={(event) => {
                  setShowDisconnected(event.target.checked);
                }}
              />
              Show disconnected
              {disconnectedCount > 0 ? ` (${disconnectedCount})` : null}
            </label>
          ) : null}
        </div>
        {listed.status === "unavailable" ? (
          <p className="border-t border-[color:var(--bo-border)] px-4 py-2 text-xs text-[var(--bo-muted)]">
            Names and auth methods are unavailable: {listed.message}
          </p>
        ) : null}
        {eventsQuery.isError ? (
          <BackofficeSystemState tone="error" title="Connection events could not be read." flush />
        ) : connections.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title="No connections yet."
            description="Ask your agent to add a connection."
            flush
          />
        ) : visibleConnections.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title="No active connections."
            description="Every connection in this scope was disconnected. Ask your agent to add a connection."
            flush
          />
        ) : (
          <ConnectionsTable
            selectedScope={selectedScope}
            listed={listed.status === "listed" ? listed.connections : {}}
            connections={visibleConnections}
            selectedConnectionId={selectedConnectionId ?? null}
          />
        )}
      </section>
      {showPanel ? (
        <Outlet
          context={{ selectedScope, collections, changes } satisfies IntegrationsLayoutContext}
        />
      ) : null}
    </div>
  );
}

/** Names and auth methods come from the source, so a new state change refreshes the listing. */
function useRevalidateOnNewChange(latestEventId: string | null) {
  const revalidator = useRevalidator();
  const seen = useRef(latestEventId);
  useEffect(() => {
    if (seen.current !== latestEventId) {
      seen.current = latestEventId;
      void revalidator.revalidate();
    }
  }, [latestEventId, revalidator]);
}

function ConnectionsTable({
  selectedScope,
  listed,
  connections,
  selectedConnectionId,
}: {
  selectedScope: BackofficeScopeSelection;
  listed: Extract<ListedIntegrationConnections, { status: "listed" }>["connections"];
  connections: IntegrationConnectionStateChange[];
  selectedConnectionId: string | null;
}) {
  return (
    <div className="backoffice-scroll overflow-x-auto border-t border-[color:var(--bo-border)]">
      <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
        <thead className="bg-[var(--bo-panel-2)] text-left">
          <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            {["Connection", "Kind", "Auth", "Scope", "State", "Last change"].map((heading) => (
              <th key={heading} scope="col" className="px-3 py-2 whitespace-nowrap">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--bo-border)]">
          {connections.map((connection) => {
            const selected = connection.connectionId === selectedConnectionId;
            const source = listed[connection.connectionId];
            return (
              <tr
                key={connection.connectionId}
                aria-selected={selected}
                className={selected ? "bg-[var(--bo-selected-bg)]" : "hover:bg-[var(--bo-panel-2)]"}
              >
                <td className="max-w-[24rem] px-3 py-2">
                  <Link
                    to={integrationConnectionPath(selectedScope, connection.connectionId)}
                    title={connection.connectionId}
                    className="group block min-w-0"
                  >
                    <span className="block truncate font-semibold text-[var(--bo-fg)] group-hover:underline">
                      {source?.name ?? fallbackIntegrationConnectionName(connection)}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-[var(--bo-muted)]">
                      {connection.connectionId}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {describeIntegrationConnectionKind(connection)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {source?.authMethod ? integrationAuthMethodLabels[source.authMethod] : "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {selectedScope.label}
                </td>
                <td className="px-3 py-2">
                  <IntegrationConnectionStateLight state={connection.state} />
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap text-[var(--bo-muted)]">
                  {formatTimestamp(connection.occurredAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
