import { redirect } from "react-router";

import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

import { automationScopeFromRouteParams } from "../automations/scope";
import type { Route } from "./+types/organisation-index";

export async function loader({ params }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  return redirect(`/backoffice/sessions/${backofficeContextScopeRoutePath(scope)}/sessions`);
}
