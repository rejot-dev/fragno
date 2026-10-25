import { ButtonLink } from "@fragno-private/design-system/button";
import { DetailList } from "@fragno-private/design-system/detail-list";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useLoaderData } from "react-router";

import { getBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import {
  BACKOFFICE_ADMIN_OBJECT_NAME,
  getGitHubWebhookRouterDurableObject,
} from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/github";

type GitHubAdminConfigState = {
  configured: boolean;
  missing: string[];
  error: string | null;
  app?: {
    appId: string;
    appSlug: string;
    privateKeySource: "env" | "file";
    webhookSecretPreview: string;
    webhookUrl: string;
    installUrl: string;
    docsUrl: string;
  };
};

type GitHubWebhookRouterSnapshot = {
  installationMappings: Array<{
    installationId: string;
    orgId: string;
  }>;
  pendingWebhooks: Array<{
    key: string;
    installationId: string;
    method: string;
    event: string;
    deliveryId: string;
    receivedAt: number;
  }>;
  activeInstallStates: Array<{
    statePreview: string;
    userId: string;
    orgId: string;
    createdAt: number;
    expiresAt: number;
  }>;
  counts: {
    installationMappings: number;
    pendingWebhooks: number;
    activeInstallStates: number;
  };
};

type LoaderData = {
  configState: GitHubAdminConfigState | null;
  configError: string | null;
  snapshot: GitHubWebhookRouterSnapshot | null;
  snapshotError: string | null;
  setupUrl: string;
  organizationSlugs: Record<string, string>;
};

const MAPPING_COLUMNS: SurfaceTableColumn[] = [
  { label: "Installation", align: "start" },
  { label: "Organization", align: "start" },
  { label: "Configuration", align: "end" },
];

const WEBHOOK_COLUMNS: SurfaceTableColumn[] = [
  { label: "Installation", align: "start" },
  { label: "Event", align: "start" },
  { label: "Method", align: "start" },
  { label: "Delivery", align: "start" },
  { label: "Received", align: "start" },
];

const INSTALL_STATE_COLUMNS: SurfaceTableColumn[] = [
  { label: "State", align: "start" },
  { label: "User", align: "start" },
  { label: "Organization", align: "start" },
  { label: "Created", align: "start" },
  { label: "Expires", align: "start" },
];

const formatTimestamp = (value?: number | Date | null) => {
  if (!value) {
    return "n/a";
  }
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export function meta() {
  return [
    { title: "Backoffice Internals · GitHub" },
    {
      name: "description",
      content: "Inspect GitHub app runtime config and singleton routing state.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const { me } = getBackofficeShellRequest(context);
  const organizationSlugs = Object.fromEntries(
    me.organizations.map(({ organization }) => [organization.id, organization.slug]),
  );
  const setupUrl = `${origin.replace(/\/+$/, "")}/backoffice/connections/github/setup-callback`;
  const githubRouterDo = getGitHubWebhookRouterDurableObject(context);

  let configState: GitHubAdminConfigState | null = null;
  let configError: string | null = null;
  let snapshot: GitHubWebhookRouterSnapshot | null = null;
  let snapshotError: string | null = null;

  try {
    configState = await githubRouterDo.commands.getAdminConfig(
      BACKOFFICE_ADMIN_OBJECT_NAME,
      origin,
    );
  } catch (error) {
    configError =
      error instanceof Error ? error.message : "Failed to load GitHub app runtime configuration.";
  }

  try {
    snapshot = await githubRouterDo.commands.getWebhookRouterSnapshot();
  } catch (error) {
    snapshotError =
      error instanceof Error ? error.message : "Failed to load singleton routing snapshot.";
  }

  return {
    configState,
    configError,
    snapshot,
    snapshotError,
    setupUrl,
    organizationSlugs,
  } satisfies LoaderData;
}

export default function BackofficeInternalsGitHub() {
  const { configState, configError, snapshot, snapshotError, setupUrl, organizationSlugs } =
    useLoaderData<typeof loader>();

  return (
    <>
      <SurfacePanel
        caption="GitHub App"
        actions={
          configState ? (
            <BackofficeStatusLight tone={configState.configured ? "live" : "waiting"}>
              {configState.configured ? "Configured" : "Not configured"}
            </BackofficeStatusLight>
          ) : null
        }
      >
        {configError || configState?.error || (configState && configState.missing.length > 0) ? (
          <SurfacePanelBody>
            <div className="flex flex-col gap-2">
              {configError ? <InlineAlert>{configError}</InlineAlert> : null}
              {configState?.error ? <InlineAlert>{configState.error}</InlineAlert> : null}
              {configState && configState.missing.length > 0 ? (
                <p className="text-sm text-[var(--bo-muted)]">
                  Missing:{" "}
                  <span className="font-mono text-[var(--bo-fg)]">
                    {configState.missing.join(", ")}
                  </span>
                </p>
              ) : null}
            </div>
          </SurfacePanelBody>
        ) : null}
        {configState?.app ? (
          <>
            <SurfaceFacts
              items={[
                {
                  key: "app",
                  label: "App",
                  value: `${configState.app.appSlug} (${configState.app.appId})`,
                },
                {
                  key: "private-key",
                  label: "Private key source",
                  value: configState.app.privateKeySource,
                },
              ]}
            />
            <SurfacePanelBody>
              <DetailList
                items={[
                  {
                    key: "webhook-url",
                    label: "Webhook URL",
                    value: <UrlValue url={configState.app.webhookUrl} />,
                  },
                  { key: "setup-url", label: "Setup URL", value: <UrlValue url={setupUrl} /> },
                  {
                    key: "install-url",
                    label: "Install URL",
                    value: <UrlValue url={configState.app.installUrl} />,
                  },
                ]}
              />
            </SurfacePanelBody>
          </>
        ) : configState ? null : (
          <BackofficeSystemState
            tone="error"
            label="Unavailable"
            title="The GitHub App configuration could not be loaded."
            flush
          />
        )}
      </SurfacePanel>

      {snapshotError ? <InlineAlert>{snapshotError}</InlineAlert> : null}
      {snapshot ? (
        <>
          <SurfacePanel caption="Webhook router" actions={null}>
            <SurfaceFacts
              items={[
                {
                  key: "mappings",
                  label: "Installation links",
                  value: <CountValue count={snapshot.counts.installationMappings} />,
                },
                {
                  key: "pending",
                  label: "Pending webhooks",
                  value: <CountValue count={snapshot.counts.pendingWebhooks} />,
                },
                {
                  key: "install-states",
                  label: "Active install states",
                  value: <CountValue count={snapshot.counts.activeInstallStates} />,
                },
              ]}
            />
          </SurfacePanel>

          <SurfacePanel
            caption={`${snapshot.installationMappings.length} installation ${snapshot.installationMappings.length === 1 ? "link" : "links"}`}
            actions={null}
          >
            {snapshot.installationMappings.length === 0 ? (
              <BackofficeSystemState
                tone="empty"
                title="No installations are linked to an organization yet."
                description="Installing the GitHub App from an organization links the installation here."
                flush
              />
            ) : (
              <SurfaceTable columns={MAPPING_COLUMNS}>
                {snapshot.installationMappings.map((mapping) => {
                  const orgSlug = organizationSlugs[mapping.orgId];
                  return (
                    <SurfaceTableRow
                      key={`${mapping.installationId}:${mapping.orgId}`}
                      columns={MAPPING_COLUMNS}
                      cells={[
                        <span key="installation" className="font-mono text-[var(--bo-fg)]">
                          {mapping.installationId}
                        </span>,
                        <span key="org" className="font-mono">
                          {orgSlug ?? mapping.orgId}
                        </span>,
                        orgSlug ? (
                          <ButtonLink
                            key="open"
                            to={`/backoffice/connections/github/${encodeURIComponent(orgSlug)}/configuration`}
                            variant="secondary"
                          >
                            Open
                          </ButtonLink>
                        ) : (
                          <span key="open" className="text-[var(--bo-muted-2)]">
                            Not a member
                          </span>
                        ),
                      ]}
                    />
                  );
                })}
              </SurfaceTable>
            )}
          </SurfacePanel>

          <SurfacePanel
            caption={`${snapshot.pendingWebhooks.length} pending ${snapshot.pendingWebhooks.length === 1 ? "webhook" : "webhooks"}`}
            actions={null}
          >
            {snapshot.pendingWebhooks.length === 0 ? (
              <BackofficeSystemState
                tone="empty"
                title="No webhooks are waiting to be routed."
                description="Webhooks wait here while their installation has no organization."
                flush
              />
            ) : (
              <SurfaceTable columns={WEBHOOK_COLUMNS}>
                {snapshot.pendingWebhooks.map((entry) => (
                  <SurfaceTableRow
                    key={entry.key}
                    columns={WEBHOOK_COLUMNS}
                    cells={[
                      <span key="installation" className="font-mono text-[var(--bo-fg)]">
                        {entry.installationId}
                      </span>,
                      entry.event || "unknown",
                      entry.method,
                      <span key="delivery" className="font-mono">
                        {entry.deliveryId || "unknown"}
                      </span>,
                      <span key="received" className="whitespace-nowrap">
                        {formatTimestamp(entry.receivedAt)}
                      </span>,
                    ]}
                  />
                ))}
              </SurfaceTable>
            )}
          </SurfacePanel>

          <SurfacePanel
            caption={`${snapshot.activeInstallStates.length} active install ${snapshot.activeInstallStates.length === 1 ? "state" : "states"}`}
            actions={null}
          >
            {snapshot.activeInstallStates.length === 0 ? (
              <BackofficeSystemState
                tone="empty"
                title="No installs are in progress."
                description="An install state lives from starting a GitHub App install until its callback returns."
                flush
              />
            ) : (
              <SurfaceTable columns={INSTALL_STATE_COLUMNS}>
                {snapshot.activeInstallStates.map((state) => (
                  <SurfaceTableRow
                    key={`${state.statePreview}:${state.userId}:${state.orgId}:${state.createdAt}`}
                    columns={INSTALL_STATE_COLUMNS}
                    cells={[
                      <span key="state" className="font-mono text-[var(--bo-fg)]">
                        {state.statePreview}
                      </span>,
                      <span key="user" className="font-mono">
                        {state.userId}
                      </span>,
                      <span key="org" className="font-mono">
                        {organizationSlugs[state.orgId] ?? state.orgId}
                      </span>,
                      <span key="created" className="whitespace-nowrap">
                        {formatTimestamp(state.createdAt)}
                      </span>,
                      <span key="expires" className="whitespace-nowrap">
                        {formatTimestamp(state.expiresAt)}
                      </span>,
                    ]}
                  />
                ))}
              </SurfaceTable>
            )}
          </SurfacePanel>
        </>
      ) : null}
    </>
  );
}

function UrlValue({ url }: { url: string }) {
  return <span className="font-mono break-all">{url}</span>;
}

function CountValue({ count }: { count: number }) {
  return <span className="text-2xl tabular-nums">{count}</span>;
}
