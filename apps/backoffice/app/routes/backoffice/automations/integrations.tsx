import { Link, useOutletContext } from "react-router";

import { backofficeConnectionCatalog } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import { integrationBasePath } from "../integrations/scope";
import type { AutomationLayoutContext } from "./shared";

const SCOPED_INTEGRATION_IDS = ["telegram", "resend", "github"] as const;

type ScopedIntegrationId = (typeof SCOPED_INTEGRATION_IDS)[number];

const SCOPE_SUPPORT: Record<
  ScopedIntegrationId,
  readonly AutomationLayoutContext["selectedScope"]["kind"][]
> = {
  telegram: ["system", "org", "project", "user"],
  resend: ["system", "org"],
  github: ["org"],
};

export function meta() {
  return [
    { title: "Integrations" },
    { name: "description", content: "Manage scoped backoffice integrations." },
  ];
}

export default function BackofficeAutomationIntegrations() {
  const { selectedScope } = useOutletContext<AutomationLayoutContext>();
  const integrations = backofficeConnectionCatalog.filter((connection) =>
    SCOPED_INTEGRATION_IDS.includes(connection.id as ScopedIntegrationId),
  );

  return (
    <div className="space-y-4">
      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Integrations
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">
          Available for {selectedScope.label}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--bo-muted)]">
          Configure the channels available to this scope. GitHub is intentionally limited to
          organisation scopes; Resend is available for organisations and the admin singleton;
          Telegram can be configured on any scope.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {integrations.map((integration) => {
          const id = integration.id as ScopedIntegrationId;
          const supported = SCOPE_SUPPORT[id].includes(selectedScope.kind);
          const managePath = supported
            ? integrationBasePath(selectedScope, integration.routeSegment ?? id)
            : null;

          return (
            <div
              key={integration.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
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
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                  {supported ? "Available" : "Unavailable"}
                </span>
              </div>
              <p className="mt-4 text-sm text-[var(--bo-muted)]">{integration.description}</p>
              <div className="mt-4">
                {managePath ? (
                  <Link
                    to={managePath}
                    className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Manage
                  </Link>
                ) : (
                  <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Not on this scope
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
