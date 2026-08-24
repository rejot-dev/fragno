import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/threads-index";

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  await resolveAuthenticatedIntegrationRuntimeScope({
    request,
    context,
    params,
    allowedScopes: ["org", "system"],
  });

  return redirect(`${url.pathname.replace(/\/+$/u, "")}/start`);
}

export default function BackofficeOrganizationResendThreadsIndex() {
  return null;
}
