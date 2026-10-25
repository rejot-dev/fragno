import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";

import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { PlaceList } from "../shell/place-list";
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
    <ButtonLink variant="solid" to={`/f/${params.slug}/clients/new`}>
      New client
    </ButtonLink>
  );
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={firmName}
        title="Clients"
        meta={`The businesses whose books ${firmName} keeps. You open a client's books as a member of it.`}
        actions={clients.length > 0 ? newClient : null}
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
        <PlaceList title="All clients" icon="briefcase" places={clients} />
      )}
    </div>
  );
}
