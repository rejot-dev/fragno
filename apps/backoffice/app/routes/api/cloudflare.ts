import { requireBackofficePrincipal } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/cloudflare";

const forwardToCloudflare = async (request: Request, context: Route.LoaderArgs["context"]) => {
  const principal = await requireBackofficePrincipal(request, context);
  if (principal.type !== "user" || principal.role !== "admin") {
    return new Response("Not Found", { status: 404 });
  }

  const cloudflareObject = context
    .get(BackofficeWorkerContext)
    .runtime.objects.cloudflare.singleton();

  return cloudflareObject.fetch(request);
};

export async function loader({ request, context }: Route.LoaderArgs) {
  return forwardToCloudflare(request, context);
}

export async function action({ request, context }: Route.ActionArgs) {
  return forwardToCloudflare(request, context);
}
