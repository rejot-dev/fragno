import { backofficeOrganizationContextScope } from "@/backoffice-runtime/resolved-scope";
import { authorizeBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import type { PresenceMember } from "@/presence/contracts";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/presence";

// Mounted outside the Backoffice layout: reading presence is not activity, so polling it must not
// keep an idle tab present.
export async function loader({ request, context }: Route.LoaderArgs) {
  const authorization = await authorizeBackofficePrincipal(request, context);
  // A tab waking from sleep polls before it refreshes its lapsed token. A thrown 401 would replace
  // the whole page with the root error boundary; presence is ambient, so it shows nobody until the
  // next poll instead.
  if (!authorization.ok) {
    return { members: [] satisfies PresenceMember[] };
  }
  const { principal } = authorization;
  const organization = principal.auth.organization;
  // Scope-restricted credentials act for one workspace and do not see who else is around.
  if (!organization || principal.auth.scopeRestriction) {
    return { members: [] satisfies PresenceMember[] };
  }
  const members = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.presence.for(backofficeOrganizationContextScope(organization))
    .commands.listActiveMembers();
  return { members: members.filter((member) => member.userId !== principal.user.id) };
}
