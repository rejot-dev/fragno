import { PageHeading } from "@fragno-private/design-system/page-heading";

import { inviteToTeam, loadTeam } from "../members/members.server";
import { TeamSection } from "../members/team";
import { requireOperator } from "../organizations/access.server";
import type { Route } from "./+types/members";

export function meta() {
  return [{ title: "Operators · Bookkeeping" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return { team: await loadTeam(request, await requireOperator(request)) };
}

export async function action({ request }: Route.ActionArgs) {
  return await inviteToTeam(request, await requireOperator(request));
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

/** The people who operate Bookkeeping. Inviting someone here makes them an operator. */
export default function OperatorMembers({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operator"
        title="Operators"
        meta="The people who run Bookkeeping and create firms. They don't open firms' or clients' books unless those invite them."
        actions={null}
      />
      <TeamSection team={loaderData.team} result={actionData} />
    </div>
  );
}
