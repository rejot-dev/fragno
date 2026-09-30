import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { redirect, useOutletContext } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { formatTimestamp } from "../formatting";
import type { Route } from "./+types/index";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const activeOrganization = me.activeOrganization?.organization ?? null;
  if (activeOrganization) {
    return redirect(
      `/backoffice/automations/org/${encodeURIComponent(activeOrganization.slug)}/integrations/resend`,
    );
  }

  return null;
}

export function meta() {
  return [
    { title: "Resend Connection" },
    { name: "description", content: "Manage Resend connections by organization." },
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
          { label: "Automations", to: "/backoffice/automations" },
          { label: "Resend" },
        ]}
        eyebrow="Integrations"
        title="Resend connection workspace."
        description="Pick an organization to configure Resend webhooks and monitor email delivery."
        actions={
          <ButtonLink variant="secondary" to="/backoffice/automations">
            Back to automations
          </ButtonLink>
        }
      />

      {organizations.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No organizations are linked to this account yet.
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
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {organization.slug}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                    {organization.name}
                  </h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                  {activeOrganizationId === organization.id ? "Active" : "Idle"}
                </span>
              </div>

              <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
                <p className="flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Roles
                  </span>
                  <span className="font-semibold text-[var(--bo-fg)]">
                    {member.roles.join(", ") || "Member"}
                  </span>
                </p>
                <p className="flex items-center justify-between">
                  <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Created
                  </span>
                  <span>{formatTimestamp(organization.createdAt)}</span>
                </p>
              </div>

              <div className="mt-4">
                <ButtonLink
                  variant="accent"
                  to={`/backoffice/automations/org/${encodeURIComponent(organization.slug)}/integrations/resend`}
                >
                  Manage Resend
                </ButtonLink>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
