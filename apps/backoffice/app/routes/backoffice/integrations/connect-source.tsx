import type {
  IntegrationOverview,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { ActionItem, ActionItemLink } from "@fragno-private/design-system/controls/action-item";
import { InlineAlert } from "@fragno-private/design-system/feedback/inline-alert";
import { useEffect } from "react";
import {
  Form,
  useNavigation,
  useOutletContext,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { useOpenAgentDrawer } from "@/components/backoffice/open-agent-drawer";
import { integrationConnectionKind } from "@/fragno/runtime-tools/families/integrations/integration-connections";

import type { Route } from "./+types/connect-source";
import {
  connectIntegrations,
  isConnectedConnectorAccount,
  listConnections,
} from "./connect.server";
import { ConnectorActionForm } from "./connector-action-form";

/** What the Connect page hands the source it opened. */
export type ConnectSourceContext = {
  /** A discovered service, or a catalog provider the agent sets up because Connector cannot yet. */
  service: ConnectSource;
  connectPath: string;
  /** What the Connect page's last action reported, shown in the open source. */
  actionError: string | null;
};

type ConnectSource = Pick<IntegrationOverview, "id" | "label">;

/**
 * How a chosen service connects. A Connector service with an account already connected goes
 * straight to building on it; one without signs in with its provider here; every other service is
 * set up by the agent, which knows each one's configuration.
 */
type ConnectMethod =
  | { kind: "connected"; connectionId: string }
  | { kind: "authorization"; connectionId: string; progress: IntegrationSetupProgress }
  | { kind: "agent" };

/**
 * Reads only what the open source needs. The catalog, which names the source and its sign-in
 * address (`?target=`), stays with the Connect page, so opening a source never reads it again.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const setupTarget = new URL(request.url).searchParams.get("target");
  if (setupTarget === null || integrationConnectionKind(setupTarget) !== "connector") {
    const method: ConnectMethod = { kind: "agent" };
    return { method };
  }
  const integrations = connectIntegrations(context);
  const account = (await listConnections(integrations)).find(
    (connection) =>
      connection.integrationId === params.source && isConnectedConnectorAccount(connection),
  );
  const method: ConnectMethod = account
    ? { kind: "connected", connectionId: account.connectionId }
    : {
        kind: "authorization",
        connectionId: setupTarget,
        // Checking an attempt the provider finished confirms it with the gateway.
        progress: await integrations.setup({ kind: "check", connectionId: setupTarget }),
      };
  return { method };
}

export default function BackofficeIntegrationsConnectSource({ loaderData }: Route.ComponentProps) {
  const { service, connectPath, actionError } = useOutletContext<ConnectSourceContext>();
  const openAgentDrawer = useOpenAgentDrawer();
  const [searchParams, setSearchParams] = useSearchParams();

  // An action that handed the conversation to the agent lands here; open it beside the page.
  useEffect(() => {
    if (searchParams.get("agent") !== "opened") {
      return;
    }
    openAgentDrawer();
    const next = new URLSearchParams(searchParams);
    next.delete("agent");
    setSearchParams(next, { replace: true, preventScrollReset: true });
  }, [searchParams, setSearchParams, openAgentDrawer]);

  return (
    <div className="flex flex-col gap-3">
      {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
      <ConnectStep service={service} method={loaderData.method} connectPath={connectPath} />
    </div>
  );
}

const POLL_INTERVAL_MS = 3000;

function ConnectStep({
  service,
  method,
  connectPath,
}: {
  service: ConnectSource;
  method: ConnectMethod;
  connectPath: string;
}) {
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle";
  const waiting =
    method.kind === "authorization" && method.progress.status === "needs-authorization";

  // The provider's return brings the browser back here, but the gateway can confirm the account a
  // moment later, and a sign-in left open elsewhere ends without one; the page checks until then.
  useEffect(() => {
    if (!waiting) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      if (revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [waiting, revalidator]);

  return (
    <>
      {method.kind === "agent" ? (
        <Form method="post" action={connectPath} className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">
            Needs details only you have, like a token. Your agent sets it up with you.
          </p>
          <input type="hidden" name="source" value={service.id} />
          <ActionItem
            type="submit"
            name="intent"
            value="ask-agent"
            icon="message-square"
            emphasis="primary"
            disabled={busy}
          >
            Connect
          </ActionItem>
        </Form>
      ) : method.kind === "connected" ? (
        <ConnectedActions
          service={service}
          connectionId={method.connectionId}
          busy={busy}
          connectPath={connectPath}
        />
      ) : (
        <AuthorizationState
          service={service}
          connectionId={method.connectionId}
          progress={method.progress}
          busy={busy}
          connectPath={connectPath}
        />
      )}
    </>
  );
}

function AuthorizationState({
  service,
  connectionId,
  progress,
  busy,
  connectPath,
}: {
  service: ConnectSource;
  connectionId: string;
  progress: IntegrationSetupProgress;
  busy: boolean;
  connectPath: string;
}) {
  switch (progress.status) {
    case "ready":
      return (
        <ConnectedActions
          service={service}
          connectionId={connectionId}
          busy={busy}
          connectPath={connectPath}
        />
      );
    case "needs-authorization":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">
            Waiting for you to sign in to {service.label}…
          </p>
          <ActionItemLink
            to={progress.authorizationUrl}
            reloadDocument
            icon="external-link"
            emphasis="primary"
          >
            Continue to {service.label}
          </ActionItemLink>
        </div>
      );
    case "needs-input":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">
            Sign in with {service.label}. Leyway never sees your password.
          </p>
          <ConnectorActionForm
            intent="start"
            action={connectPath}
            connectionId={connectionId}
            busy={busy}
          >
            Connect {service.label}
          </ConnectorActionForm>
        </div>
      );
    case "pending":
      return (
        <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">{progress.message}</p>
      );
    case "blocked":
    case "expired":
      return <InlineAlert>{progress.reason}</InlineAlert>;
  }
  progress satisfies never;
  throw new Error("Connect received an unsupported setup status.");
}

function ConnectedActions({
  service,
  connectionId,
  busy,
  connectPath,
}: {
  service: ConnectSource;
  connectionId: string;
  busy: boolean;
  connectPath: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">
        Your agents can use {service.label} now. Next, put it to work in a workflow.
      </p>
      <ConnectorActionForm
        intent="create-workflow"
        action={connectPath}
        connectionId={connectionId}
        busy={busy}
      >
        Create a workflow
      </ConnectorActionForm>
    </div>
  );
}
