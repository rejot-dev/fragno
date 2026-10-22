import { BackofficePageHeader } from "@fragno-private/design-system/page-header";

import { inviteToTeam, loadTeam } from "../members/members.server";
import { TeamSection } from "../members/team";
import { requireOrganization } from "../organizations/access.server";
import type { Route } from "./+types/members";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Members · ${loaderData?.name ?? "Firm"}` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireOrganization(request, params.slug, "firm");
  return { name: context.organization.name, team: await loadTeam(request, context) };
}

export async function action({ request, params }: Route.ActionArgs) {
  return await inviteToTeam(request, await requireOrganization(request, params.slug, "firm"));
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function FirmMembers({ loaderData, actionData, params }: Route.ComponentProps) {
  const { name, team } = loaderData;
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Members"
        description={`Your colleagues at ${name}. Being a member of ${name} does not open its clients' books: a client's owner invites you.`}
        breadcrumbs={[{ label: name, to: `/f/${params.slug}` }, { label: "Members" }]}
      />
      <TeamSection team={team} result={actionData} />
    </div>
  );
}
