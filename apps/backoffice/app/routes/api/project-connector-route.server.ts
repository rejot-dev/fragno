import type { ProjectConnectorConnectionState } from "@fragno-dev/project-connector-fragment/contracts";

import type { ProjectConnectorCommands } from "@/backoffice-runtime/object-registry";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type { PublicFragmentRoute } from "@/fragno/public-fragment-route.server";
import { decodeConnectorConnectionLocalId } from "@/fragno/runtime-tools/families/integrations/connector-connection-id";
import { confirmConnectorConsent } from "@/fragno/runtime-tools/families/integrations/connector-integration";
import {
  PROJECT_CONNECTOR_INTERNAL_PREFIX,
  PROJECT_CONNECTOR_PUBLIC_PREFIX,
} from "@/fragno/scoped-public-fragment-routes";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  integrationOAuthReturn,
  type IntegrationOAuthOutcome,
} from "../backoffice/integrations/connection-paths";

type ConnectorReturnInput = Parameters<
  Extract<
    NonNullable<PublicFragmentRoute<ProjectConnectorCommands>["publicIngress"]>,
    { kind: "redirect" }
  >["redirect"]
>[0];

const CALLBACK_SUFFIX = "/oauth/callback";

/** The connection a return names; the bare callback and malformed segments name none. */
function returnedConnection(suffix: string) {
  if (!suffix.startsWith(`${CALLBACK_SUFFIX}/`)) {
    return null;
  }
  const segment = suffix.slice(CALLBACK_SUFFIX.length + 1);
  try {
    return {
      address: decodeConnectorConnectionLocalId(segment),
      connectionId: `connector#${segment}`,
    };
  } catch {
    return null;
  }
}

/**
 * The gateway owns OAuth state, so only the path, set when the attempt started, names the
 * connection. Neither the path nor the gateway's query binds an account: a signed-in owner's
 * return confirms that one name's pending consent with the gateway, as its setup check would, and
 * lands on the connection. Returns naming no connection, and anonymous returns, only navigate.
 */
async function confirmConnectorReturn({
  request,
  context,
  scope,
  pageScope,
  suffix,
}: ConnectorReturnInput): Promise<Response> {
  const named = returnedConnection(suffix);
  const returned = (outcome: IntegrationOAuthOutcome) =>
    integrationOAuthReturn({
      request,
      routeScope: pageScope,
      connectionId: named?.connectionId ?? null,
      outcome,
    });
  if (!named) {
    return returned({ status: "returned" });
  }
  const auth = await authorizeBackofficeContext(request, context, scope);
  if (!auth.ok) {
    return returned({ status: "returned" });
  }
  let outcome: IntegrationOAuthOutcome;
  try {
    const { runtime, kernel } = context.get(BackofficeWorkerContext);
    outcome = returnOutcome(
      await confirmConnectorConsent({
        runtime,
        context: { kernel, execution: auth.execution },
        address: named.address,
      }),
    );
  } catch (error) {
    // Consent may be complete, so the landing must not ask the user to finish authorizing.
    console.error("Connector return could not confirm consent", error);
    outcome = {
      status: "error",
      message: "Backoffice could not confirm this connection. Check its setup again.",
    };
  }
  const response = returned(outcome);
  if (auth.headers.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }
  return new Response(null, { status: response.status, headers });
}

function returnOutcome(state: ProjectConnectorConnectionState | null): IntegrationOAuthOutcome {
  if (state?.status === "connected") {
    return { status: "success" };
  }
  if (state?.status === "failed") {
    return { status: "error", message: state.errorMessage ?? state.errorCode };
  }
  if (state?.status === "expired") {
    return { status: "error", message: "The authorization link expired." };
  }
  // Consent still pending, or a name without a single attempt, leaves the return as navigation.
  return { status: "returned" };
}

export const projectConnectorPublicRoute = {
  publicPrefix: PROJECT_CONNECTOR_PUBLIC_PREFIX,
  internalPrefix: PROJECT_CONNECTOR_INTERNAL_PREFIX,
  getObjectForScope: (context, scope) =>
    context.get(BackofficeWorkerContext).runtime.objects.projectConnector.for(scope),
  isScopeSupported: (scope) => scope.kind === "user",
  publicIngress: {
    kind: "redirect",
    // The bare callback serves links issued before returns named their connection.
    matches: (request, _scope, suffix) =>
      request.method === "GET" &&
      (suffix === CALLBACK_SUFFIX || /^\/oauth\/callback\/[^/]+$/.test(suffix)),
    redirect: confirmConnectorReturn,
  },
} satisfies PublicFragmentRoute<ProjectConnectorCommands>;
