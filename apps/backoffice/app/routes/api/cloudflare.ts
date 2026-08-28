import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/cloudflare";

const forwardToCloudflare = async (request: Request, context: Route.LoaderArgs["context"]) => {
  const scope = { kind: "system" as const };
  await requireBackofficeContext(request, context, scope);

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const cloudflareObject = kernel.scoped("CLOUDFLARE", scope, runtime.objects.cloudflare);
  return cloudflareObject.http.fetch(request);
};

export async function loader({ request, context }: Route.LoaderArgs) {
  return forwardToCloudflare(request, context);
}

export async function action({ request, context }: Route.ActionArgs) {
  return forwardToCloudflare(request, context);
}
