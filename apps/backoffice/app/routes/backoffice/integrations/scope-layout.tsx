import { Checkbox } from "@fragno-private/design-system/checkbox";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Suspense, use, useState, type ReactNode } from "react";
import {
  Link,
  Outlet,
  useParams,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { caseWhen, count, eq, not, or, sum, useLiveQuery } from "@tanstack/react-db";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
} from "@/fragno/automation/tanstack/browser-database";
import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { formatTimestamp } from "../automations/formatting";
import type { Route } from "./+types/scope-layout";
import { IntegrationConnectionStateLight, integrationAuthMethodLabels } from "./connection-display";
import { integrationConnectionPath, integrationsScopeBasePath } from "./connection-paths";
import type { IntegrationsLayoutContext } from "./layout-context";
import { NativeServices } from "./native-services";

/** Connections and their labels come from local connection events; the loader only selects scope. */
export async function loader({ context }: Route.LoaderArgs) {
  return { selectedScope: requireScopeSelection(context) };
}

/** Selecting a connection changes nothing the loader selects. */
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
  const { selectedScope } = loaderData;
  const loading = (
    <IntegrationsPage selectedScope={selectedScope} connectionTabs={[]}>
      <BackofficeSystemState
        tone="loading"
        label="Synchronizing"
        title="Synchronizing connection events…"
      />
    </IntegrationsPage>
  );

  return (
    <div data-integrations-workspace className="flex flex-col">
      <h1 className="sr-only">Integrations in {selectedScope.label}</h1>
      <ClientOnly fallback={loading}>
        <Suspense fallback={loading}>
          <IntegrationsClient selectedScope={selectedScope} />
        </Suspense>
      </ClientOnly>
    </div>
  );
}

type ConnectionTab = { connectionId: string; label: string };

/**
 * Every connection is a tab beside the overview, so an open connection gets the page's full width
 * and switching between connections never goes back through the table.
 */
function IntegrationsPage({
  selectedScope,
  connectionTabs,
  children,
}: {
  selectedScope: BackofficeScopeSelection;
  connectionTabs: readonly ConnectionTab[];
  children: ReactNode;
}) {
  const { connectionId: selectedConnectionId } = useParams();
  return (
    <>
      <BackofficeTabHeader
        items={[
          {
            id: "overview",
            label: "All connections",
            to: integrationsScopeBasePath(selectedScope),
            groupId: "overview",
            active: selectedConnectionId === undefined,
          },
          // Prefixed so a connection id can never collide with the overview tab.
          ...connectionTabs.map((tab) => ({
            id: `connection:${tab.connectionId}`,
            label: tab.label,
            to: integrationConnectionPath(selectedScope, tab.connectionId),
            groupId: "connections",
            active: tab.connectionId === selectedConnectionId,
          })),
        ]}
        ariaLabel="Integrations"
        trailing={null}
        options={null}
      />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <ProviderReturnNotice />
        {children}
      </div>
    </>
  );
}

type WorkspaceProps = {
  selectedScope: BackofficeScopeSelection;
};

function IntegrationsClient(props: WorkspaceProps) {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  if (automationCollectionSource.status === "unavailable") {
    return (
      <IntegrationsPage selectedScope={props.selectedScope} connectionTabs={[]}>
        <BackofficeSystemState
          tone="error"
          label="Unavailable"
          title="Connection events could not be synchronized."
          description={automationCollectionSource.message}
        />
      </IntegrationsPage>
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
  collections,
}: WorkspaceProps & Pick<IntegrationsLayoutContext, "collections">) {
  const { connectionId: selectedConnectionId } = useParams();
  const [showDisconnected, setShowDisconnected] = useState(false);
  // A selected disconnected connection keeps its tab while the others are hidden.
  const connectionsQuery = useLiveQuery({
    query: (query) => {
      const all = query.from({ connection: collections.connections });
      const shown = showDisconnected
        ? all
        : all.where(({ connection }) =>
            selectedConnectionId === undefined
              ? not(eq(connection.state, "disconnected"))
              : or(
                  not(eq(connection.state, "disconnected")),
                  eq(connection.connectionId, selectedConnectionId),
                ),
          );
      return shown
        .orderBy(({ connection }) => connection.service, "asc")
        .orderBy(({ connection }) => connection.connectionId, "asc");
    },
  });
  const countsQuery = useLiveQuery({
    query: (query) =>
      query
        .from({ connection: collections.connections })
        .select(({ connection }) => ({
          total: count(connection.connectionId),
          disconnected: sum(caseWhen(eq(connection.state, "disconnected"), 1, 0)),
        }))
        .findOne(),
  });
  const visibleConnections = connectionsQuery.data ?? [];
  // Without connections the count query has no row.
  const total = countsQuery.data?.total ?? 0;
  const hiddenCount = showDisconnected ? 0 : (countsQuery.data?.disconnected ?? 0);
  const connectionTabs = visibleConnections.map((connection) => ({
    connectionId: connection.connectionId,
    label: connection.displayName,
  }));

  return (
    <IntegrationsPage selectedScope={selectedScope} connectionTabs={connectionTabs}>
      {selectedConnectionId === undefined ? (
        <>
          <section className="bo-panel-surface bg-[var(--bo-panel)]">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                {total} {total === 1 ? "connection" : "connections"}
              </p>
              {total > 0 ? (
                <Checkbox
                  density="compact"
                  checked={showDisconnected}
                  onCheckedChange={setShowDisconnected}
                  className="text-[var(--bo-muted)]"
                >
                  Show disconnected
                  {hiddenCount > 0 ? ` (${hiddenCount})` : null}
                </Checkbox>
              ) : null}
            </div>
            {connectionsQuery.isError || countsQuery.isError ? (
              <BackofficeSystemState
                tone="error"
                title="Connection events could not be read."
                flush
              />
            ) : total === 0 ? (
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
              <ConnectionsTable selectedScope={selectedScope} connections={visibleConnections} />
            )}
          </section>
          <NativeServices selectedScope={selectedScope} />
        </>
      ) : (
        <Outlet context={{ selectedScope, collections } satisfies IntegrationsLayoutContext} />
      )}
    </IntegrationsPage>
  );
}

/** Provider callbacks land here; the query explains the return, the connection state shows the result. */
function ProviderReturnNotice() {
  const [searchParams] = useSearchParams();
  const outcome = searchParams.get("oauth");
  const message = searchParams.get("message");
  if (outcome === "success") {
    return (
      <p className="border border-[color:var(--bo-live)]/40 bg-[var(--bo-live-bg)] p-3 text-sm text-[var(--bo-live)]">
        Authorization completed.
      </p>
    );
  }
  if (outcome === "error") {
    return (
      <p className="border border-[color:var(--bo-failed)]/40 bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
        Authorization failed{message ? `: ${message}` : "."}
      </p>
    );
  }
  if (outcome === "returned") {
    return (
      <p className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-sm text-[var(--bo-muted)]">
        You’re back from the provider. This doesn’t confirm the connection; ask your agent to finish
        setting it up.
      </p>
    );
  }
  return null;
}

function ConnectionsTable({
  selectedScope,
  connections,
}: {
  selectedScope: BackofficeScopeSelection;
  connections: IntegrationConnectionRecord[];
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
            const { authMethod } = connection;
            return (
              <tr key={connection.connectionId} className="hover:bg-[var(--bo-panel-2)]">
                <td className="max-w-[24rem] px-3 py-2">
                  <Link
                    to={integrationConnectionPath(selectedScope, connection.connectionId)}
                    title={connection.connectionId}
                    className="group block min-w-0"
                  >
                    <span className="block truncate font-semibold text-[var(--bo-fg)] group-hover:underline">
                      {connection.displayName}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-[var(--bo-muted)]">
                      {connection.connectionId}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {connection.kindLabel}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {authMethod ? integrationAuthMethodLabels[authMethod] : "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-[var(--bo-muted)]">
                  {selectedScope.label}
                </td>
                <td className="px-3 py-2">
                  <IntegrationConnectionStateLight state={connection.state} />
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap text-[var(--bo-muted)]">
                  {formatTimestamp(connection.changedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
