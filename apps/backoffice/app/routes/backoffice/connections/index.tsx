import { Link, useOutletContext } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { backofficeConnectionCatalog } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

const CONNECTIONS = backofficeConnectionCatalog;

export function meta() {
  return [
    { title: "Backoffice Connections" },
    { name: "description", content: "Manage backoffice connections and integrations." },
  ];
}

export default function BackofficeConnections() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const activeOrganizationId = me.activeOrganization?.organization.id ?? null;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Connections" }]}
        eyebrow="Integrations"
        title="Connection catalog and health."
        description="Enable and manage the channels that route fragment activity into the backoffice."
      />

      {!activeOrganizationId ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          Set an active organisation before opening a connection workspace.
        </div>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2">
        {CONNECTIONS.map((connection) => {
          const connectionLink =
            activeOrganizationId && connection.routeSegment
              ? `/backoffice/connections/${connection.routeSegment}/${activeOrganizationId}`
              : null;
          const isAvailable = Boolean(connectionLink);
          return (
            <div
              key={connection.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {connection.configurable ? "Configurable" : "Environment"}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    {connection.label}
                  </h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                  {isAvailable ? "Live" : "Soon"}
                </span>
              </div>
              <p className="mt-4 text-sm text-[var(--bo-muted)]">{connection.description}</p>
              <div className="mt-4">
                {isAvailable ? (
                  <Link
                    to={connectionLink!}
                    className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Manage
                  </Link>
                ) : (
                  <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Coming soon
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
