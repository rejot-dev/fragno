import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import {
  buildCloudflareWorkerDispatchRequest,
  isCloudflareWorkerDispatchEnabled,
  resolveCloudflareWorkerScriptName,
} from "@/cloudflare/worker-dispatch";

import type { Route } from "./+types/cloudflare-worker-proxy";

const getDispatchErrorStatus = (message: string) => {
  return /does not exist|not found|unknown worker|unknown script/i.test(message) ? 404 : 502;
};

const dispatchToCloudflareWorker = async (
  request: Request,
  context: Route.LoaderArgs["context"],
  orgId: string | undefined,
  appId: string | undefined,
) => {
  if (!isCloudflareWorkerDispatchEnabled(import.meta.env.MODE)) {
    throw new Response("Not Found", { status: 404 });
  }

  if (!orgId || !appId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { env } = context.get(CloudflareContext);
  const scriptName = resolveCloudflareWorkerScriptName(orgId, appId);
  const forwardedRequest = buildCloudflareWorkerDispatchRequest(request, orgId, appId, scriptName);

  try {
    const worker = env.DISPATCHER.get(scriptName);
    return await worker.fetch(forwardedRequest);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Failed to dispatch request to worker '${appId}'.`;

    return new Response(message, {
      status: getDispatchErrorStatus(message),
    });
  }
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return dispatchToCloudflareWorker(request, context, params.orgId, params.appId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return dispatchToCloudflareWorker(request, context, params.orgId, params.appId);
}
