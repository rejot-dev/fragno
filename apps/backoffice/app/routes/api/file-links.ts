import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const FILE_LINK_ROUTE_PREFIX = "/api/upload/file-links/";

/**
 * Unauthenticated proxy for Upload file links: each link's signature is its authority, so this
 * route only selects the scoped Upload object and never reaches routes outside `/file-links`.
 */
async function forwardFileLink({ request, context, params }: LoaderFunctionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  if (scope.kind === "system" || !params.provider || !params["*"]) {
    throw new Response("File link not found.", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "PUT") {
    throw new Response("File links accept GET and PUT.", { status: 405 });
  }

  const url = new URL(`${FILE_LINK_ROUTE_PREFIX}${params["*"]}`, request.url);
  if (!url.pathname.startsWith(FILE_LINK_ROUTE_PREFIX)) {
    throw new Response("File link not found.", { status: 404 });
  }
  url.search = new URL(request.url).search;
  url.searchParams.set("provider", params.provider);

  // Clients such as `curl -T` send no content type, and link requests carry no credentials.
  const headers = new Headers();
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    headers.set("content-length", contentLength);
  }
  if (request.method === "PUT") {
    headers.set("content-type", "application/octet-stream");
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const uploadObject = kernel.scoped("UPLOAD", scope, runtime.objects.upload);
  return await uploadObject.http.fetch(new Request(new Request(url, request), { headers }));
}

export async function loader(args: LoaderFunctionArgs) {
  return await forwardFileLink(args);
}

export async function action(args: ActionFunctionArgs) {
  return await forwardFileLink(args);
}
