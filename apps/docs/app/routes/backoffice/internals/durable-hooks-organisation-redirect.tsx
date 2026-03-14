import { redirect } from "react-router";
import type { Route } from "./+types/durable-hooks-organisation-redirect";
import {
  DURABLE_HOOK_ORG_FRAGMENTS,
  type DurableHooksOrgFragment,
} from "./durable-hooks-organisation-state";

const DEFAULT_FRAGMENT: DurableHooksOrgFragment = "pi";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const requestedFragment = url.searchParams.get("fragment");
  const fragment = DURABLE_HOOK_ORG_FRAGMENTS.includes(requestedFragment as DurableHooksOrgFragment)
    ? (requestedFragment as DurableHooksOrgFragment)
    : DEFAULT_FRAGMENT;

  return redirect(`/backoffice/internals/durable-hooks/${params.orgId}/${fragment}`);
}

export default function BackofficeDurableHooksOrganisationRedirect() {
  return null;
}
