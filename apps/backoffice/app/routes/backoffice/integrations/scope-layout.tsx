import { Checkbox } from "@fragno-private/design-system/checkbox";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { PaneSpinner } from "@fragno-private/design-system/pane-message";
import {
  SurfacePanel,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { Suspense, use, useState, type ReactNode } from "react";
import { Link, Outlet, useParams, useSearchParams } from "react-router";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { getAutomationReplica, useAutomationRead } from "@/fragno/automation/lofi/replica";
import { describeAutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";
import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { formatTimestamp } from "../automations/formatting";
import { shouldRevalidateWithinScope } from "../scope-revalidation";
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
export const shouldRevalidate = shouldRevalidateWithinScope;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Integrations · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeIntegrationsScopeLayout({ loaderData }: Route.ComponentProps) {
  const { selectedScope } = loaderData;
  const loading = (
    <IntegrationsPage selectedScope={selectedScope} connectionTabs={[]}>
      <PaneSpinner label="Synchronizing connection events" />
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

const DOWNLOAD_TITLE = "Downloading connection events…";
const NO_CONNECTIONS: IntegrationConnectionRecord[] = [];

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
  const { automationReplicaSource } = useCurrentBackofficeContext();
  if (automationReplicaSource.status === "unavailable") {
    return (
      <IntegrationsPage selectedScope={props.selectedScope} connectionTabs={[]}>
        <BackofficeSystemState
          tone="error"
          label="Unavailable"
          title="Connection events could not be synchronized."
          description={automationReplicaSource.message}
        />
      </IntegrationsPage>
    );
  }
  const source = automationReplicaSource.source;
  const replica = use(getAutomationReplica(source));
  return (
    <LofiReplicaGate replica={replica} title={DOWNLOAD_TITLE}>
      <IntegrationsWorkspace
        key={describeAutomationReplicaSource(source).resourceKey}
        {...props}
        replica={replica}
      />
    </LofiReplicaGate>
  );
}

function IntegrationsWorkspace({
  selectedScope,
  replica,
}: WorkspaceProps & Pick<IntegrationsLayoutContext, "replica">) {
  const { connectionId: selectedConnectionId } = useParams();
  const [showDisconnected, setShowDisconnected] = useState(false);
  // A selected disconnected connection keeps its tab while the others are hidden.
  const list = useAutomationRead(replica, "integrationConnections", undefined);
  const connections = list.status === "ready" ? list.data : NO_CONNECTIONS;
  const visibleConnections = showDisconnected
    ? connections
    : connections.filter(
        ({ connectionId, state }) =>
          state !== "disconnected" || connectionId === selectedConnectionId,
      );
  const total = connections.length;
  const hiddenCount = showDisconnected
    ? 0
    : connections.filter(({ state }) => state === "disconnected").length;
  const connectionTabs = visibleConnections.map((connection) => ({
    connectionId: connection.connectionId,
    label: connection.displayName,
  }));

  return (
    <IntegrationsPage selectedScope={selectedScope} connectionTabs={connectionTabs}>
      {selectedConnectionId === undefined ? (
        <>
          <SurfacePanel
            caption={`${total} ${total === 1 ? "connection" : "connections"}`}
            actions={
              total > 0 ? (
                <Checkbox
                  density="compact"
                  checked={showDisconnected}
                  onCheckedChange={setShowDisconnected}
                  className="text-[var(--bo-muted)]"
                >
                  Show disconnected
                  {hiddenCount > 0 ? ` (${hiddenCount})` : null}
                </Checkbox>
              ) : null
            }
          >
            {list.status === "error" ? (
              <BackofficeSystemState
                tone="error"
                title="Connection events could not be read."
                flush
              />
            ) : list.status === "loading" ? (
              <PaneSpinner label="Reading connection events" />
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
          </SurfacePanel>
          <NativeServices selectedScope={selectedScope} />
        </>
      ) : (
        <Outlet context={{ selectedScope, replica } satisfies IntegrationsLayoutContext} />
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
        You’re back from the provider, but the connection isn’t confirmed yet. Ask your agent to
        check it once you’ve finished authorizing.
      </p>
    );
  }
  return null;
}

const CONNECTION_COLUMNS: readonly SurfaceTableColumn[] = [
  { label: "Connection", align: "start" },
  { label: "Kind", align: "start" },
  { label: "Auth", align: "start" },
  { label: "Scope", align: "start" },
  { label: "State", align: "start" },
  { label: "Last change", align: "start" },
];

function ConnectionsTable({
  selectedScope,
  connections,
}: {
  selectedScope: BackofficeScopeSelection;
  connections: IntegrationConnectionRecord[];
}) {
  return (
    <SurfaceTable columns={CONNECTION_COLUMNS}>
      {connections.map((connection) => {
        const { authMethod } = connection;
        return (
          <SurfaceTableRow
            key={connection.connectionId}
            columns={CONNECTION_COLUMNS}
            cells={[
              <Link
                key="connection"
                to={integrationConnectionPath(selectedScope, connection.connectionId)}
                title={connection.connectionId}
                className="group block max-w-[24rem] min-w-0"
              >
                <span className="block truncate font-semibold text-[var(--bo-fg)] group-hover:underline">
                  {connection.displayName}
                </span>
                <span className="block truncate font-mono text-[11px] text-[var(--bo-muted)]">
                  {connection.connectionId}
                </span>
              </Link>,
              <span key="kind" className="whitespace-nowrap">
                {connection.kindLabel}
              </span>,
              <span key="auth" className="whitespace-nowrap">
                {authMethod ? integrationAuthMethodLabels[authMethod] : "—"}
              </span>,
              <span key="scope" className="whitespace-nowrap">
                {selectedScope.label}
              </span>,
              <IntegrationConnectionStateLight key="state" state={connection.state} />,
              <span key="changed" className="text-xs whitespace-nowrap">
                {formatTimestamp(connection.changedAt)}
              </span>,
            ]}
          />
        );
      })}
    </SurfaceTable>
  );
}
