import type { IntegrationOverview } from "@fragno-dev/backoffice-api/v0/integrations";
import {
  SourceCatalog,
  type SourceCatalogItem,
} from "@fragno-private/design-system/controls/source-catalog";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import type { IconName } from "@fragno-private/design-system/icon";
import { Suspense } from "react";
import { Await, data, Outlet, redirect, useParams, type RouterContextProvider } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import { integrationConnectionKind } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { submitPiManagerPrompt } from "../agents/data";
import { shouldRevalidateWithinScope } from "../scope-revalidation";
import type { Route } from "./+types/connect";
import type { ConnectSourceContext } from "./connect-source";
import {
  connectIntegrations,
  isConnectedConnectorAccount,
  listConnections,
  listConnectorProviders,
} from "./connect.server";
import { integrationsConnectPath } from "./connection-paths";

/** Built-in services publish no logo, so each gets a symbol for what it is. */
const BUILT_IN_SYMBOLS: Record<string, IconName> = {
  api: "globe",
  app: "grid",
  github: "github",
  mcp: "cpu",
  resend: "mail",
  telegram: "send",
  webhook: "zap",
};

/**
 * Leads the catalog with every service Leyway connects natively, built in or configured in the
 * Connector, ahead of the catalog's providers it cannot connect yet.
 */
const POPULAR = { id: "popular", label: "Popular" };

/** The address a Connector service signs in under, or null for a service the agent sets up. */
function connectorSetupTarget(service: IntegrationOverview): string | null {
  const [target] = service.setupTargets;
  return target && integrationConnectionKind(target.connectionId) === "connector"
    ? target.connectionId
    : null;
}

/**
 * Where a service opens in the catalog; a Connector service's names its sign-in address. Not
 * `?connection=`: that marks a provider's return, which this page's loader redirects here from.
 */
function connectSourcePath(connectPath: string, service: IntegrationOverview): string {
  const path = `${connectPath}/${encodeURIComponent(service.id)}`;
  const connectionId = connectorSetupTarget(service);
  return connectionId === null ? path : `${path}?${new URLSearchParams({ target: connectionId })}`;
}

/**
 * The page renders at once and streams its catalog, which the Connector's gateway can hold up.
 * The catalog is read once: opening and closing a source only loads the open source's route.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);

  // A provider's return names the connection it confirmed; its service opens again. A redirect
  // cannot follow a streamed page, so only a return waits for discovery.
  const returned = new URL(request.url).searchParams.get("connection");
  if (returned !== null) {
    const services = await connectIntegrations(context).discover();
    const owner = services.find((candidate) =>
      candidate.setupTargets.some((target) => target.connectionId === returned),
    );
    const connectPath = integrationsConnectPath(selectedScope);
    throw redirect(owner ? connectSourcePath(connectPath, owner) : connectPath);
  }

  return { selectedScope, catalog: readCatalog(context) };
}

/** Every source the scope can connect, with those it already has marked. */
async function readCatalog(context: Readonly<RouterContextProvider>) {
  const integrations = connectIntegrations(context);
  const [services, connections, providers] = await Promise.all([
    integrations.discover(),
    listConnections(integrations),
    listConnectorProviders(context),
  ]);
  const connected = new Set(connections.map((connection) => connection.integrationId));
  const discovered = new Set(services.map((service) => service.id));
  return {
    services: services.map((service) => ({ ...service, connected: connected.has(service.id) })),
    // Catalog providers the project has not configured, which the agent sets up with an API key.
    // Discovery already lists the configured ones, and built-in services such as GitHub win.
    unavailable: providers
      .filter((provider) => !discovered.has(provider.service) && setsUpAsApiIntegration(provider))
      .map((provider) => ({
        id: provider.service,
        label: provider.displayName,
        // Catalog descriptions are phrases without a closing period.
        description: provider.description ? provider.description.replace(/\.?$/, ".") : "",
        iconUrl: provider.iconUrl,
        categories: provider.categories.map(({ id, displayName }) => ({ id, label: displayName })),
      })),
  };
}

/** Opening a source keeps the catalog; submitting a form reads it again, for its badges. */
export const shouldRevalidate = shouldRevalidateWithinScope;

/**
 * Whether the agent can set up a catalog provider the project has not configured, as Leyway's own
 * API integration holding its key or credentials. A provider that only signs in with OAuth needs
 * its OAuth configured in Oomol first, after which discovery lists it, so until then it is hidden.
 */
function setsUpAsApiIntegration(provider: { authTypes: readonly string[] }): boolean {
  return provider.authTypes.some((type) =>
    ["api_key", "custom_credential", "no_auth"].includes(type),
  );
}

/** Asks the agent to connect a catalog provider the project has not set up. */
function unconfiguredProviderPrompt(provider: { displayName: string }): string {
  return `Help me connect ${provider.displayName} in this scope. Follow the configuring-integrations skill to set it up as an API integration (integration api): find in ${provider.displayName}'s API documentation how it authenticates, its base URL, and where I create its key or token, then ask me for the key with a setup form that says where to find it.`;
}

// The agent asks what the workflow should do before building it, so the page only says which
// connection it starts from. Connector apps cannot push events, so it runs on a schedule.
function workflowPrompt({
  service,
  connectionId,
  timeZone,
}: {
  service: string;
  connectionId: string;
  timeZone: string;
}): string {
  return [
    `I just connected ${service} (connection ${connectionId}) and want to build a workflow with it.`,
    "",
    `Before building anything, ask me what it should do and how often it should run. ${service} cannot notify Backoffice of new activity, so the workflow runs on a schedule; suggest one that fits. My time zone is ${timeZone}.`,
    "",
    "Then follow the building-automations skill: save the workflow under /workspace/automations and route a schedule to it. Scheduled routes need explicit delegated-user grants, so grant only what the workflow uses. Tell me what you built.",
  ].join("\n");
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const integrations = connectIntegrations(context);
  const services = await integrations.discover();
  const selectedScope = requireScopeSelection(context);

  // Paths are built from the scope rather than the request, whose URL is React Router's data
  // endpoint. The conversation continues in the agent drawer beside the source, which opens on that
  // redirect; the page never leaves for the agent's own page.
  let content: string;
  let continueAt: string;
  // Both are named by their connection, so a connection's own page acts on it without choosing its
  // source.
  if (intent === "start") {
    const connectionId = form.get("connectionId");
    const service = services.find((candidate) =>
      candidate.setupTargets.some(
        (target) =>
          target.connectionId === connectionId &&
          integrationConnectionKind(target.connectionId) === "connector",
      ),
    );
    if (!service || typeof connectionId !== "string") {
      return data({ error: "Choose a Connector account to sign in." }, { status: 400 });
    }
    // The provider returns the browser to this page, which then finds the account connected.
    const progress = await integrations.setup({
      kind: "input",
      connectionId,
      input: { start: true, returnTo: "connect" },
    });
    if (progress.status === "needs-authorization") {
      throw redirect(progress.authorizationUrl);
    }
    return { error: null };
  }
  if (intent === "create-workflow") {
    const connectionId = form.get("connectionId");
    const account = (await listConnections(integrations)).find(
      (connection) =>
        connection.connectionId === connectionId && isConnectedConnectorAccount(connection),
    );
    const service = services.find((candidate) => candidate.id === account?.integrationId);
    if (!account || !service) {
      return data({ error: "Choose a connected Connector account." }, { status: 400 });
    }
    const timeZone = form.get("timeZone");
    content = workflowPrompt({
      service: service.label,
      connectionId: account.connectionId,
      timeZone: typeof timeZone === "string" && timeZone !== "" ? timeZone : "UTC",
    });
    // The source opens again on its connected account, which `target` names.
    const search = new URLSearchParams({ agent: "opened" });
    const target = connectorSetupTarget(service);
    if (target !== null) {
      search.set("target", target);
    }
    continueAt = `${integrationsConnectPath(selectedScope)}/${encodeURIComponent(service.id)}?${search}`;
  } else {
    if (intent !== "ask-agent") {
      return data({ error: "Unsupported action." }, { status: 400 });
    }
    const source = form.get("source");
    const service = services.find((candidate) => candidate.id === source);
    // A catalog provider the project has not set up has no integration, so the agent finds a way in.
    const provider = service
      ? null
      : (await listConnectorProviders(context)).find(
          (candidate) => candidate.service === source && setsUpAsApiIntegration(candidate),
        );
    let sourceId: string;
    if (service) {
      sourceId = service.id;
      content = `Help me connect ${service.label} (integration ${service.id}) in this scope.`;
    } else if (provider) {
      sourceId = provider.service;
      content = unconfiguredProviderPrompt(provider);
    } else {
      return data({ error: "Choose a source to connect." }, { status: 400 });
    }
    const search = new URLSearchParams({ agent: "opened" });
    continueAt = `${integrationsConnectPath(selectedScope)}/${encodeURIComponent(sourceId)}?${search}`;
  }

  const { scope } = requireRouteScope(context).execution;
  const result = await submitPiManagerPrompt(request, context, scope, MAIN_PI_AGENT_NAME, {
    requestId: crypto.randomUUID(),
    content,
    whenBusy: "steer",
    whenPaused: "resume",
    model: null,
  });
  if (result.error !== null) {
    return data({ error: result.error }, { status: 502 });
  }
  throw redirect(continueAt);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Connect · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

/**
 * Connects a new source: a catalog to choose from, where the chosen source opens in its card to
 * connect it and, once connected, hand its first workflow to the agent.
 */
export default function BackofficeIntegrationsConnect({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { selectedScope, catalog } = loaderData;
  return (
    <div className={`${backofficePageBodyClassName} flex flex-col gap-6`}>
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-[var(--bo-fg)]">Connect a source</h1>
        <p className="text-sm text-[var(--bo-muted)]">
          Connected apps become available to your agents, and can run workflows of their own.
        </p>
      </header>
      <Suspense fallback={<PaneSpinner label="Loading sources" />}>
        <Await
          resolve={catalog}
          errorElement={
            <PaneMessage tone="failed">
              Sources could not be loaded. Reload the page to try again.
            </PaneMessage>
          }
        >
          {(resolved) => (
            <ConnectCatalog
              catalog={resolved}
              connectPath={integrationsConnectPath(selectedScope)}
              actionError={actionData?.error ?? null}
            />
          )}
        </Await>
      </Suspense>
    </div>
  );
}

function ConnectCatalog({
  catalog: { services, unavailable },
  connectPath,
  actionError,
}: {
  catalog: Awaited<Route.ComponentProps["loaderData"]["catalog"]>;
  connectPath: string;
  actionError: string | null;
}) {
  const { source } = useParams();
  const open =
    services.find((service) => service.id === source) ??
    unavailable.find((provider) => provider.id === source) ??
    null;

  const items: SourceCatalogItem[] = [
    ...services.map((service) => ({
      id: service.id,
      label: service.label,
      description: service.description,
      icon: service.iconUrl
        ? { kind: "image" as const, url: service.iconUrl }
        : { kind: "symbol" as const, name: BUILT_IN_SYMBOLS[service.id] ?? "box" },
      categories: [POPULAR, ...service.categories],
      badge: service.connected ? "Connected" : null,
      // Choosing the open source again closes it.
      to: service.id === open?.id ? connectPath : connectSourcePath(connectPath, service),
    })),
    ...unavailable.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      icon: provider.iconUrl
        ? { kind: "image" as const, url: provider.iconUrl }
        : { kind: "symbol" as const, name: "box" as const },
      categories: provider.categories,
      badge: null,
      // With no sign-in to name, the source opens on its offer to set it up with the agent.
      to:
        provider.id === open?.id
          ? connectPath
          : `${connectPath}/${encodeURIComponent(provider.id)}`,
    })),
  ];

  return (
    <SourceCatalog
      label="Sources to connect"
      items={items}
      leadingCategoryId={POPULAR.id}
      expanded={
        open === null
          ? null
          : {
              id: open.id,
              content: (
                <Outlet
                  context={
                    {
                      service: open,
                      connectPath,
                      actionError,
                    } satisfies ConnectSourceContext
                  }
                />
              ),
            }
      }
    />
  );
}
