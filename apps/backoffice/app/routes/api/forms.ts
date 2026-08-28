import type { LoaderFunctionArgs } from "react-router";

import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getFormsDurableObject } from "@/worker-runtime/durable-objects";

import { requiresFormsAdminAuthorization } from "./forms-api-access";

async function forwardFormsRequest(
  request: Request,
  context: LoaderFunctionArgs["context"],
): Promise<Response> {
  if (!requiresFormsAdminAuthorization(request.url)) {
    return getFormsDurableObject(context).http.fetch(request);
  }

  const authorization = await authorizeBackofficeContext(request, context, { kind: "system" });
  if (!authorization.ok) {
    return authorization.response;
  }

  const response = await getFormsDurableObject(context).http.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of authorization.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Public form reads/submissions and admin-authorized Forms management routes. */
export async function loader({ request, context }: LoaderFunctionArgs) {
  return forwardFormsRequest(request, context);
}

export async function action({ request, context }: LoaderFunctionArgs) {
  return forwardFormsRequest(request, context);
}
