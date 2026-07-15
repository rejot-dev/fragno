import { redirect } from "react-router";

import type { Route } from "./+types/durable-hooks-organisation-redirect";
import {
  type DurableHooksOrgFragment,
  isDurableHookOrgFragment,
} from "./durable-hooks-organisation-state";

const DEFAULT_FRAGMENT: DurableHooksOrgFragment = "api";

export async function loader({ params, url }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const requestedFragment = url.searchParams.get("fragment");
  const fragment =
    requestedFragment === "workflows"
      ? "automations"
      : requestedFragment && isDurableHookOrgFragment(requestedFragment)
        ? requestedFragment
        : DEFAULT_FRAGMENT;

  return redirect(`/backoffice/internals/durable-hooks/${params.orgId}/${fragment}`);
}

export default function BackofficeDurableHooksOrganisationRedirect() {
  return null;
}
