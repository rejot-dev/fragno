import type { LoaderFunctionArgs } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getReson8DurableObject } from "@/worker-runtime/durable-objects";

import { requireApiOrganization } from "./organization.server";

const forwardToReson8 = async (
  request: Request,
  context: LoaderFunctionArgs["context"],
  orgSlug: string | undefined,
) => {
  const organization = await requireApiOrganization(request, context, orgSlug);
  const orgId = organization.id;

  const reson8Do = getReson8DurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/reson8/${orgSlug}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/reson8${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return reson8Do.http.fetchAuthorized(proxyRequest, {
    execution: await requireBackofficeContext(request, context, { kind: "org", orgId }),
  });
};

/**
 * Catch-all route that forwards all /api/reson8/:orgSlug/* requests to the Reson8 Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return forwardToReson8(request, context, params.orgSlug);
}

export async function action({ request, context, params }: LoaderFunctionArgs) {
  return forwardToReson8(request, context, params.orgSlug);
}
