import { redirect } from "react-router";

import {
  backofficeRouteScopePath,
  requireBackofficeRouteScopeFromParams,
} from "@/backoffice-runtime/route-scope";

import type { Route } from "./+types/organization-index";

export async function loader({ params }: Route.LoaderArgs) {
  const scope = requireBackofficeRouteScopeFromParams(params);
  return redirect(`/backoffice/sessions/${backofficeRouteScopePath(scope)}/sessions`);
}
