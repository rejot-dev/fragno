import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";

import { canManage } from "../../workers/directory/membership";
import { requireOrganization } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { PlaceList } from "../shell/place-list";
import type { Route } from "./+types/dashboard";
import { confirmClients } from "./clients.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Clients · ${loaderData?.firmName ?? "Firm"}` }];
}

/**
 * The firm's clients. The firm manages them in Backoffice, so every member of the firm opens each
 * one, with their role in the firm, owners as admins.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization, roles } = await requireOrganization(request, params.slug, "firm");
  await confirmClients(request, organization.id);
  const clients = await env.DIRECTORY.getByName("directory").listClients(organization.id);
  return {
    firmName: organization.name,
    clients: clients.map(({ name, kind, slug }) => ({
      name,
      path: organizationPath(kind, slug),
      member: true,
    })),
    canCreate: canManage(roles),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function FirmDashboard({ loaderData, params }: Route.ComponentProps) {
  const { firmName, clients, canCreate } = loaderData;
  const newClient = canCreate ? (
    <ButtonLink variant="solid" to={`/f/${params.slug}/clients/new`}>
      New client
    </ButtonLink>
  ) : null;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={firmName}
        title="Clients"
        meta={`The businesses whose books ${firmName} keeps. Everyone in the firm opens them.`}
        actions={clients.length > 0 ? newClient : null}
      />
      {clients.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="No clients yet"
          description={
            canCreate
              ? "Create a client, then invite them to their books."
              : "The firm's owners and admins create its clients."
          }
          actions={newClient}
        />
      ) : (
        <PlaceList title="All clients" icon="briefcase" places={clients} />
      )}
    </div>
  );
}
