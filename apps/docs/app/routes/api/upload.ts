import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getUploadDurableObject } from "@/cloudflare/cloudflare-utils";

const forwardToUpload = async (
  request: Request,
  context: LoaderFunctionArgs["context"],
  orgId: string | undefined,
) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  const uploadDo = getUploadDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `/api/upload/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `/api/upload${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  return uploadDo.fetch(proxyRequest);
};

/**
 * Catch-all route that forwards all /api/upload/:orgId/* requests to the Upload Durable Object.
 * The org-specific prefix is stripped before the request reaches the fragment.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return forwardToUpload(request, context, params.orgId);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  return forwardToUpload(request, context, params.orgId);
}
