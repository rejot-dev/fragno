import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import type { PresenceMember } from "@/presence/contracts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/presence";

// Mounted outside the Backoffice layout: reading presence is not activity, so polling it must not
// keep an idle tab present.
export async function loader({ request, context }: Route.LoaderArgs) {
  const principal = await requireBackofficePrincipal(request, context);
  const organization = principal.auth.organization;
  // Scope-restricted credentials act for one workspace and do not see who else is around.
  if (!organization || principal.auth.scopeRestriction) {
    return { members: [] satisfies PresenceMember[] };
  }
  const members = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.presence.forOrg(organization.id)
    .commands.listActiveMembers();
  return { members: members.filter((member) => member.userId !== principal.user.id) };
}
