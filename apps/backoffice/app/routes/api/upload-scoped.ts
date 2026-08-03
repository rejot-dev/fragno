import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { automationScopeFromRouteParams } from "@/routes/backoffice/automations/scope";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const forwardToScopedUpload = async (
  request: Request,
  context: LoaderFunctionArgs["context"],
  params: LoaderFunctionArgs["params"],
) => {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const { runtime } = context.get(BackofficeWorkerContext);
  const uploadObject = new BackofficeKernel({ objects: runtime.objects }).scoped(
    "UPLOAD",
    scope,
    runtime.objects.upload,
  );
  const url = new URL(request.url);
  const suffix = params["*"] ? `/${params["*"]}` : "";
  url.pathname = `/api/upload${suffix}`;

  return uploadObject.fetch(new Request(url, request));
};

/** Authenticated browser proxy for system, organisation, project, and user Upload objects. */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  return forwardToScopedUpload(request, context, params);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  return forwardToScopedUpload(request, context, params);
}
