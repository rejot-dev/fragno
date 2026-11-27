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
  catalogProviderAddress,
  connectIntegrations,
  type ConnectIntegrations,
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

/** Leads the catalog, ahead of Popular, with every source the scope has connected. */
const CONNECTED = { id: "connected", label: "Connected" };

const LEADING_CATEGORY_IDS = [CONNECTED.id, POPULAR.id];

/**
 * Whether a discovered service has a connection of its own. Custom HTTP API is generic: each of its
 * connections is some other API, such as a catalog provider the agent set up, so it never counts.
 */
function isServiceConnected(
  service: IntegrationOverview,
  connections: readonly { integrationId: string }[],
): boolean {
  return (
    service.id !== "api" &&
    connections.some((connection) => connection.integrationId === service.id)
  );
}

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
  const addresses = new Set(connections.map((connection) => connection.connectionId));
  const discovered = new Set(services.map((service) => service.id));
  return {
    services: services.map((service) => ({
      ...service,
      connected: isServiceConnected(service, connections),
    })),
    // Catalog providers the project has not configured, which the agent sets up with an API key.
    // Discovery already lists the configured ones, and built-in services such as GitHub win.
    providers: providers
      .filter((provider) => !discovered.has(provider.service) && setsUpAsApiIntegration(provider))
      .map((provider) => {
        const address = catalogProviderAddress(provider.service);
        return {
          id: provider.service,
          label: provider.displayName,
          // Catalog descriptions are phrases without a closing period.
          description: provider.description ? provider.description.replace(/\.?$/, ".") : "",
          iconUrl: provider.iconUrl,
          categories: provider.categories.map(({ id, displayName }) => ({
            id,
            label: displayName,
          })),
          // The API connection the agent set the provider up at, once it has.
          connectionId: addresses.has(address) ? address : null,
        };
      }),
  };
}

/** Opening a source keeps the catalog; submitting a form reads it again, for its statuses. */
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

/**
 * Asks the agent to look into a source that is already connected, named by its integration or, for
 * a catalog provider, by its API connection. It only reports, because the person may just be
 * curious; fixing waits for their go-ahead.
 */
function investigatePrompt(label: string, subject: string): string {
  return `Investigate my ${label} connection (${subject}) in this scope. Follow the configuring-integrations skill: inspect its configuration and authorization with integrations.get, prove it still has access with integrations.verify or one read-only request, and tell me what works and what I should fix. Change nothing without asking me.`;
}

/** Asks the agent to connect a catalog provider the project has not set up. */
function unconfiguredProviderPrompt(provider: { service: string; displayName: string }): string {
  return `Help me connect ${provider.displayName} in this scope. Follow the configuring-integrations skill to set it up as an API integration (integration api) at ${catalogProviderAddress(provider.service)}: find in ${provider.displayName}'s API documentation how it authenticates, its base URL, and where I create its key or token, then ask me for the key with a setup form that says where to find it.`;
}

// The agent asks what the workflow should do before building it, so the page only says which
// connection it starts from. Connector apps and API connections cannot push events, so it runs on
// a schedule.
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

/**
 * The source a connected account belongs to: a Connector service's account, or the API connection
 * the agent set a catalog provider up at. `target` is where the source opens on that account.
 */
async function connectedSource(
  context: Readonly<RouterContextProvider>,
  integrations: ConnectIntegrations,
  services: readonly IntegrationOverview[],
  connectionId: string,
) {
  const connection = (await listConnections(integrations)).find(
    (candidate) => candidate.connectionId === connectionId,
  );
  if (!connection) {
    return null;
  }
  if (isConnectedConnectorAccount(connection)) {
    const service = services.find((candidate) => candidate.id === connection.integrationId);
    return service
      ? {
          id: service.id,
          label: service.label,
          connectionId,
          target: connectorSetupTarget(service),
        }
      : null;
  }
  const provider = (await listConnectorProviders(context)).find(
    (candidate) => catalogProviderAddress(candidate.service) === connectionId,
  );
  return provider
    ? { id: provider.service, label: provider.displayName, connectionId, target: connectionId }
    : null;
}

/**
 * A source with a connection to investigate: a connected discovered service, or a catalog
 * provider with the API connection the agent set it up at.
 */
async function investigatedSource(
  context: Readonly<RouterContextProvider>,
  integrations: ConnectIntegrations,
  services: readonly IntegrationOverview[],
  source: string,
) {
  const connections = await listConnections(integrations);
  const service = services.find((candidate) => candidate.id === source);
  if (service) {
    return isServiceConnected(service, connections)
      ? { id: service.id, label: service.label, subject: `integration ${service.id}` }
      : null;
  }
  const address = catalogProviderAddress(source);
  if (!connections.some((connection) => connection.connectionId === address)) {
    return null;
  }
  const provider = (await listConnectorProviders(context)).find(
    (candidate) => candidate.service === source,
  );
  return provider ? { id: provider.service, label: provider.displayName, subject: address } : null;
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
    const source =
      typeof connectionId === "string"
        ? await connectedSource(context, integrations, services, connectionId)
        : null;
    if (!source) {
      return data({ error: "Choose a connected account." }, { status: 400 });
    }
    const timeZone = form.get("timeZone");
    content = workflowPrompt({
      service: source.label,
      connectionId: source.connectionId,
      timeZone: typeof timeZone === "string" && timeZone !== "" ? timeZone : "UTC",
    });
    // The source opens again on its connected account, which `target` names.
    const search = new URLSearchParams({ agent: "opened" });
    if (source.target !== null) {
      search.set("target", source.target);
    }
    continueAt = `${integrationsConnectPath(selectedScope)}/${encodeURIComponent(source.id)}?${search}`;
  } else if (intent === "investigate") {
    const source = form.get("source");
    const investigated =
      typeof source === "string"
        ? await investigatedSource(context, integrations, services, source)
        : null;
    if (!investigated) {
      return data({ error: "Choose a connected source to investigate." }, { status: 400 });
    }
    content = investigatePrompt(investigated.label, investigated.subject);
    const search = new URLSearchParams({ agent: "opened" });
    continueAt = `${integrationsConnectPath(selectedScope)}/${encodeURIComponent(investigated.id)}?${search}`;
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
  catalog: { services, providers },
  connectPath,
  actionError,
}: {
  catalog: Awaited<Route.ComponentProps["loaderData"]["catalog"]>;
  connectPath: string;
  actionError: string | null;
}) {
  const { source } = useParams();
  const open: ConnectSourceContext["service"] | null =
    [
      ...services.map(({ id, label, connected }) => ({ id, label, connected })),
      ...providers.map(({ id, label, connectionId }) => ({
        id,
        label,
        connected: connectionId !== null,
      })),
    ].find((candidate) => candidate.id === source) ?? null;

  const items: SourceCatalogItem[] = [
    ...services.map((service) => ({
      id: service.id,
      label: service.label,
      description: service.description,
      icon: service.iconUrl
        ? { kind: "image" as const, url: service.iconUrl }
        : { kind: "symbol" as const, name: BUILT_IN_SYMBOLS[service.id] ?? "box" },
      categories: service.connected
        ? [CONNECTED, POPULAR, ...service.categories]
        : [POPULAR, ...service.categories],
      status: service.connected ? CONNECTED.label : null,
      // Choosing the open source again closes it.
      to: service.id === open?.id ? connectPath : connectSourcePath(connectPath, service),
    })),
    ...providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      icon: provider.iconUrl
        ? { kind: "image" as const, url: provider.iconUrl }
        : { kind: "symbol" as const, name: "box" as const },
      categories:
        provider.connectionId === null ? provider.categories : [CONNECTED, ...provider.categories],
      status: provider.connectionId === null ? null : CONNECTED.label,
      // A connected provider opens on its API connection; otherwise on the offer to set it up with
      // the agent.
      to:
        provider.id === open?.id
          ? connectPath
          : `${connectPath}/${encodeURIComponent(provider.id)}${
              provider.connectionId === null
                ? ""
                : `?${new URLSearchParams({ target: provider.connectionId })}`
            }`,
    })),
  ];

  return (
    <SourceCatalog
      label="Sources to connect"
      items={items}
      leadingCategoryIds={LEADING_CATEGORY_IDS}
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
