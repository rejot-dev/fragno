import type {
  IntegrationOverview,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import type { IconName } from "@fragno-private/design-system/icon";
import { InlineAlert } from "@fragno-private/design-system/feedback/inline-alert";
import {
  SourceCatalog,
  type SourceCatalogItem,
} from "@fragno-private/design-system/controls/source-catalog";
import { useEffect, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { useOpenAgentDrawer } from "@/components/backoffice/open-agent-drawer";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { MAIN_PI_AGENT_NAME } from "@/fragno/pi/agent/pi-agent-name";
import { integrationConnectionKind } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import {
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { submitPiManagerPrompt } from "../agents/data";
import { piAgentsPath } from "../agents/path";
import type { Route } from "./+types/connect";
import { integrationsConnectPath, integrationsScopeBasePath } from "./connection-paths";

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
 * How a chosen service connects. Connector services sign in with their provider here; every other
 * service is set up by the agent, which knows each one's configuration.
 */
type ConnectMethod =
  | { kind: "authorization"; connectionId: string; progress: IntegrationSetupProgress }
  | { kind: "agent" };

function connectorSetupTarget(service: IntegrationOverview): string | null {
  const [target] = service.setupTargets;
  return target && integrationConnectionKind(target.connectionId) === "connector"
    ? target.connectionId
    : null;
}

function integrationsRuntime(context: Route.LoaderArgs["context"]) {
  const { execution } = requireRouteScope(context);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  return createIntegrationsRuntime({ runtime, kernel, execution, nowEpochMs: Date.now });
}

async function connectedIntegrationIds(
  integrations: ReturnType<typeof integrationsRuntime>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await integrations.list({ cursor });
    for (const connection of page.connections) {
      ids.add(connection.integrationId);
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return ids;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);
  const integrations = integrationsRuntime(context);
  const url = new URL(request.url);
  const [services, connected] = await Promise.all([
    integrations.discover(),
    connectedIntegrationIds(integrations),
  ]);
  const base = {
    selectedScope,
    integrationsPath: integrationsScopeBasePath(selectedScope),
    services: services.map((service) => ({ ...service, connected: connected.has(service.id) })),
  };

  // A provider's return names the connection it confirmed; the wizard continues with its service.
  const returned = url.searchParams.get("connection");
  if (returned !== null) {
    const owner = services.find((candidate) =>
      candidate.setupTargets.some((target) => target.connectionId === returned),
    );
    throw redirect(owner ? `?${new URLSearchParams({ source: owner.id })}` : "?");
  }
  const service = services.find((candidate) => candidate.id === url.searchParams.get("source"));
  if (!service) {
    return { ...base, step: { kind: "choose" as const } };
  }
  const connectionId = connectorSetupTarget(service);
  const method: ConnectMethod = connectionId
    ? {
        kind: "authorization",
        connectionId,
        // Checking an attempt the provider finished confirms it with the gateway.
        progress: await integrations.setup({ kind: "check", connectionId }),
      }
    : { kind: "agent" };
  return { ...base, step: { kind: "connect" as const, service, method } };
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
  const integrations = integrationsRuntime(context);
  const services = await integrations.discover();
  const service = services.find((candidate) => candidate.id === form.get("source"));
  if (!service) {
    return data({ error: "Choose a source to connect." }, { status: 400 });
  }

  if (intent === "start") {
    const connectionId = connectorSetupTarget(service);
    if (!connectionId) {
      return data({ error: `${service.label} does not sign in here.` }, { status: 400 });
    }
    // The provider returns the browser to this wizard, which then finds the account connected.
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

  const { scope } = requireRouteScope(context).execution;
  let content: string;
  if (intent === "ask-agent") {
    content = `Help me connect ${service.label} (integration ${service.id}) in this scope.`;
  } else if (intent === "create-workflow") {
    const connectionId = connectorSetupTarget(service);
    if (!connectionId) {
      return data({ error: `${service.label} has no connection to build on.` }, { status: 400 });
    }
    const timeZone = form.get("timeZone");
    content = workflowPrompt({
      service: service.label,
      connectionId,
      timeZone: typeof timeZone === "string" && timeZone !== "" ? timeZone : "UTC",
    });
  } else {
    return data({ error: "Unsupported action." }, { status: 400 });
  }

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
  // Paths are built from the scope rather than the request, whose URL is React Router's data
  // endpoint. Building a workflow is a longer conversation, so it continues on the agent's own page;
  // setting up a source continues in the drawer beside it, which the page opens on this redirect.
  const selectedScope = requireScopeSelection(context);
  if (intent === "create-workflow") {
    const agentsPath = piAgentsPath(backofficeRouteScopeFromResolvedScope(selectedScope));
    throw redirect(`${agentsPath}/${encodeURIComponent(MAIN_PI_AGENT_NAME)}`);
  }
  const search = new URLSearchParams({ source: service.id, agent: "opened" });
  throw redirect(`${integrationsConnectPath(selectedScope)}?${search}`);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Connect · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeIntegrationsConnect({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { services, integrationsPath, step } = loaderData;
  const openAgentDrawer = useOpenAgentDrawer();
  const [searchParams, setSearchParams] = useSearchParams();
  const [agentOpened, setAgentOpened] = useState(false);

  // An action that handed the conversation to the agent lands here; open it beside the page.
  useEffect(() => {
    if (searchParams.get("agent") !== "opened") {
      return;
    }
    openAgentDrawer();
    setAgentOpened(true);
    const next = new URLSearchParams(searchParams);
    next.delete("agent");
    setSearchParams(next, { replace: true, preventScrollReset: true });
  }, [searchParams, setSearchParams, openAgentDrawer]);

  const items: SourceCatalogItem[] = services.map((service) => ({
    id: service.id,
    label: service.label,
    description: service.description,
    icon: service.iconUrl
      ? { kind: "image", url: service.iconUrl }
      : { kind: "symbol", name: BUILT_IN_SYMBOLS[service.id] ?? "box" },
    categories: service.categories,
    badge: service.connected ? "Connected" : null,
    to: `?source=${encodeURIComponent(service.id)}`,
  }));

  return (
    <div className={`${backofficePageBodyClassName} flex flex-col gap-6`}>
      <header className="flex flex-col gap-2">
        <Link to={integrationsPath} className="text-xs font-semibold text-[var(--bo-muted)]">
          ← Integrations
        </Link>
        <h1 className="text-xl font-semibold text-[var(--bo-fg)]">Connect a source</h1>
        <p className="text-sm text-[var(--bo-muted)]">
          Connected apps become available to your agents, and can run workflows of their own.
        </p>
      </header>
      {actionData?.error ? <InlineAlert>{actionData.error}</InlineAlert> : null}
      {agentOpened ? (
        <InlineAlert>
          Your agent is on it. Follow along in the conversation beside the page.
        </InlineAlert>
      ) : null}

      {step.kind === "choose" ? (
        <SourceCatalog label="Sources to connect" items={items} />
      ) : (
        <ConnectStep
          service={step.service}
          method={step.method}
          integrationsPath={integrationsPath}
        />
      )}
    </div>
  );
}

function SelectedSource({ service }: { service: IntegrationOverview }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        {service.iconUrl ? <img src={service.iconUrl} alt="" className="size-7" /> : null}
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--bo-fg)]">{service.label}</h2>
        <p className="text-sm text-[var(--bo-muted)]">{service.description}</p>
      </div>
    </div>
  );
}

const POLL_INTERVAL_MS = 3000;

function ConnectStep({
  service,
  method,
  integrationsPath,
}: {
  service: IntegrationOverview;
  method: ConnectMethod;
  integrationsPath: string;
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
    <section className="flex max-w-2xl flex-col gap-5 rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5">
      <SelectedSource service={service} />
      {method.kind === "agent" ? (
        <Form method="post" className="flex flex-col gap-3">
          <p className="text-sm text-[var(--bo-fg)]">
            {service.label} is set up with a few details only you have, like tokens or addresses.
            Your agent walks you through them.
          </p>
          <input type="hidden" name="source" value={service.id} />
          <div className="flex gap-2">
            <Button type="submit" name="intent" value="ask-agent" variant="accent" disabled={busy}>
              Set up with your agent
            </Button>
            <ButtonLink to="?" variant="ghost">
              Choose another source
            </ButtonLink>
          </div>
        </Form>
      ) : (
        <AuthorizationState
          service={service}
          progress={method.progress}
          busy={busy}
          integrationsPath={integrationsPath}
        />
      )}
    </section>
  );
}

function AuthorizationState({
  service,
  progress,
  busy,
  integrationsPath,
}: {
  service: IntegrationOverview;
  progress: IntegrationSetupProgress;
  busy: boolean;
  integrationsPath: string;
}) {
  switch (progress.status) {
    case "ready":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-[var(--bo-fg)]">
            {service.label} is connected. Your agents can use it now.
          </p>
          <p className="text-sm text-[var(--bo-muted)]">
            Want something to happen with it regularly? Set up a workflow next.
          </p>
          <Form method="post" className="flex gap-2">
            <input type="hidden" name="source" value={service.id} />
            <TimeZoneInput />
            <Button
              type="submit"
              name="intent"
              value="create-workflow"
              variant="accent"
              disabled={busy}
            >
              Create a workflow
            </Button>
            <ButtonLink to={integrationsPath} variant="ghost">
              Done
            </ButtonLink>
          </Form>
        </div>
      );
    case "needs-authorization":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--bo-fg)]">
            Sign in to {service.label} to finish. You come back here once you have.
          </p>
          <div className="flex items-center gap-3">
            <ButtonLink to={progress.authorizationUrl} reloadDocument variant="accent">
              Continue to {service.label}
            </ButtonLink>
            <span className="text-xs text-[var(--bo-muted)]">Waiting for {service.label}…</span>
          </div>
        </div>
      );
    case "needs-input":
      return (
        <Form method="post" className="flex flex-col gap-3">
          <p className="text-sm text-[var(--bo-fg)]">
            You sign in with {service.label} itself; Backoffice never sees your password.
          </p>
          <input type="hidden" name="source" value={service.id} />
          <div className="flex gap-2">
            <Button type="submit" name="intent" value="start" variant="accent" disabled={busy}>
              Connect {service.label}
            </Button>
            <ButtonLink to="?" variant="ghost">
              Choose another source
            </ButtonLink>
          </div>
        </Form>
      );
    case "pending":
      return <p className="text-sm text-[var(--bo-muted)]">{progress.message}</p>;
    case "blocked":
    case "expired":
      return <InlineAlert>{progress.reason}</InlineAlert>;
  }
  progress satisfies never;
  throw new Error("Connect received an unsupported setup status.");
}

/** The reader's time zone, which only the browser knows, so the agent schedules in it. */
function TimeZoneInput() {
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return <input type="hidden" name="timeZone" value={timeZone} />;
}
