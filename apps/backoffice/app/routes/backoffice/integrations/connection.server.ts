import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createContext, redirect, type RouterContextProvider } from "react-router";

import {
  type BackofficeNamedProject,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { Organization } from "@/fragno/auth/contracts";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { integrationsScopeBasePath } from "./connection-paths";

type ScopeKind = BackofficeContextScope["kind"];

type PageResolvedScope = BackofficeResolvedScope<Organization, BackofficeNamedProject>;

type ConnectionRequestArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
};

/**
 * One integration in the route's scope. The integration's layout, the middleware of its configured
 * routes, and their loaders and actions share it, so a request loads the configuration once.
 */
type IntegrationConnection<TKind extends ScopeKind, TConfiguration> = {
  resolvedScope: Extract<PageResolvedScope, { kind: TKind }>;
  scope: Extract<BackofficeContextScope, { kind: TKind }>;
  /** The integration's pages in the route's scope. */
  basePath: string;
  /** Loads the configuration on the first call; later calls in the request share it. */
  configuration(): Promise<TConfiguration>;
};

/** Defines how an integration's routes find its connection in the route's scope. */
export function defineIntegrationConnection<
  TKind extends ScopeKind,
  TConfiguration extends { configError: string | null },
>(definition: {
  scopeKinds: readonly TKind[];
  basePath(scope: Extract<PageResolvedScope, { kind: TKind }>): string;
  loadConfiguration(
    input: ConnectionRequestArgs & { scope: Extract<BackofficeContextScope, { kind: TKind }> },
  ): Promise<TConfiguration>;
  /** Whether a configuration that loaded lets the configured routes open. */
  isConfigured(configuration: TConfiguration): boolean;
}) {
  type Connection = IntegrationConnection<TKind, TConfiguration>;
  const ConnectionContext = createContext<Connection | null>(null);

  function servesScope(scope: PageResolvedScope): scope is Connection["resolvedScope"] {
    return (definition.scopeKinds as readonly ScopeKind[]).includes(scope.kind);
  }

  function findConnection({ request, context }: ConnectionRequestArgs): Connection | null {
    const established = context.get(ConnectionContext);
    if (established) {
      return established;
    }
    const { route } = getBackofficeShellRequest(context);
    if (route.status !== "resolved" || !servesScope(route.resolvedScope)) {
      return null;
    }
    const resolvedScope = route.resolvedScope;
    // The runtime scope has the kind `servesScope` narrowed the resolved scope to.
    const scope = backofficeRuntimeScopeFromResolvedScope(resolvedScope) as Connection["scope"];
    let configuration: Promise<TConfiguration> | null = null;
    const connection: Connection = {
      resolvedScope,
      scope,
      basePath: definition.basePath(resolvedScope),
      configuration: () =>
        (configuration ??= definition.loadConfiguration({ request, context, scope })),
    };
    context.set(ConnectionContext, connection);
    return connection;
  }

  /**
   * The route's connection, or the section's 404 or 502 when the route's scope does not resolve,
   * and the integration's 404 when it has no connection in that scope.
   */
  function requireConnection(args: ConnectionRequestArgs): Connection {
    requireRouteScope(args.context);
    const connection = findConnection(args);
    if (!connection) {
      throw new Response("Not Found", { status: 404 });
    }
    return connection;
  }

  /**
   * Sends visitors of an unconfigured connection to its configuration before the route's loaders
   * run. A configuration that failed to load passes, so the route shows the error. Middleware
   * leaves 404s to the loaders: thrown here, they would replace the whole Backoffice shell.
   */
  async function requireConfigured(
    args: ConnectionRequestArgs,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const connection = findConnection(args);
    if (connection) {
      const configuration = await connection.configuration();
      if (configuration.configError === null && !definition.isConfigured(configuration)) {
        throw redirect(`${connection.basePath}/configuration`);
      }
    }
    return await next();
  }

  return { require: requireConnection, requireConfigured };
}

/** What an integration layout shows of its scope: the label and the way back to Integrations. */
export function selectIntegrationScope(
  context: Readonly<RouterContextProvider>,
  connection: { scope: BackofficeContextScope; basePath: string },
) {
  const uiScope = requireScopeSelection(context);
  return {
    scope: connection.scope,
    uiScope,
    label: uiScope.label,
    basePath: connection.basePath,
    integrationsPath: integrationsScopeBasePath(uiScope),
    scopeSegment: backofficeScopePathSegment(connection.scope),
  };
}
