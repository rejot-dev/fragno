import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getUploadDurableObject } from "@/worker-runtime/durable-objects";

import { requireApiOrganization } from "./organization.server";

const forwardToUpload = async (
  request: Request,
  context: LoaderFunctionArgs["context"],
  orgSlug: string | undefined,
) => {
  const organization = await requireApiOrganization(request, context, orgSlug);
  const orgId = organization.id;
  await requireBackofficeContext(request, context, { kind: "org", orgId });

  const uploadDo = getUploadDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/upload/${orgSlug}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/upload${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return uploadDo.fetch(proxyRequest);
};

/**
 * Authenticated catch-all route that forwards /api/upload/:orgSlug/* requests to the organization's
 * Upload Durable Object. The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return forwardToUpload(request, context, params.orgSlug);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  return forwardToUpload(request, context, params.orgSlug);
}
