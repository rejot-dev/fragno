import { PageHeading } from "@fragno-private/design-system/page-heading";

import { inviteToTeam, loadTeam } from "../members/members.server";
import { TeamSection } from "../members/team";
import { requireOrganization } from "../organizations/access.server";
import type { Route } from "./+types/members";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Members · ${loaderData?.name ?? "Client"}` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireOrganization(request, params.slug, "client");
  return { name: context.organization.name, team: await loadTeam(request, context) };
}

export async function action({ request, params }: Route.ActionArgs) {
  return await inviteToTeam(request, await requireOrganization(request, params.slug, "client"));
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function ClientMembers({ loaderData, actionData }: Route.ComponentProps) {
  const { name, team } = loaderData;
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={name}
        title="Members"
        meta={`Everyone here opens ${name}'s books, and so does everyone in the firm keeping them. Owners and admins invite new people.`}
        actions={null}
      />
      <TeamSection team={team} result={actionData} />
    </div>
  );
}
