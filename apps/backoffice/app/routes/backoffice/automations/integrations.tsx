import { Link, useOutletContext } from "react-router";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { BackofficeStatusLight } from "@/components/backoffice";
import { backofficeConnectionCatalog } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import { integrationBasePath } from "../integrations/scope";
import type { AutomationLayoutContext } from "./layout-context";

const SCOPED_INTEGRATION_IDS = ["telegram", "resend", "reson8", "github"] as const;

type ScopedIntegrationId = (typeof SCOPED_INTEGRATION_IDS)[number];

type IntegrationStatus = {
  label: string;
  tone: "info" | "live" | "waiting" | "failed" | "muted";
};

const SCOPE_SUPPORT: Record<
  ScopedIntegrationId,
  readonly AutomationLayoutContext["selectedScope"]["kind"][]
> = {
  telegram: ["system", "org", "project", "user"],
  resend: ["system", "org"],
  reson8: ["org"],
  github: ["org"],
};

export function meta() {
  return [
    { title: "Integrations" },
    { name: "description", content: "Manage scoped backoffice integrations." },
  ];
}

export default function BackofficeAutomationIntegrations() {
  const { selectedScope, collections } = useOutletContext<AutomationLayoutContext>();
  const configuredSourcesQuery = useLiveQuery(
    (query) =>
      query
        .from({ event: collections.events })
        .where(({ event }) => eq(event.eventType, "capability.configured"))
        .select(({ event }) => ({ source: event.source }))
        .distinct(),
    [collections.events],
  );
  const configuredSources = new Set(
    (configuredSourcesQuery.data ?? []).map((event) => event.source),
  );
  const integrations = backofficeConnectionCatalog.filter((connection) =>
    SCOPED_INTEGRATION_IDS.includes(connection.id as ScopedIntegrationId),
  );

  return (
    <div className="flex-1 space-y-4">
      <section className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Integrations
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">
          Available for {selectedScope.label}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--bo-muted)]">
          Configure the channels available to this scope. GitHub is intentionally limited to
          organisation scopes; Reson8 is organisation-scoped; Resend is available for organisations
          and the admin singleton; Telegram can be configured on any scope.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {integrations.map((integration) => {
          const id = integration.id as ScopedIntegrationId;
          const supported = SCOPE_SUPPORT[id].includes(selectedScope.kind);
          const managePath = supported
            ? integrationBasePath(selectedScope, integration.routeSegment ?? id)
            : null;
          const status: IntegrationStatus | null = !supported
            ? { label: "Unavailable", tone: "muted" }
            : !integration.configurable
              ? null
              : configuredSourcesQuery.isError
                ? { label: "Status unavailable", tone: "failed" }
                : !configuredSourcesQuery.isReady
                  ? { label: "Checking", tone: "info" }
                  : configuredSources.has(id)
                    ? { label: "Connected", tone: "live" }
                    : { label: "Setup required", tone: "waiting" };

          return (
            <div
              key={integration.id}
              className="bo-fragment-surface bo-panel-surface bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {integration.configurable ? "Configurable" : "Environment"}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    {integration.label}
                  </h3>
                </div>
                {status ? (
                  <BackofficeStatusLight tone={status.tone}>{status.label}</BackofficeStatusLight>
                ) : null}
              </div>
              <p className="mt-4 text-sm text-[var(--bo-muted)]">{integration.description}</p>
              {managePath ? (
                <div className="mt-4">
                  <Link
                    to={managePath}
                    className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Manage
                  </Link>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
