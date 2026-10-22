import { ButtonLink } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import type { Route } from "./+types/dashboard";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Clients · ${loaderData?.firmName ?? "Firm"}` }];
}

/**
 * The firm's clients. Membership of the firm does not open them: its members reach a client as
 * members of it.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization, user } = await requireOrganization(request, params.slug, "firm");
  const directory = env.DIRECTORY.getByName("directory");
  const [clients, memberships] = await Promise.all([
    directory.listClients(organization.id),
    directory.listMemberships(user.backofficeUserId),
  ]);
  const joined = new Set(memberships.map((membership) => membership.organization.id));
  return {
    firmName: organization.name,
    clients: clients.map(({ id, name, kind, slug }) => ({
      name,
      path: organizationPath(kind, slug),
      member: joined.has(id),
    })),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function FirmDashboard({ loaderData, params }: Route.ComponentProps) {
  const { firmName, clients } = loaderData;
  const newClient = (
    <ButtonLink variant="accent" to={`/f/${params.slug}/clients/new`}>
      New client
    </ButtonLink>
  );
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Clients"
        description={`The businesses whose books ${firmName} keeps. You open a client's books as a member of it.`}
        breadcrumbs={[{ label: firmName, to: `/f/${params.slug}` }, { label: "Clients" }]}
        actions={clients.length > 0 ? newClient : undefined}
      />
      {clients.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="No clients yet"
          description="Create a client, then invite them to their books."
          actions={newClient}
        />
      ) : (
        <FormContainer title="All clients">
          <ul className="divide-y divide-[var(--bo-border)]">
            {clients.map(({ name, path, member }) => (
              <li key={path} className="flex items-center justify-between gap-3 py-3 text-sm">
                {member ? (
                  <Link to={path} className="font-medium">
                    {name}
                  </Link>
                ) : (
                  <span className="font-medium">{name}</span>
                )}
                {!member && (
                  <span className="text-xs text-[var(--bo-muted)]">You're not a member</span>
                )}
              </li>
            ))}
          </ul>
        </FormContainer>
      )}
    </div>
  );
}
