import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

export const integrationsScopeBasePath = (scope: BackofficeScopeSelection): string =>
  `/backoffice/integrations/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope))}`;

export const integrationConnectionPath = (scope: BackofficeScopeSelection, connectionId: string) =>
  `${integrationsScopeBasePath(scope)}/${encodeURIComponent(connectionId)}`;

/** What a provider's return reports. A `returned` provider keeps the outcome to itself. */
export type IntegrationOAuthOutcome =
  | { status: "success" }
  | { status: "error"; message: string | null }
  | { status: "returned" };

/**
 * Provider returns land in Integrations: on the connection's detail view when the callback knows
 * the connection, otherwise on the scope's table. The query only explains the return; the
 * connection's state is the result.
 */
export function integrationOAuthReturn({
  request,
  routeScope,
  connectionId,
  outcome,
}: {
  request: Request;
  routeScope: BackofficeRouteScope;
  connectionId: string | null;
  outcome: IntegrationOAuthOutcome;
}): Response {
  const scopePath = `/backoffice/integrations/${backofficeRouteScopePath(routeScope)}`;
  const url = new URL(
    connectionId === null ? scopePath : `${scopePath}/${encodeURIComponent(connectionId)}`,
    request.url,
  );
  url.searchParams.set("oauth", outcome.status);
  if (outcome.status === "error" && outcome.message !== null) {
    url.searchParams.set("message", outcome.message);
  }
  return Response.redirect(url, 302);
}
