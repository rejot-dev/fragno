import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { useOutletContext } from "react-router";

import { canManage } from "../../workers/directory/membership";
import { requireOrganization } from "../organizations/access.server";
import { PlaceList } from "../shell/place-list";
import type { Route } from "./+types/overview";
import type { ClientOutletContext } from "./layout";

export function meta() {
  return [{ title: "Overview · Bookkeeping" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization, roles } = await requireOrganization(request, params.slug, "client");
  return {
    administrations: await env.DIRECTORY.getByName("directory").listAdministrations(
      organization.id,
    ),
    canCreate: canManage(roles),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function ClientOverview({ loaderData }: Route.ComponentProps) {
  const { user, client } = useOutletContext<ClientOutletContext>();
  const { administrations, canCreate } = loaderData;
  const base = `/w/${client.slug}`;
  const create = canCreate ? (
    <ButtonLink variant="solid" to={`${base}/administrations/new`}>
      New administration
    </ButtonLink>
  ) : null;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={`Welcome, ${user.name}`}
        title={client.name}
        meta="Each administration holds the books of one business."
        actions={create}
      />
      {administrations.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="Set up your books"
          description={
            canCreate
              ? "Create an administration for the business to start its books."
              : "No administrations yet. An owner or admin of this workspace creates them."
          }
          actions={create}
        />
      ) : (
        <PlaceList
          title="Administrations"
          icon="book-open"
          places={administrations.map((administration) => ({
            name: administration.name,
            path: `${base}/a/${administration.slug}`,
            member: true,
          }))}
        />
      )}
    </div>
  );
}
