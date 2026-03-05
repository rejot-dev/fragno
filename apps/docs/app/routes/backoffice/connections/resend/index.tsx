import { Link, redirect, useOutletContext } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { formatTimestamp } from "./shared";
import { getAuthMe } from "@/fragno/auth-server";
import type { Route } from "./+types/index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return redirect("/backoffice/login");
  }

  const activeOrganizationId =
    me.activeOrganization?.organization.id ?? me.organizations?.[0]?.organization.id ?? null;
  if (activeOrganizationId) {
    return redirect(`/backoffice/connections/resend/${activeOrganizationId}`);
  }

  return null;
}

export function meta() {
  return [
    { title: "Resend Connection" },
    { name: "description", content: "Manage Resend connections by organisation." },
  ];
}

export default function BackofficeConnectionsResend() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const organizations = me.organizations ?? [];
  const activeOrganizationId = me.activeOrganization?.organization.id ?? null;

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Connections", to: "/backoffice/connections" },
          { label: "Resend" },
        ]}
        eyebrow="Connections"
        title="Resend connection workspace."
        description="Pick an organisation to configure Resend webhooks and monitor email delivery."
        actions={
          <Link
            to="/backoffice/connections"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to connections
          </Link>
        }
      />

      {organizations.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No organisations are linked to this account yet.
        </div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2">
          {organizations.map(({ organization, member }) => (
            <div
              key={organization.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                    {organization.slug}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    {organization.name}
                  </h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                  {activeOrganizationId === organization.id ? "Active" : "Idle"}
                </span>
              </div>

              <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
                <p className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                    Roles
                  </span>
                  <span className="font-semibold text-[var(--bo-fg)]">
                    {member.roles.join(", ") || "Member"}
                  </span>
                </p>
                <p className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                    Created
                  </span>
                  <span>{formatTimestamp(organization.createdAt)}</span>
                </p>
              </div>

              <div className="mt-4">
                <Link
                  to={`/backoffice/connections/resend/${organization.id}`}
                  className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
                >
                  Manage Resend
                </Link>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
