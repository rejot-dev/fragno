import { redirect } from "react-router";

import { resolveScopeFromRouteParams } from "../../integrations/scope";
import type { Route } from "./+types/threads-index";

export async function loader({ params, url }: Route.LoaderArgs) {
  resolveScopeFromRouteParams(params);

  return redirect(`${url.pathname.replace(/\/+$/u, "")}/start`);
}

export default function BackofficeOrganisationResendThreadsIndex() {
  return null;
}
