import { Link, useOutletContext } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

const CONNECTIONS = [
  {
    id: "telegram",
    name: "Telegram",
    description: "Capture chat activity, configure webhooks, and send messages as a bot.",
    status: "Available",
  },
  {
    id: "resend",
    name: "Resend",
    description: "Send emails, register webhooks, and monitor delivery status.",
    status: "Available",
  },
  {
    id: "upload",
    name: "Upload",
    description: "Configure org-scoped storage, inspect files, and run manual upload actions.",
    status: "Available",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Sync workspace activity and notify channel subscribers.",
    status: "Planned",
    to: null,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Track installation webhooks, link repositories, and inspect pull requests.",
    status: "Available",
  },
];

export function meta() {
  return [
    { title: "Backoffice Connections" },
    { name: "description", content: "Manage backoffice connections and integrations." },
  ];
}

export default function BackofficeConnections() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const organizations = me.organizations ?? [];
  const activeOrganizationId =
    me.activeOrganization?.organization.id ?? organizations[0]?.organization.id;
  const telegramTarget = activeOrganizationId
    ? `/backoffice/connections/telegram/${activeOrganizationId}`
    : null;
  const resendTarget = activeOrganizationId
    ? `/backoffice/connections/resend/${activeOrganizationId}`
    : null;
  const githubTarget = activeOrganizationId
    ? `/backoffice/connections/github/${activeOrganizationId}`
    : null;
  const uploadTarget = activeOrganizationId
    ? `/backoffice/connections/upload/${activeOrganizationId}`
    : null;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Connections" }]}
        eyebrow="Integrations"
        title="Connection catalog and health."
        description="Enable and manage the channels that route fragment activity into the backoffice."
      />

      <section className="grid gap-3 md:grid-cols-2">
        {CONNECTIONS.map((connection) => {
          const connectionLink =
            connection.id === "telegram"
              ? telegramTarget
              : connection.id === "resend"
                ? resendTarget
                : connection.id === "github"
                  ? githubTarget
                  : connection.id === "upload"
                    ? uploadTarget
                    : null;
          const isAvailable = Boolean(connectionLink);
          return (
            <div
              key={connection.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                    {connection.status}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    {connection.name}
                  </h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                  {isAvailable ? "Live" : "Soon"}
                </span>
              </div>
              <p className="mt-4 text-sm text-[var(--bo-muted)]">{connection.description}</p>
              <div className="mt-4">
                {isAvailable ? (
                  <Link
                    to={connectionLink!}
                    className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Manage
                  </Link>
                ) : (
                  <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
