import type {
  IntegrationOverview,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Field } from "@fragno-private/design-system/controls/field";
import type { IconName } from "@fragno-private/design-system/icon";
import { InlineAlert } from "@fragno-private/design-system/feedback/inline-alert";
import { Input } from "@fragno-private/design-system/controls/input";
import { Select } from "@fragno-private/design-system/controls/select";
import {
  SourceCatalog,
  type SourceCatalogItem,
} from "@fragno-private/design-system/controls/source-catalog";
import { TextArea } from "@fragno-private/design-system/controls/text-area";
import { WizardStepper } from "@fragno-private/design-system/navigation/wizard-stepper";
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useNavigation, useRevalidator } from "react-router";

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
import type { Route } from "./+types/connect";
import { integrationsScopeBasePath } from "./connection-paths";

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

const SCHEDULES = {
  "every-15-minutes": { label: "Every 15 minutes", describe: () => "every 15 minutes" },
  hourly: { label: "Every hour", describe: () => "every hour, on the hour" },
  daily: { label: "Every day", describe: (time: string) => `every day at ${time}` },
} as const;

type ScheduleId = keyof typeof SCHEDULES;

function isScheduleId(value: unknown): value is ScheduleId {
  return typeof value === "string" && Object.hasOwn(SCHEDULES, value);
}

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
  const automate =
    url.searchParams.get("step") === "automate" &&
    method.kind === "authorization" &&
    method.progress.status === "ready";
  return {
    ...base,
    step: automate
      ? { kind: "automate" as const, service, connectionId: method.connectionId }
      : { kind: "connect" as const, service, method },
  };
}

function automationPrompt({
  service,
  connectionId,
  schedule,
  time,
  timeZone,
  goal,
}: {
  service: string;
  connectionId: string;
  schedule: ScheduleId;
  time: string;
  timeZone: string;
  goal: string;
}): string {
  return [
    `I just connected ${service} (connection ${connectionId}). Build me a workflow for it.`,
    "",
    `When: on a schedule, ${SCHEDULES[schedule].describe(time)} (time zone ${timeZone}).`,
    `What it should do: ${goal}`,
    "",
    "Follow the building-automations skill: save the workflow under /workspace/automations and route a schedule to it. Scheduled routes need explicit delegated-user grants, so grant only what the workflow uses. Then tell me what you built.",
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
    // The page's next check reads the attempt this starts, with its authorization URL.
    await integrations.setup({ kind: "input", connectionId, input: { start: true } });
    return { error: null };
  }

  const { scope } = requireRouteScope(context).execution;
  let content: string;
  if (intent === "ask-agent") {
    content = `Help me connect ${service.label} (integration ${service.id}) in this scope.`;
  } else if (intent === "automate") {
    const connectionId = connectorSetupTarget(service);
    const schedule = form.get("schedule");
    const goal = form.get("goal");
    const time = form.get("time");
    const timeZone = form.get("timeZone");
    if (!connectionId || !isScheduleId(schedule)) {
      return data({ error: "Choose how often the workflow runs." }, { status: 400 });
    }
    if (typeof goal !== "string" || goal.trim() === "") {
      return data({ error: "Describe what the workflow should do." }, { status: 400 });
    }
    content = automationPrompt({
      service: service.label,
      connectionId,
      schedule,
      time: typeof time === "string" && time !== "" ? time : "09:00",
      timeZone: typeof timeZone === "string" && timeZone !== "" ? timeZone : "UTC",
      goal: goal.trim(),
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
  // The conversation continues in the agent drawer, which the page opens on this redirect.
  throw redirect(`${new URL(request.url).pathname}?agent=opened`);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Connect · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

const STEPS = [
  { title: "Choose a source", description: "An app or service to connect." },
  { title: "Connect", description: "Sign in so agents can use it." },
  { title: "Automate", description: "Optional: run a workflow on a schedule." },
];

export default function BackofficeIntegrationsConnect({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { services, integrationsPath, step } = loaderData;
  const openAgentDrawer = useOpenAgentDrawer();
  const [agentOpened, setAgentOpened] = useState(false);

  // An action that handed the conversation to the agent lands here; open it beside the page.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("agent") === "opened") {
      openAgentDrawer();
      setAgentOpened(true);
      url.searchParams.delete("agent");
      window.history.replaceState(window.history.state, "", url);
    }
  }, [openAgentDrawer]);

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
  const stepIndex = step.kind === "choose" ? 0 : step.kind === "connect" ? 1 : 2;

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
      <WizardStepper steps={STEPS} currentStep={stepIndex} />
      {actionData?.error ? <InlineAlert>{actionData.error}</InlineAlert> : null}
      {agentOpened ? (
        <InlineAlert>
          Your agent is on it. Follow along in the conversation beside the page.
        </InlineAlert>
      ) : null}

      {step.kind === "choose" ? (
        <SourceCatalog label="Sources to connect" items={items} />
      ) : step.kind === "connect" ? (
        <ConnectStep
          service={step.service}
          method={step.method}
          integrationsPath={integrationsPath}
        />
      ) : (
        <AutomateStep service={step.service} />
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

  // The provider's consent happens in another tab, and its return does not come back here, so the
  // page checks until the gateway confirms the account.
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
          <div className="flex gap-2">
            <ButtonLink
              to={`?source=${encodeURIComponent(service.id)}&step=automate`}
              variant="accent"
            >
              Create a workflow
            </ButtonLink>
            <ButtonLink to={integrationsPath} variant="ghost">
              Done
            </ButtonLink>
          </div>
        </div>
      );
    case "needs-authorization":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--bo-fg)]">
            Sign in to {service.label} in the new tab. This page continues once you have.
          </p>
          <div className="flex items-center gap-3">
            <ButtonLink
              to={progress.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="accent"
            >
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

function AutomateStep({ service }: { service: IntegrationOverview }) {
  const navigation = useNavigation();
  const [schedule, setSchedule] = useState<ScheduleId>("daily");
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  return (
    <Form
      method="post"
      className="flex max-w-2xl flex-col gap-5 rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-5"
    >
      <SelectedSource service={service} />
      <input type="hidden" name="source" value={service.id} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How often">
          <Select
            name="schedule"
            value={schedule}
            onValueChange={(value) => {
              if (value !== null) {
                setSchedule(value);
              }
            }}
            options={Object.entries(SCHEDULES).map(([value, { label }]) => ({
              value: value as ScheduleId,
              label,
            }))}
          />
        </Field>
        {schedule === "daily" ? (
          <Field label="At" description={`Your time zone, ${timeZone}.`}>
            <Input type="time" name="time" defaultValue="09:00" />
          </Field>
        ) : null}
      </div>
      <Field
        label="What should it do?"
        description={`For example: "Summarize new ${service.label} activity and email it to me."`}
      >
        <TextArea name="goal" rows={4} required />
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="automate"
          variant="accent"
          disabled={navigation.state !== "idle"}
        >
          Create workflow
        </Button>
        <ButtonLink to={`?source=${encodeURIComponent(service.id)}`} variant="ghost">
          Back
        </ButtonLink>
      </div>
    </Form>
  );
}
