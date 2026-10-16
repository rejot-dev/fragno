import { redirect } from "react-router";

import { resolveAuthenticatedIntegrationRuntimeScope } from "../../integrations/scope.server";
import type { Route } from "./+types/threads-index";

export async function loader({ context, url }: Route.LoaderArgs) {
  resolveAuthenticatedIntegrationRuntimeScope({
    context,
    allowedScopes: ["org", "system"],
  });

  return redirect(`${url.pathname.replace(/\/+$/u, "")}/start`);
}

export default function BackofficeOrganizationResendThreadsIndex() {
  return null;
}
